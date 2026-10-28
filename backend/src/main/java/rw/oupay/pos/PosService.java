package rw.oupay.pos;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.branch.BranchAssignment;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.catalog.CatalogItem;
import rw.oupay.catalog.CatalogItemRepository;
import rw.oupay.catalog.CatalogItemType;
import rw.oupay.catalog.CatalogPackage;
import rw.oupay.catalog.CatalogPackageRepository;
import rw.oupay.catalog.CatalogPrice;
import rw.oupay.catalog.CatalogPriceRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.Pagination;
import rw.oupay.idempotency.IdempotencyService;
import rw.oupay.inventory.InventoryBalance;
import rw.oupay.inventory.InventoryBalanceRepository;
import rw.oupay.invoice.InvoiceCalculator;
import rw.oupay.invoice.InvoiceDtos;
import rw.oupay.invoice.InvoiceService;
import rw.oupay.measurement.MeasuredQuantity;
import rw.oupay.measurement.MeasurementUnit;
import rw.oupay.measurement.PackageConversion;
import rw.oupay.measurement.QuantityPolicy;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;
import rw.oupay.merchant.MerchantSettingsService;
import rw.oupay.merchant.OperatingMode;

/**
 * THE BUSINESS POS BILLING FOUNDATION (R7a). A cashier builds a cart of goods and services from the unified catalog and saves it as a
 * POS DRAFT: a priced, auditable checkout INTENT. It is not a sale. It issues no invoice, consumes no invoice number, opens no payment
 * request, and does not reserve, deduct or move stock. R7b will, on "Bill", recheck and reserve goods and atomically issue the invoice
 * and its payment request.
 *
 * <p><b>Pricing and quantity safety.</b> Prices come from the catalog's CURRENT price version, never from the client; the request names
 * the version the cashier saw, and a different current version is refused with the new price. A quantity is exact decimal text in any
 * unit of the item's dimension (or a whole number of the item's packages). It is validated by the R5a measurement types, converted
 * EXACTLY to the item's selling unit, and must be a whole number of THOUSANDTHS of that unit (the precision of the invoice model):
 * anything finer is refused, never rounded. Money uses the invoice calculator's single rounding rule (half up, once per line). No
 * floating point anywhere.
 *
 * <p><b>Stock awareness is informational.</b> A cart shows the goods' stock at the selected branch and warns when the requested total
 * (per item, across lines) is more than is on hand. That is a statement about this moment: nothing is held, and billing rechecks.
 *
 * <p><b>Authorisation.</b> {@code invoices:create}, a BUSINESS-mode merchant, and a branch the caller is actively assigned to (the same
 * policy as every other checkout). Drafts are visible to their creator, to managers for their own branches, and to owners.
 */
@Service
public class PosService {

    private static final Pattern PLAIN_DECIMAL = Pattern.compile("[0-9]+(\\.[0-9]+)?");
    private static final String SCOPE = "POS_DRAFT";
    private static final String DRAFT_COLUMNS = "d.id, d.branch_id, b.name as branch_name, d.status, d.note, d.total_rwf, d.line_count, "
            + "d.created_by_user_id, u.full_name, d.created_at, d.updated_at, d.version";

    private record DraftRow(UUID id, UUID branchId, String branchName, String status, String note, long total, int lineCount, UUID creatorId,
                            String creatorName, Instant createdAt, Instant updatedAt, long version) {}

    /** The outcome of pricing a cart: the lines that priced, and why the others did not. */
    private record Priced(List<PosDtos.PricedLine> lines, List<PosDtos.Problem> problems, long total) {}

    private record Resolved(CatalogItem item, CatalogPrice price, MeasuredQuantity entered, MeasuredQuantity inSaleUnit, PackageConversion packageOf,
                            CatalogPackage pack) {}

    private final JdbcClient jdbc;
    private final IdempotencyService idempotency;
    private final InvoiceService invoices;
    private final CatalogItemRepository items;
    private final CatalogPriceRepository prices;
    private final CatalogPackageRepository packages;
    private final InventoryBalanceRepository balances;
    private final BranchAssignmentRepository branchAssignments;
    private final MerchantSettingsService settings;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;

    public PosService(JdbcClient jdbc, IdempotencyService idempotency, InvoiceService invoices, CatalogItemRepository items,
                      CatalogPriceRepository prices, CatalogPackageRepository packages, InventoryBalanceRepository balances,
                      BranchAssignmentRepository branchAssignments, MerchantSettingsService settings, MerchantAccess access, AuditService audit,
                      Clock clock) {
        this.jdbc = jdbc;
        this.idempotency = idempotency;
        this.invoices = invoices;
        this.items = items;
        this.prices = prices;
        this.packages = packages;
        this.balances = balances;
        this.branchAssignments = branchAssignments;
        this.settings = settings;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    // ---- reads that build a cart -------------------------------------------------------------------

    /** Whether this person can bill at a POS now, and where. A SIMPLIFIED business is told so, not shown an empty page. */
    @Transactional(readOnly = true)
    public PosDtos.Options options(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        if (settings.operatingModeOf(merchantId) != OperatingMode.BUSINESS) {
            return new PosDtos.Options(PosDtos.Readiness.NOT_BUSINESS, List.of(), PosDtos.MAX_LINES, PosDtos.STOCK_NOTE);
        }
        List<PosDtos.BranchChoice> eligible = eligibleBranches(merchantId, actor);
        return new PosDtos.Options(eligible.isEmpty() ? PosDtos.Readiness.NO_BRANCH : PosDtos.Readiness.READY, eligible, PosDtos.MAX_LINES,
                PosDtos.STOCK_NOTE);
    }

    /** Active goods and services of this business, matching the search, with their current price and the branch's stock. */
    @Transactional(readOnly = true)
    public List<PosDtos.CatalogItemView> catalog(UUID merchantId, UUID branchId, String query, Integer limit) {
        Actor actor = requirePos(merchantId);
        chooseBranch(merchantId, actor, branchId);
        int size = limit == null || limit <= 0 ? 50 : Math.min(limit, 100);
        String text = query == null ? "" : query.trim().toLowerCase(java.util.Locale.ROOT);
        String pattern = "%" + text.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
        List<CatalogItem> found = items.searchActive(merchantId, text.isEmpty(), pattern, PageRequest.of(0, size));
        Map<UUID, List<CatalogPackage>> packagesOf = found.isEmpty() ? Map.of()
                : packages.findForItems(found.stream().map(CatalogItem::getId).toList(), merchantId).stream()
                        .filter(CatalogPackage::isActive).collect(Collectors.groupingBy(CatalogPackage::getItemId));
        List<PosDtos.CatalogItemView> views = new ArrayList<>();
        for (CatalogItem item : found) {
            List<PosDtos.PackageOption> packs = packagesOf.getOrDefault(item.getId(), List.of()).stream().map(p -> packageOption(item, p)).toList();
            views.add(new PosDtos.CatalogItemView(item.getId(), item.getItemType(), item.getName(), item.getCode(), item.getMeasurementDimension().name(),
                    item.getSaleUnit().code(), Arrays.stream(MeasurementUnit.values()).filter(u -> u.dimension() == item.getMeasurementDimension())
                            .map(MeasurementUnit::code).toList(),
                    item.getPricePerSaleUnitRwf(), item.getCurrentPriceVersion(), packs, stockInfo(merchantId, branchId, item)));
        }
        return views;
    }

    /** Prices a cart without saving anything: every line priced or explained, the total, and the informational stock checks. */
    @Transactional(readOnly = true)
    public PosDtos.Quote quote(UUID merchantId, PosDtos.QuoteRequest request) {
        Actor actor = requirePos(merchantId);
        PosDtos.BranchChoice branch = chooseBranch(merchantId, actor, request.branchId());
        Priced priced = price(merchantId, branch.id(), request.lines());
        return new PosDtos.Quote(branch.id(), branch.name(), priced.lines(), priced.problems(), priced.total(), "RWF", PosDtos.STOCK_NOTE, PosDtos.TAX_NOTE);
    }

    // ---- drafts ----------------------------------------------------------------------------------------

    /**
     * Saves a cart as a draft. Must be called outside a transaction: the idempotency service owns it. The same Idempotency-Key and cart
     * replay the original draft; the same clientRequestId (the durable identity) can never create a second draft, whatever happens to any
     * HTTP replay record; a different cart under the same identifier is a conflict.
     */
    public PosDtos.Saved create(UUID merchantId, String idempotencyKey, PosDtos.DraftRequest request) {
        String fingerprint = idempotency.fingerprintOf(SCOPE, Map.of("merchantId", merchantId.toString()), request);
        var outcome = idempotency.executeOnce(merchantId, SCOPE, idempotencyKey, fingerprint, () -> createNow(merchantId, request),
                stored -> replay(merchantId, stored.entityId()));
        return outcome.response();
    }

    private IdempotencyService.Created<PosDtos.Saved> createNow(UUID merchantId, PosDtos.DraftRequest request) {
        Actor actor = requirePos(merchantId);
        PosDtos.BranchChoice branch = chooseBranch(merchantId, actor, request.branchId());
        String contentSha = idempotency.fingerprintOf(SCOPE + "_CONTENT", Map.of("merchantId", merchantId.toString()), content(request));
        // Concurrent creators of one identifier serialise here, so the later one finds the committed draft.
        jdbc.sql("select pg_advisory_xact_lock(hashtextextended(:k, 0))").param("k", "pos-draft:" + merchantId + ":" + request.clientRequestId())
                .query((rs, row) -> Boolean.TRUE).single();
        Optional<UUID> existing = jdbc.sql("select id from pos_drafts where merchant_id = :m and client_request_id = :c and request_sha256 = :h "
                        + "and created_by_user_id = :u")
                .param("m", merchantId).param("c", request.clientRequestId()).param("h", contentSha).param("u", actor.userId()).query(UUID.class).optional();
        if (existing.isPresent()) {
            return new IdempotencyService.Created<>(new PosDtos.Saved(read(merchantId, existing.get(), actor), false), "pos_draft", existing.get());
        }
        boolean taken = jdbc.sql("select count(*) from pos_drafts where merchant_id = :m and client_request_id = :c").param("m", merchantId)
                .param("c", request.clientRequestId()).query(Long.class).single() > 0;
        if (taken) {
            throw ApiException.conflict("client_request_id_reuse", "This request identifier was already used for a different cart.");
        }
        Priced priced = requirePriced(merchantId, branch.id(), request.lines());
        UUID id = UUID.randomUUID();
        Instant now = clock.instant();
        jdbc.sql("insert into pos_drafts (id, merchant_id, branch_id, created_by_user_id, status, client_request_id, request_sha256, note, total_rwf, line_count, "
                        + "created_at, updated_at, version) values (:id, :m, :b, :u, 'DRAFT', :c, :h, :note, :total, :n, :now, :now, 0)")
                .param("id", id).param("m", merchantId).param("b", branch.id()).param("u", actor.userId()).param("c", request.clientRequestId())
                .param("h", contentSha).param("note", blankToNull(request.note())).param("total", priced.total()).param("n", priced.lines().size())
                .param("now", Timestamp.from(now)).update();
        insertLines(merchantId, id, priced.lines());
        audit.record(merchantId, actor.userId(), "POS_DRAFT_CREATED", "pos_draft", id,
                "POS draft saved at " + branch.name() + ": " + priced.lines().size() + " line(s), RWF " + priced.total() + ". Not a sale.");
        return new IdempotencyService.Created<>(new PosDtos.Saved(read(merchantId, id, actor), true), "pos_draft", id);
    }

    private PosDtos.Saved replay(UUID merchantId, UUID draftId) {
        Actor actor = requirePos(merchantId);
        return new PosDtos.Saved(read(merchantId, draftId, actor), false);
    }

    /** Replaces the lines of a DRAFT as a whole, priced again from the catalog as it is now. Only the creator may. */
    @Transactional
    public PosDtos.Draft update(UUID merchantId, UUID draftId, PosDtos.UpdateRequest request) {
        Actor actor = requirePos(merchantId);
        DraftRow row = lockOwn(merchantId, draftId, actor);
        requireDraftStatus(row);
        assertVersion(row, request.expectedVersion());
        PosDtos.BranchChoice branch = chooseBranch(merchantId, actor, row.branchId());
        Priced priced = requirePriced(merchantId, branch.id(), request.lines());
        jdbc.sql("delete from pos_draft_lines where draft_id = :d").param("d", draftId).update();
        insertLines(merchantId, draftId, priced.lines());
        jdbc.sql("update pos_drafts set note = :note, total_rwf = :total, line_count = :n, updated_at = :now, version = version + 1 where id = :id")
                .param("note", blankToNull(request.note())).param("total", priced.total()).param("n", priced.lines().size())
                .param("now", Timestamp.from(clock.instant())).param("id", draftId).update();
        audit.record(merchantId, actor.userId(), "POS_DRAFT_UPDATED", "pos_draft", draftId,
                "POS draft updated: " + priced.lines().size() + " line(s), RWF " + priced.total() + ". Not a sale.");
        return read(merchantId, draftId, actor);
    }

    /** Discards a draft. It stays on record, final; nothing it described was ever sold, reserved or deducted. */
    @Transactional
    public PosDtos.Draft discard(UUID merchantId, UUID draftId, long expectedVersion) {
        Actor actor = requirePos(merchantId);
        DraftRow row = lockOwn(merchantId, draftId, actor);
        requireDraftStatus(row);
        assertVersion(row, expectedVersion);
        jdbc.sql("update pos_drafts set status = 'DISCARDED', updated_at = :now, version = version + 1 where id = :id")
                .param("now", Timestamp.from(clock.instant())).param("id", draftId).update();
        audit.record(merchantId, actor.userId(), "POS_DRAFT_DISCARDED", "pos_draft", draftId, "POS draft discarded.");
        return read(merchantId, draftId, actor);
    }

    @Transactional(readOnly = true)
    public PosDtos.Draft get(UUID merchantId, UUID draftId) {
        Actor actor = requirePos(merchantId);
        return read(merchantId, draftId, actor);
    }

    /** Drafts the caller may see, newest first: a cashier their own, a manager those of their branches, an owner all. */
    @Transactional(readOnly = true)
    public Pagination.Page<PosDtos.DraftSummary> list(UUID merchantId, Integer limit, String cursor) {
        Actor actor = requirePos(merchantId);
        int size = Pagination.limit(limit);
        var position = Pagination.decode(cursor);
        StringBuilder scope = new StringBuilder();
        Set<UUID> managed = new HashSet<>();
        if (actor.role() == Role.CASHIER) {
            scope.append(" and d.created_by_user_id = :user");
        } else if (actor.role() == Role.MANAGER) {
            managed.addAll(assignedBranches(actor));
            if (managed.isEmpty()) {
                return new Pagination.Page<>(List.of(), null, 0L);
            }
            scope.append(" and d.branch_id in (:branches)");
        }
        var spec = jdbc.sql("select " + DRAFT_COLUMNS + " from pos_drafts d join branches b on b.id = d.branch_id and b.merchant_id = d.merchant_id "
                        + "join users u on u.id = d.created_by_user_id where d.merchant_id = :m" + scope
                        + " and (d.created_at < :at or (d.created_at = :at and d.id < :id)) order by d.created_at desc, d.id desc limit :n")
                .param("m", merchantId).param("at", Timestamp.from(position.at())).param("id", position.id()).param("n", size + 1);
        if (actor.role() == Role.CASHIER) {
            spec = spec.param("user", actor.userId());
        } else if (actor.role() == Role.MANAGER) {
            spec = spec.param("branches", List.copyOf(managed));
        }
        List<DraftRow> rows = spec.query((rs, i) -> rowOf(rs)).list();
        var page = Pagination.page(rows, size, DraftRow::createdAt, DraftRow::id, null);
        return new Pagination.Page<>(page.items().stream().map(r -> new PosDtos.DraftSummary(r.id(), r.branchId(), r.branchName(), r.status(), r.lineCount(),
                r.total(), r.creatorName(), r.createdAt(), r.updatedAt(), r.version())).toList(), page.nextCursor(), null);
    }

    // ---- pricing ------------------------------------------------------------------------------------------

    private Priced requirePriced(UUID merchantId, UUID branchId, List<PosDtos.LineRequest> lines) {
        Priced priced = price(merchantId, branchId, lines);
        if (!priced.problems().isEmpty()) {
            PosDtos.Problem first = priced.problems().get(0);
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "invalid_cart", "Line " + (first.lineIndex() + 1) + ": " + first.message());
        }
        return priced;
    }

    private Priced price(UUID merchantId, UUID branchId, List<PosDtos.LineRequest> requested) {
        List<PosDtos.Problem> problems = new ArrayList<>();
        List<PosDtos.PricedLine> lines = new ArrayList<>();
        long total = 0;
        for (int index = 0; index < requested.size(); index++) {
            PosDtos.LineRequest line = requested.get(index);
            try {
                Resolved r = resolve(merchantId, line);
                PosDtos.PricedLine priced = pricedLine(lines.size() + 1, line, r);
                if (priced.lineTotalRwf() == 0 && priced.unitPriceRwf() > 0) {
                    // A priced good must not be given away by rounding: the cashier is told, and chooses a quantity that bills at least RWF 1.
                    throw new LineProblem("line_total_zero", "That quantity is worth less than RWF 1 at this price. Choose a larger quantity.");
                }
                total = Math.addExact(total, priced.lineTotalRwf());
                lines.add(priced);
            } catch (LineProblem p) {
                problems.add(new PosDtos.Problem(index, p.code, p.getMessage(), p.currentVersion, p.currentPrice));
            } catch (ArithmeticException e) {
                problems.add(new PosDtos.Problem(index, "line_total_too_large", "That quantity at this price is too large to bill.", null, null));
            }
        }
        // Informational stock, per ITEM across all lines of the cart: two lines of one good draw on the same stock.
        Map<UUID, BigDecimal> requestedPerItem = new LinkedHashMap<>();
        for (PosDtos.PricedLine line : lines) {
            if (line.itemType() == CatalogItemType.GOODS) {
                requestedPerItem.merge(line.itemId(), new BigDecimal(line.canonicalQuantity()), BigDecimal::add);
            }
        }
        List<PosDtos.PricedLine> withStock = new ArrayList<>();
        for (PosDtos.PricedLine line : lines) {
            withStock.add(withStock(line, merchantId, branchId, requestedPerItem.get(line.itemId())));
        }
        return new Priced(withStock, problems, total);
    }

    /** A line that can not be priced: the code and message are what the cashier sees. */
    private static final class LineProblem extends RuntimeException {
        private static final long serialVersionUID = 1L;
        private final String code;
        private final Integer currentVersion;
        private final Long currentPrice;

        LineProblem(String code, String message) {
            this(code, message, null, null);
        }

        LineProblem(String code, String message, Integer currentVersion, Long currentPrice) {
            super(message, null, false, false);
            this.code = code;
            this.currentVersion = currentVersion;
            this.currentPrice = currentPrice;
        }
    }

    private Resolved resolve(UUID merchantId, PosDtos.LineRequest line) {
        CatalogItem item = items.findByIdAndMerchantId(line.itemId(), merchantId)
                .orElseThrow(() -> new LineProblem("item_not_found", "That item is not in your catalog."));
        if (!item.isActive()) {
            throw new LineProblem("item_inactive", item.getName() + " is not active, so it can not be sold.");
        }
        if (line.expectedPriceVersion() != item.getCurrentPriceVersion()) {
            throw new LineProblem("price_changed", "The price of " + item.getName() + " changed. Review the new price before billing.",
                    item.getCurrentPriceVersion(), item.getPricePerSaleUnitRwf());
        }
        CatalogPrice price = prices.findByItemIdAndMerchantIdOrderByVersionDesc(item.getId(), merchantId).stream()
                .filter(p -> p.getVersion() == item.getCurrentPriceVersion()).findFirst()
                .orElseThrow(() -> new LineProblem("price_unavailable", "This item has no current price."));
        String text = line.quantity() == null ? "" : line.quantity().trim();
        if (!PLAIN_DECIMAL.matcher(text).matches()) {
            throw new LineProblem("invalid_quantity", "Enter the quantity as a positive number, for example 2 or 1.5.");
        }
        boolean hasUnit = line.unit() != null && !line.unit().isBlank();
        boolean hasPackage = line.packageId() != null;
        if (hasUnit == hasPackage) {
            throw new LineProblem("unit_or_package_required", "Choose either a unit or a package for the quantity.");
        }
        try {
            MeasuredQuantity entered;
            PackageConversion conversion = null;
            CatalogPackage pack = null;
            if (hasPackage) {
                pack = packages.findByIdAndItemIdAndMerchantId(line.packageId(), item.getId(), merchantId).filter(CatalogPackage::isActive)
                        .orElseThrow(() -> new LineProblem("package_not_found", "That package is not available for this item."));
                BigDecimal count = new BigDecimal(text);
                if (count.stripTrailingZeros().scale() > 0) {
                    throw new LineProblem("invalid_package_count", "Enter a whole number of packages.");
                }
                conversion = new PackageConversion(pack.getMeasurementDimension(), pack.getQuantityPerPackage());
                entered = conversion.toQuantity(count);
            } else {
                MeasurementUnit unit = MeasurementUnit.fromCode(line.unit());
                if (unit.dimension() != item.getMeasurementDimension()) {
                    throw new LineProblem("dimension_mismatch", "That unit does not measure " + item.getName() + ". Choose a "
                            + item.getMeasurementDimension().name().toLowerCase(java.util.Locale.ROOT) + " unit.");
                }
                entered = new MeasuredQuantity(new BigDecimal(text), unit);
            }
            QuantityPolicy.SALE_QUANTITY.require(entered);
            MeasuredQuantity inSaleUnit = entered.to(price.getSaleUnit());
            if (InvoiceCalculator.decimals(inSaleUnit.amount()) > InvoiceCalculator.MAX_QUANTITY_DECIMALS) {
                throw new LineProblem("quantity_not_representable", "A bill can not hold that quantity exactly: it must be a whole number of thousandths of one "
                        + price.getSaleUnit().code() + ". Choose a different quantity or unit.");
            }
            return new Resolved(item, price, entered, inSaleUnit, conversion, pack);
        } catch (LineProblem p) {
            throw p;
        } catch (ApiException e) {
            // The R5a measurement rules refuse it (unsupported unit, a fractional count, too many decimals...): their message is for end users.
            throw new LineProblem(e.code(), e.getMessage());
        }
    }

    private PosDtos.PricedLine pricedLine(int lineNo, PosDtos.LineRequest request, Resolved r) {
        long milli = InvoiceCalculator.toMilli(r.inSaleUnit().amount());
        // The invoice calculator's one rounding rule (half up, once per line): the same arithmetic the invoice that R7b issues will use.
        InvoiceCalculator.Line money = InvoiceCalculator.line(new InvoiceCalculator.LineInput(r.item().getName(), milli, r.price().getPricePerSaleUnitRwf(), 0,
                InvoiceCalculator.TaxCategory.NOT_APPLICABLE, 0), InvoiceCalculator.TaxMode.EXCLUSIVE);
        BigDecimal canonical = r.entered().storageValue();
        String canonicalUnit = r.item().getMeasurementDimension().canonicalUnit().code();
        boolean byPackage = r.pack() != null;
        return new PosDtos.PricedLine(lineNo, r.item().getId(), r.item().getItemType(), r.item().getName(), r.item().getCode(),
                r.item().getMeasurementDimension().name(), request.quantity().trim(), byPackage ? null : request.unit().trim().toLowerCase(java.util.Locale.ROOT),
                byPackage ? r.pack().getId() : null, byPackage ? r.pack().getLabel() : null, r.price().getSaleUnit().code(),
                plain(r.inSaleUnit().amount()), plain(canonical), canonicalUnit, r.price().getVersion(), r.price().getPricePerSaleUnitRwf(), money.lineTotal(), null);
    }

    private PosDtos.PricedLine withStock(PosDtos.PricedLine line, UUID merchantId, UUID branchId, BigDecimal requestedForItem) {
        return new PosDtos.PricedLine(line.lineNo(), line.itemId(), line.itemType(), line.name(), line.code(), line.measurementDimension(), line.enteredQuantity(),
                line.enteredUnit(), line.packageId(), line.packageLabel(), line.saleUnit(), line.quantityInSaleUnit(), line.canonicalQuantity(), line.canonicalUnit(),
                line.priceVersion(), line.unitPriceRwf(), line.lineTotalRwf(), stockCheck(merchantId, branchId, line, requestedForItem));
    }

    private PosDtos.StockCheck stockCheck(UUID merchantId, UUID branchId, PosDtos.PricedLine line, BigDecimal requestedForItem) {
        if (line.itemType() != CatalogItemType.GOODS) {
            return new PosDtos.StockCheck("NOT_TRACKED", null, null, line.canonicalUnit());
        }
        BigDecimal requested = requestedForItem == null ? new BigDecimal(line.canonicalQuantity()) : requestedForItem;
        Optional<InventoryBalance> balance = balances.findByMerchantIdAndBranchIdAndItemId(merchantId, branchId, line.itemId());
        if (balance.isEmpty()) {
            return new PosDtos.StockCheck("NO_STOCK_RECORD", "0", plain(requested), line.canonicalUnit());
        }
        BigDecimal onHand = balance.get().getQuantityOnHand();
        return new PosDtos.StockCheck(onHand.compareTo(requested) >= 0 ? "SUFFICIENT" : "INSUFFICIENT", plain(onHand), plain(requested), line.canonicalUnit());
    }

    private PosDtos.StockInfo stockInfo(UUID merchantId, UUID branchId, CatalogItem item) {
        String canonicalUnit = item.getMeasurementDimension().canonicalUnit().code();
        if (item.getItemType() != CatalogItemType.GOODS) {
            return new PosDtos.StockInfo("NOT_TRACKED", null, canonicalUnit, null);
        }
        Optional<InventoryBalance> balance = balances.findByMerchantIdAndBranchIdAndItemId(merchantId, branchId, item.getId());
        if (balance.isEmpty()) {
            return new PosDtos.StockInfo("NO_RECORD", "0", canonicalUnit, "0");
        }
        BigDecimal onHand = balance.get().getQuantityOnHand();
        return new PosDtos.StockInfo("RECORDED", plain(onHand), canonicalUnit, plain(new MeasuredQuantity(onHand, item.getMeasurementDimension().canonicalUnit()).to(item.getSaleUnit()).amount()));
    }

    private PosDtos.PackageOption packageOption(CatalogItem item, CatalogPackage pack) {
        MeasuredQuantity perPackage = new MeasuredQuantity(pack.getQuantityPerPackage(), item.getMeasurementDimension().canonicalUnit());
        return new PosDtos.PackageOption(pack.getId(), pack.getLabel(), plain(pack.getQuantityPerPackage()), perPackage.unit().code(),
                plain(perPackage.to(item.getSaleUnit()).amount()));
    }

    // ---- persistence ------------------------------------------------------------------------------------

    private void insertLines(UUID merchantId, UUID draftId, List<PosDtos.PricedLine> lines) {
        for (PosDtos.PricedLine l : lines) {
            jdbc.sql("insert into pos_draft_lines (id, draft_id, merchant_id, line_no, item_id, item_type, item_name, item_code, measurement_dimension, entered_quantity, "
                            + "entered_unit, package_id, package_label, sale_unit, quantity_milli, canonical_quantity, price_version, unit_price_rwf, line_total_rwf) "
                            + "values (:id, :d, :m, :no, :item, :type, :name, :code, :dim, :eq, :eu, :pid, :plabel, :su, :milli, :canon, :pv, :price, :total)")
                    .param("id", UUID.randomUUID()).param("d", draftId).param("m", merchantId).param("no", l.lineNo()).param("item", l.itemId())
                    .param("type", l.itemType().name()).param("name", l.name()).param("code", l.code()).param("dim", l.measurementDimension())
                    .param("eq", l.enteredQuantity()).param("eu", l.enteredUnit()).param("pid", l.packageId()).param("plabel", l.packageLabel())
                    .param("su", l.saleUnit()).param("milli", InvoiceCalculator.toMilli(new BigDecimal(l.quantityInSaleUnit())))
                    .param("canon", new BigDecimal(l.canonicalQuantity()).setScale(6, java.math.RoundingMode.UNNECESSARY)).param("pv", l.priceVersion())
                    .param("price", l.unitPriceRwf()).param("total", l.lineTotalRwf()).update();
        }
    }

    private PosDtos.Draft read(UUID merchantId, UUID draftId, Actor actor) {
        DraftRow row = rowOf(merchantId, draftId, false);
        requireVisible(row, actor);
        List<PosDtos.PricedLine> stored = jdbc.sql("select line_no, item_id, item_type, item_name, item_code, measurement_dimension, entered_quantity, entered_unit, package_id, "
                        + "package_label, sale_unit, quantity_milli, canonical_quantity, price_version, unit_price_rwf, line_total_rwf from pos_draft_lines "
                        + "where draft_id = :d order by line_no")
                .param("d", draftId).query((rs, i) -> {
                    CatalogItemType type = CatalogItemType.valueOf(rs.getString("item_type"));
                    String dimension = rs.getString("measurement_dimension");
                    String canonicalUnit = rw.oupay.measurement.MeasurementDimension.valueOf(dimension).canonicalUnit().code();
                    return new PosDtos.PricedLine(rs.getInt("line_no"), rs.getObject("item_id", UUID.class), type, rs.getString("item_name"), rs.getString("item_code"),
                            dimension, rs.getString("entered_quantity"), rs.getString("entered_unit"), rs.getObject("package_id", UUID.class), rs.getString("package_label"),
                            rs.getString("sale_unit"), plain(BigDecimal.valueOf(rs.getLong("quantity_milli"), 3)), plain(rs.getBigDecimal("canonical_quantity")),
                            canonicalUnit, rs.getInt("price_version"), rs.getLong("unit_price_rwf"), rs.getLong("line_total_rwf"), null);
                }).list();
        boolean live = "DRAFT".equals(row.status());
        Map<UUID, BigDecimal> perItem = new HashMap<>();
        for (PosDtos.PricedLine l : stored) {
            if (l.itemType() == CatalogItemType.GOODS) {
                perItem.merge(l.itemId(), new BigDecimal(l.canonicalQuantity()), BigDecimal::add);
            }
        }
        // The snapshot is what was priced; the stock beside it is what is on hand NOW (informational, and only for a live draft).
        List<PosDtos.PricedLine> lines = stored.stream().map(l -> live ? withStock(l, merchantId, row.branchId(), perItem.get(l.itemId())) : l).toList();
        return new PosDtos.Draft(row.id(), merchantId, row.branchId(), row.branchName(), row.status(), row.note(), lines, row.total(), "RWF", row.creatorName(),
                row.createdAt(), row.updatedAt(), row.version(), PosDtos.DRAFT_NOTICE, PosDtos.STOCK_NOTE, PosDtos.TAX_NOTE);
    }

    private DraftRow rowOf(UUID merchantId, UUID draftId, boolean lock) {
        return jdbc.sql("select " + DRAFT_COLUMNS + " from pos_drafts d join branches b on b.id = d.branch_id and b.merchant_id = d.merchant_id "
                        + "join users u on u.id = d.created_by_user_id where d.id = :id and d.merchant_id = :m" + (lock ? " for update of d" : ""))
                .param("id", draftId).param("m", merchantId).query((rs, i) -> rowOf(rs)).optional().orElseThrow(PosService::draftNotFound);
    }

    private static DraftRow rowOf(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new DraftRow(rs.getObject("id", UUID.class), rs.getObject("branch_id", UUID.class), rs.getString("branch_name"), rs.getString("status"), rs.getString("note"),
                rs.getLong("total_rwf"), rs.getInt("line_count"), rs.getObject("created_by_user_id", UUID.class), rs.getString("full_name"),
                rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant(), rs.getLong("version"));
    }

    // ---- rules ---------------------------------------------------------------------------------------------

    /** Authorises, then confirms the business works in BUSINESS mode: a SIMPLIFIED business keeps amount-only checkout. */
    private Actor requirePos(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        if (settings.operatingModeOf(merchantId) != OperatingMode.BUSINESS) {
            throw ApiException.invalidState("pos_unavailable", "Business POS is available to businesses in business mode.");
        }
        return actor;
    }

    private List<PosDtos.BranchChoice> eligibleBranches(UUID merchantId, Actor actor) {
        InvoiceDtos.FormOptions form = invoices.formOptions(merchantId);
        Set<UUID> assignedToMe = form.assignees().stream().filter(a -> a.userId().equals(actor.userId())).flatMap(a -> a.branchIds().stream())
                .collect(Collectors.toSet());
        return form.branches().stream().filter(b -> assignedToMe.contains(b.id())).map(b -> new PosDtos.BranchChoice(b.id(), b.name(), b.code())).toList();
    }

    private PosDtos.BranchChoice chooseBranch(UUID merchantId, Actor actor, UUID requested) {
        List<PosDtos.BranchChoice> eligible = eligibleBranches(merchantId, actor);
        if (eligible.isEmpty()) {
            throw ApiException.invalidState("no_eligible_branch", actor.role() == Role.CASHIER
                    ? "You are not assigned to an active branch yet. Ask your manager to assign you to one."
                    : "You are not assigned to an active branch. Assign yourself to one before preparing a sale.");
        }
        return eligible.stream().filter(b -> b.id().equals(requested)).findFirst().orElseThrow(
                () -> new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_not_eligible", "Choose one of the branches you are assigned to."));
    }

    private Set<UUID> assignedBranches(Actor actor) {
        return branchAssignments.findByMembershipIdAndStatus(actor.membership().getId(), "ACTIVE").stream().map(BranchAssignment::getBranchId)
                .collect(Collectors.toSet());
    }

    /** Only the person who prepared a draft may change or discard it, and only while they are still assigned to its branch. */
    private DraftRow lockOwn(UUID merchantId, UUID draftId, Actor actor) {
        DraftRow row = rowOf(merchantId, draftId, true);
        requireVisible(row, actor);
        if (!row.creatorId().equals(actor.userId())) {
            throw draftNotFound();
        }
        return row;
    }

    private void requireVisible(DraftRow row, Actor actor) {
        boolean visible = switch (actor.role()) {
            case OWNER -> true;
            case MANAGER -> assignedBranches(actor).contains(row.branchId());
            case CASHIER -> row.creatorId().equals(actor.userId());
        };
        if (!visible) {
            throw draftNotFound();
        }
    }

    private static void requireDraftStatus(DraftRow row) {
        if (!"DRAFT".equals(row.status())) {
            throw ApiException.invalidState("draft_not_open", "This draft was discarded and can not be changed.");
        }
    }

    private static void assertVersion(DraftRow row, long expected) {
        if (row.version() != expected) {
            throw ApiException.conflict("version_conflict", "This draft was changed since you opened it. Reload it and try again.");
        }
    }

    private static ApiException draftNotFound() {
        return ApiException.notFound("This draft could not be found.");
    }

    /** What makes two carts the same cart: the branch, the note and every line as requested (never the identifier or the key). */
    private static Map<String, Object> content(PosDtos.DraftRequest request) {
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("branchId", request.branchId().toString());
        content.put("note", blankToNull(request.note()));
        content.put("lines", request.lines().stream().map(l -> {
            Map<String, Object> line = new LinkedHashMap<>();
            line.put("itemId", l.itemId().toString());
            line.put("quantity", l.quantity().trim());
            line.put("unit", l.unit() == null ? null : l.unit().trim().toLowerCase(java.util.Locale.ROOT));
            line.put("packageId", l.packageId() == null ? null : l.packageId().toString());
            line.put("expectedPriceVersion", l.expectedPriceVersion());
            return line;
        }).toList());
        return content;
    }

    private static String blankToNull(String text) {
        return text == null || text.isBlank() ? null : text.trim();
    }

    private static String plain(BigDecimal value) {
        BigDecimal stripped = value.stripTrailingZeros();
        return (stripped.scale() < 0 ? stripped.setScale(0) : stripped).toPlainString();
    }
}
