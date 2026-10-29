package rw.oupay.pos;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.catalog.CatalogItemType;
import rw.oupay.checkout.CodeCheckoutDtos;
import rw.oupay.checkout.CodeCheckoutService;
import rw.oupay.checkout.SimplifiedCheckoutService;
import rw.oupay.common.ApiException;
import rw.oupay.idempotency.IdempotencyService;
import rw.oupay.invoice.InvoiceCalculator;
import rw.oupay.invoice.InvoiceDtos;
import rw.oupay.invoice.InvoiceService;
import rw.oupay.measurement.MeasurementDimension;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.payment.PaymentRequestState;
import rw.oupay.reservation.StockReservationService;

/**
 * BILL a POS draft (R7b): ONE atomic operation that turns a reviewed cart into an issued invoice, a fixed-amount payment request through
 * the cashier's collection code, immutable catalog/price/tax snapshots, and a branch-scoped stock RESERVATION. It composes the existing
 * invoice, payment-request, code-sale, idempotency and inventory machinery; there is no second ledger, and nothing here marks anything
 * paid or moves physical stock (fulfilment is R7c).
 *
 * <h2>Transaction ownership and lock order</h2>
 * {@link IdempotencyService#executeOnce} owns the single transaction (it refuses to run inside one). Inside it, ALWAYS in this order:
 * <ol>
 *   <li>the idempotency claim (R2);</li>
 *   <li>the POS draft row ({@code FOR UPDATE}): two bills, or a bill and an edit, of one draft take turns;</li>
 *   <li>the stock balance rows of every goods item in the cart, in ASCENDING item id ({@code FOR UPDATE}): the same lock every R5c stock
 *       movement takes, so a reservation and a stock adjustment can never both succeed against the same remaining stock, and two overlapping
 *       carts can not deadlock;</li>
 *   <li>the invoice number sequence and the new invoice (existing invoice engine), then the invoice lock the payment-request and bank-event
 *       paths already use.</li>
 * </ol>
 * Bank-event and reconciliation transactions never touch inventory balances or reservations, and inventory movements never touch drafts or
 * invoices, so no cycle exists.
 *
 * <h2>Idempotency, three layers</h2>
 * The HTTP key (R2) replays the stored answer; the durable identity (one {@code pos_sales} row per draft, and the invoice's R3
 * client-request identity, which is the draft's own identity) makes a retry after the HTTP record is gone return the SAME sale; the database
 * (unique draft, invoice and reservation) refuses a second one whatever the application does. Every replay re-checks who is asking.
 *
 * <h2>Reservations</h2>
 * Goods are reserved when the bill succeeds, in canonical units, exactly. A DEMONSTRATION sale reserves NOTHING (no payment can ever fulfil
 * or release it), and says so. There is no automatic release: see {@link #release}.
 */
@Service
public class PosBillingService {

    private static final String SCOPE = "POS_BILL";
    private static final int MAX_INVOICE_LINES = 50;

    /** One cart line, re-priced now and fully computed. */
    private record Built(PosDtos.PricedLine priced, long draftUnitPrice, int draftPriceVersion, String taxCategory, Integer taxRateBp,
                         boolean taxApproved, InvoiceCalculator.Line money, PosBillingDtos.Availability availability) {}

    private record Review(PosService.DraftRow row, PosDtos.BranchChoice branch, List<Built> lines, List<PosBillingDtos.Problem> problems, long subtotal, long tax,
                          long total, CodeCheckoutService.PreparedSale prepared, String mode, String codeLabel, String modeNote) {}

    private record Item(UUID id, String type, int version, String taxCategory, Integer taxRateBp) {}

    private record DraftLine(UUID itemId, String enteredQuantity, String enteredUnit, UUID packageId, int priceVersion, long unitPrice) {}

    private final JdbcClient jdbc;
    private final IdempotencyService idempotency;
    private final PosService drafts;
    private final CodeCheckoutService codeCheckout;
    private final StockReservationService reservations;
    private final PosFulfilmentService fulfilments;
    private final PosTaxPolicy taxPolicy;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;
    private final Duration reviewGrace;

    public PosBillingService(JdbcClient jdbc, IdempotencyService idempotency, PosService drafts, CodeCheckoutService codeCheckout,
                             StockReservationService reservations, PosFulfilmentService fulfilments, PosTaxPolicy taxPolicy, MerchantAccess access, AuditService audit, Clock clock,
                             @Value("${oupay.pos.reservation-review-grace:PT24H}") Duration reviewGrace) {
        this.jdbc = jdbc;
        this.idempotency = idempotency;
        this.drafts = drafts;
        this.codeCheckout = codeCheckout;
        this.reservations = reservations;
        this.fulfilments = fulfilments;
        this.taxPolicy = taxPolicy;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
        this.reviewGrace = nonNegative(reviewGrace);
    }

    // ---- the review the cashier confirms ---------------------------------------------------------------------------------------

    /** The final price, tax and availability review of an open draft, as the server sees it NOW. Changes nothing. */
    @Transactional(readOnly = true)
    public PosBillingDtos.Review preview(UUID merchantId, UUID draftId, UUID collectionCodeId) {
        Actor actor = drafts.requirePos(merchantId);
        PosService.DraftRow row = drafts.rowOf(merchantId, draftId, false);
        drafts.requireVisible(row, actor);
        if (!row.creatorId().equals(actor.userId())) {
            throw draftNotFound();
        }
        PosService.requireDraftStatus(row);
        Review review = review(merchantId, actor, row, collectionCodeId, false);
        return toDto(row, review);
    }

    // ---- billing -----------------------------------------------------------------------------------------------------------------

    /** Bills a draft. Must be called outside a transaction (the controller). */
    public PosBillingDtos.BillOutcome bill(UUID merchantId, UUID draftId, String idempotencyKey, PosBillingDtos.BillRequest request) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("expectedDraftVersion", request.expectedDraftVersion());
        body.put("reviewedTotalRwf", request.reviewedTotalRwf());
        body.put("collectionCodeId", request.collectionCodeId() == null ? null : request.collectionCodeId().toString());
        String fingerprint = idempotency.fingerprintOf(SCOPE, Map.of("merchantId", merchantId.toString(), "draftId", draftId.toString()), body);
        return idempotency.executeOnce(merchantId, SCOPE, idempotencyKey, fingerprint, () -> billNow(merchantId, draftId, request),
                stored -> replay(merchantId, stored.entityId())).response();
    }

    private IdempotencyService.Created<PosBillingDtos.BillOutcome> billNow(UUID merchantId, UUID draftId, PosBillingDtos.BillRequest request) {
        // 1. Who is asking, and the draft (row lock). Only the person who prepared a draft may bill it.
        Actor actor = drafts.requirePos(merchantId);
        PosService.DraftRow row = drafts.lockOwn(merchantId, draftId, actor);

        // 2. Is this a repeat? Answered from the DURABLE sale of this draft, before anything about today is looked at.
        Optional<UUID> existing = jdbc.sql("select payment_request_id from pos_sales where draft_id = :d and merchant_id = :m").param("d", draftId)
                .param("m", merchantId).query(UUID.class).optional();
        if (existing.isPresent()) {
            requireSameBill(merchantId, existing.get(), request);
            return new IdempotencyService.Created<>(new PosBillingDtos.BillOutcome(assemble(merchantId, codeCheckout.saleView(merchantId, existing.get())), false),
                    "pos_sale", existing.get());
        }

        // 3. A new bill: only an open draft, at the version the cashier reviewed.
        PosService.requireDraftStatus(row);
        PosService.assertVersion(row, request.expectedDraftVersion());

        // 4. Everything is re-read NOW: branch and cashier, catalog price, tax, quantities, stock (balances locked in ascending order).
        Review review = review(merchantId, actor, row, request.collectionCodeId(), true);
        if (review.prepared() == null) {
            PosBillingDtos.Problem blocking = review.problems().stream().filter(p -> p.lineNo() == 0).findFirst().orElse(review.problems().get(0));
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, blocking.code(), blocking.message());
        }
        if (!review.problems().isEmpty()) {
            PosBillingDtos.Problem first = review.problems().get(0);
            HttpStatus status = "insufficient_stock".equals(first.code()) ? HttpStatus.CONFLICT : HttpStatus.UNPROCESSABLE_CONTENT;
            throw new ApiException(status, first.code(), (first.lineNo() > 0 ? "Line " + first.lineNo() + ": " : "") + first.message());
        }
        if (review.total() != request.reviewedTotalRwf()) {
            throw ApiException.conflict("review_changed", "The price, tax or total changed since you reviewed it (now RWF " + review.total()
                    + "). Review the bill again before you continue.");
        }
        if (review.total() < SimplifiedCheckoutService.MIN_AMOUNT_RWF || review.total() > SimplifiedCheckoutService.MAX_AMOUNT_RWF) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "amount_out_of_range", "A bill must be between RWF " + SimplifiedCheckoutService.MIN_AMOUNT_RWF
                    + " and RWF " + SimplifiedCheckoutService.MAX_AMOUNT_RWF + ".");
        }
        if (review.lines().size() > MAX_INVOICE_LINES) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "too_many_lines", "A bill can have at most " + MAX_INVOICE_LINES + " lines.");
        }

        // 5. The invoice, through the existing engine, under the draft's own durable identity.
        List<InvoiceDtos.ItemInput> items = new ArrayList<>();
        for (Built b : review.lines()) {
            PosDtos.PricedLine l = b.priced();
            String description = l.itemType() == CatalogItemType.GOODS ? l.name() + " (per " + l.saleUnit() + ")" : l.name();
            items.add(new InvoiceDtos.ItemInput(description, new BigDecimal(l.quantityInSaleUnit()), l.unitPriceRwf(), 0,
                    new InvoiceDtos.TaxRate(InvoiceCalculator.TaxCategory.valueOf(b.taxCategory()), b.taxRateBp())));
        }
        UUID clientRequestId = jdbc.sql("select client_request_id from pos_drafts where id = :d and merchant_id = :m").param("d", draftId).param("m", merchantId)
                .query(UUID.class).single();
        var drafted = codeCheckout.draftSale(merchantId, actor, review.prepared(), clientRequestId, items);
        if (!drafted.created()) {
            throw ApiException.conflict("client_request_id_reuse", "This sale identifier was already used for a different sale.");
        }
        InvoiceDtos.InvoiceDto invoice = drafted.invoice();
        requireSameMoney(review, invoice);

        // 6. The immutable snapshot of every invoice line (the database checks it equals the invoice line).
        for (int i = 0; i < review.lines().size(); i++) {
            insertSnapshot(merchantId, invoice, invoice.items().get(i), i + 1, review.lines().get(i));
        }

        // 7. Issue, open the fixed-amount payment request, record the code sale (all existing code, all in this transaction).
        String description = "POS sale (" + review.lines().size() + (review.lines().size() == 1 ? " line)" : " lines)");
        CodeCheckoutService.CompletedSale done = codeCheckout.finishSale(merchantId, actor, review.prepared(), invoice, description);

        // 8. Reserve the goods (LIVE only). The balances are already locked; the database re-checks every line.
        if ("LIVE".equals(review.mode())) {
            List<StockReservationService.Line> reserved = new ArrayList<>();
            for (int i = 0; i < review.lines().size(); i++) {
                PosDtos.PricedLine l = review.lines().get(i).priced();
                if (l.itemType() == CatalogItemType.GOODS) {
                    reserved.add(new StockReservationService.Line(invoice.items().get(i).id(), l.itemId(), l.measurementDimension(), new BigDecimal(l.canonicalQuantity()),
                            l.enteredQuantity(), l.enteredUnit(), l.packageLabel()));
                }
            }
            if (!reserved.isEmpty()) {
                reservations.reserve(merchantId, review.branch().id(), invoice.id(), actor.userId(), done.request().expiresAt().plus(reviewGrace), reserved);
            }
        }

        // 9. The draft becomes BILLED (final) and the sale is linked to it, together.
        Instant now = clock.instant();
        jdbc.sql("update pos_drafts set status = 'BILLED', updated_at = :now, version = version + 1 where id = :id and merchant_id = :m and status = 'DRAFT'")
                .param("now", Timestamp.from(now)).param("id", draftId).param("m", merchantId).update();
        jdbc.sql("insert into pos_sales (payment_request_id, merchant_id, draft_id, invoice_id, branch_id, billed_by_user_id, presentation_mode, reviewed_total_rwf, "
                        + "subtotal_rwf, tax_total_rwf, total_rwf, line_count, created_at) values (:id, :m, :d, :inv, :b, :u, :mode, :total, :sub, :tax, :total, :n, :now)")
                .param("id", done.request().id()).param("m", merchantId).param("d", draftId).param("inv", invoice.id()).param("b", review.branch().id())
                .param("u", actor.userId()).param("mode", review.mode()).param("total", review.total()).param("sub", review.subtotal()).param("tax", review.tax())
                .param("n", review.lines().size()).param("now", Timestamp.from(now)).update();
        audit.record(merchantId, actor.userId(), "POS_SALE_BILLED", "invoice", invoice.id(),
                "POS sale " + invoice.invoiceNumber() + " billed for RWF " + review.total() + " (" + review.mode() + ", " + review.lines().size() + " line(s)).");
        return new IdempotencyService.Created<>(new PosBillingDtos.BillOutcome(assemble(merchantId, codeCheckout.saleView(merchantId, done.request().id())), true),
                "pos_sale", done.request().id());
    }

    /** The answer for a stored result, re-checking who is asking: only the person who prepared the draft. */
    private PosBillingDtos.BillOutcome replay(UUID merchantId, UUID saleId) {
        Actor actor = drafts.requirePos(merchantId);
        UUID creator = jdbc.sql("select d.created_by_user_id from pos_sales s join pos_drafts d on d.id = s.draft_id and d.merchant_id = s.merchant_id "
                        + "where s.payment_request_id = :id and s.merchant_id = :m").param("id", saleId).param("m", merchantId).query(UUID.class).optional()
                .orElseThrow(PosBillingService::saleNotFound);
        if (!creator.equals(actor.userId())) {
            throw saleNotFound();
        }
        return new PosBillingDtos.BillOutcome(assemble(merchantId, codeCheckout.saleView(merchantId, saleId)), false);
    }

    /** A repeat is the same bill only for the same reviewed total and (when named) the same code. */
    private void requireSameBill(UUID merchantId, UUID saleId, PosBillingDtos.BillRequest request) {
        var stored = jdbc.sql("select s.total_rwf, c.collection_code_id from pos_sales s join code_sales c on c.payment_request_id = s.payment_request_id "
                        + "where s.payment_request_id = :id and s.merchant_id = :m").param("id", saleId).param("m", merchantId)
                .query((rs, i) -> Map.entry(rs.getLong(1), rs.getObject(2, UUID.class))).single();
        boolean same = stored.getKey().longValue() == request.reviewedTotalRwf().longValue()
                && (request.collectionCodeId() == null || request.collectionCodeId().equals(stored.getValue()));
        if (!same) {
            throw ApiException.conflict("bill_conflict", "This draft was already billed, for a different total or through a different code.");
        }
    }

    // ---- reading and releasing -----------------------------------------------------------------------------------------------------

    /** One POS sale with its lines, tax and reservation, for the person who may see its invoice. */
    @Transactional(readOnly = true)
    public PosBillingDtos.BilledSale get(UUID merchantId, UUID saleId) {
        access.require(merchantId, Permission.INVOICES_VIEW);
        CodeCheckoutDtos.CodeSaleDto sale = codeCheckout.get(merchantId, saleId);
        if (jdbc.sql("select count(*) from pos_sales where payment_request_id = :id and merchant_id = :m").param("id", saleId).param("m", merchantId)
                .query(Long.class).single() == 0) {
            throw saleNotFound();
        }
        return assemble(merchantId, sale);
    }

    /**
     * Releases an ACTIVE reservation by hand. There is NO automatic release: an expired payment request does not prove that no bank payment
     * occurred, so nothing is ever released by a timer. A release needs ALL of these, and anything uncertain refuses and leaves the stock reserved:
     * the owner ({@code invoices:void}) with a written reason; the reservation's own review time has passed; the payment request is EXPIRED or
     * CANCELLED (never open); no payment has been applied to the invoice; and no non-failed bank transaction references the sale (a verified but
     * unmatched payment is evidence for reconciliation, and keeps the reservation). The invoice itself is NOT voided or changed here.
     */
    @Transactional
    public PosBillingDtos.BilledSale release(UUID merchantId, UUID saleId, PosBillingDtos.ReleaseRequest request) {
        Actor actor = access.require(merchantId, Permission.INVOICES_VOID);
        var sale = jdbc.sql("select invoice_id, branch_id from pos_sales where payment_request_id = :id and merchant_id = :m").param("id", saleId).param("m", merchantId)
                .query((rs, i) -> Map.entry(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class))).optional().orElseThrow(PosBillingService::saleNotFound);
        UUID invoiceId = sale.getKey();
        // Same order as payments: the invoice first (it serialises with any allocation), then the reservation.
        jdbc.sql("select id from invoices where id = :i and merchant_id = :m for update").param("i", invoiceId).param("m", merchantId).query(UUID.class).single();
        StockReservationService.Reservation reservation = reservations.forInvoice(merchantId, invoiceId)
                .orElseThrow(() -> ApiException.invalidState("no_reservation", "This sale has no stock reservation to release."));
        if (!"ACTIVE".equals(reservation.status())) {
            throw ApiException.conflict("reservation_not_active", "This reservation was already " + reservation.status().toLowerCase(java.util.Locale.ROOT) + ".");
        }
        if (clock.instant().isBefore(reservation.expiryReviewAt())) {
            throw ApiException.conflict("release_too_early", "This reservation can be reviewed for release only after " + reservation.expiryReviewAt() + ".");
        }
        CodeCheckoutDtos.CodeSaleDto view = codeCheckout.saleView(merchantId, saleId);
        long allocations = jdbc.sql("select count(*) from payment_allocations where invoice_id = :i").param("i", invoiceId).query(Long.class).single();
        long evidence = jdbc.sql("select count(*) from bank_transactions where merchant_id = :m and status <> 'FAILED' and (payment_request_id = :r or payment_reference = :ref)")
                .param("m", merchantId).param("r", saleId).param("ref", view.saleReference()).query(Long.class).single();
        if (allocations > 0 || evidence > 0) {
            throw ApiException.conflict("release_blocked_payment_evidence", "A bank payment may exist for this sale. It must be reconciled first, so the stock stays reserved.");
        }
        if (view.status() != PaymentRequestState.Status.EXPIRED && view.status() != PaymentRequestState.Status.CANCELLED) {
            throw ApiException.conflict("payment_request_still_open", "The payment request is still open or paid, so the stock stays reserved.");
        }
        if (!reservations.release(merchantId, reservation.id(), actor.userId(), request.reason().trim())) {
            throw ApiException.conflict("reservation_not_active", "This reservation was already released or fulfilled.");
        }
        audit.record(merchantId, actor.userId(), "POS_RESERVATION_RELEASED", "invoice", invoiceId, "Stock reservation released by hand: " + request.reason().trim());
        return assemble(merchantId, view);
    }

    /**
     * Every OPEN fulfilment exception of the business (a paid sale whose stock could not be deducted, or whose payment was reversed after the deduction),
     * for the OWNER (invoices:void, as for a release). Read-only: resolving one is a later, separately authorised workflow.
     */
    @Transactional(readOnly = true)
    public List<PosBillingDtos.FulfilmentIssue> fulfilmentExceptions(UUID merchantId) {
        access.require(merchantId, Permission.INVOICES_VOID);
        return fulfilments.exceptionsOf(merchantId, null, true);
    }

    // ---- the review ---------------------------------------------------------------------------------------------------------------

    private Review review(UUID merchantId, Actor actor, PosService.DraftRow row, UUID codeId, boolean lock) {
        List<PosBillingDtos.Problem> problems = new ArrayList<>();
        // Branch and cashier, again: assignment and branch status may have changed since the draft.
        PosDtos.BranchChoice branch = drafts.chooseBranch(merchantId, actor, row.branchId());

        List<DraftLine> saved = jdbc.sql("select item_id, entered_quantity, entered_unit, package_id, price_version, unit_price_rwf from pos_draft_lines "
                        + "where draft_id = :d order by line_no").param("d", row.id())
                .query((rs, i) -> new DraftLine(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getObject(4, UUID.class), rs.getInt(5), rs.getLong(6)))
                .list();
        Map<UUID, Item> items = new HashMap<>();
        if (!saved.isEmpty()) {
            jdbc.sql("select id, item_type, current_price_version, tax_category, tax_rate_bp from catalog_items where merchant_id = :m and id in (:ids)")
                    .param("m", merchantId).param("ids", saved.stream().map(DraftLine::itemId).distinct().toList())
                    .query((rs, i) -> new Item(rs.getObject(1, UUID.class), rs.getString(2), rs.getInt(3), rs.getString(4), (Integer) rs.getObject(5)))
                    .list().forEach(it -> items.put(it.id(), it));
        }

        // Current catalog price: the request names the CURRENT version, so what comes back is priced at today's catalog price.
        List<PosDtos.LineRequest> requests = new ArrayList<>();
        for (DraftLine l : saved) {
            Item item = items.get(l.itemId());
            requests.add(new PosDtos.LineRequest(l.itemId(), l.enteredQuantity(), l.enteredUnit(), l.packageId(), item == null ? l.priceVersion() : item.version()));
        }
        PosService.Priced priced = drafts.price(merchantId, branch.id(), requests);
        Set<Integer> failed = new HashSet<>();
        for (PosDtos.Problem p : priced.problems()) {
            failed.add(p.lineIndex());
            problems.add(new PosBillingDtos.Problem(p.lineIndex() + 1, p.code(), p.message()));
        }

        // Tax and money, per line, from the item's explicit classification.
        List<PosDtos.PricedLine> pricedLines = priced.lines();
        Map<UUID, BigDecimal> requestedPerItem = new HashMap<>();
        for (PosDtos.PricedLine l : pricedLines) {
            if (l.itemType() == CatalogItemType.GOODS) {
                requestedPerItem.merge(l.itemId(), new BigDecimal(l.canonicalQuantity()), BigDecimal::add);
            }
        }
        // Stock: LOCKED in ascending item order when billing (the check and the reservation are then atomic), read-only for a preview.
        Map<UUID, StockReservationService.Position> positions = lock ? reservations.lockAndRead(merchantId, branch.id(), requestedPerItem.keySet())
                : reservations.positions(merchantId, branch.id(), requestedPerItem.keySet());

        List<Built> built = new ArrayList<>();
        int pricedIndex = 0;
        long subtotal = 0;
        long tax = 0;
        long total = 0;
        Set<UUID> stockProblemReported = new HashSet<>();
        for (int index = 0; index < saved.size(); index++) {
            if (failed.contains(index)) {
                continue;
            }
            PosDtos.PricedLine line = pricedLines.get(pricedIndex++);
            DraftLine was = saved.get(index);
            Item item = items.get(line.itemId());
            int lineNo = index + 1;
            String category = item == null ? null : item.taxCategory();
            Integer rate = item == null ? null : item.taxRateBp();
            boolean approved = false;
            InvoiceCalculator.Line money = null;
            if (category == null) {
                problems.add(new PosBillingDtos.Problem(lineNo, "tax_not_configured", line.name() + " has no tax treatment set. Set it in the catalog before billing."));
            } else if (!taxPolicy.isApproved(InvoiceCalculator.TaxCategory.valueOf(category), rate)) {
                problems.add(new PosBillingDtos.Problem(lineNo, "tax_not_approved", line.name() + " has a tax treatment that has not been approved for billing ("
                        + new PosTaxPolicy.Treatment(InvoiceCalculator.TaxCategory.valueOf(category), rate).label() + ")."));
            } else {
                approved = true;
            }
            if (line.unitPriceRwf() <= 0) {
                problems.add(new PosBillingDtos.Problem(lineNo, "price_zero_not_billable", line.name() + " has a price of zero, which an invoice can not bill."));
            }
            if (category != null) {
                money = InvoiceCalculator.line(new InvoiceCalculator.LineInput(line.name(), InvoiceCalculator.toMilli(new BigDecimal(line.quantityInSaleUnit())),
                        line.unitPriceRwf(), 0, InvoiceCalculator.TaxCategory.valueOf(category), rate), InvoiceCalculator.TaxMode.EXCLUSIVE);
                subtotal += money.netAmount();
                tax += money.taxAmount();
                total += money.lineTotal();
            }
            PosBillingDtos.Availability availability = availabilityOf(line, positions, requestedPerItem);
            if ("INSUFFICIENT".equals(availability.state()) || "NO_STOCK_RECORD".equals(availability.state())) {
                if (stockProblemReported.add(line.itemId())) {
                    problems.add(new PosBillingDtos.Problem(lineNo, "insufficient_stock", "Not enough available stock of " + line.name() + " at this branch ("
                            + availability.available() + " available, " + availability.requested() + " needed, in " + line.canonicalUnit() + ")."));
                }
            }
            built.add(new Built(line, was.unitPrice(), was.priceVersion(), category, rate, approved, money, availability));
        }

        // The code the sale would go through (also decides whether stock is reserved: only a LIVE sale reserves).
        CodeCheckoutService.PreparedSale prepared = null;
        String mode = "UNAVAILABLE";
        String codeLabel = null;
        String modeNote;
        try {
            prepared = codeCheckout.prepareSale(merchantId, actor, codeId, branch.id());
            mode = prepared.mode();
            codeLabel = prepared.held().code().getDisplayLabel();
            modeNote = "LIVE".equals(mode) ? PosBillingDtos.RESERVATION_NOTE : PosBillingDtos.DEMO_RESERVATION_NOTE;
        } catch (ApiException e) {
            problems.add(new PosBillingDtos.Problem(0, e.code(), e.getMessage()));
            modeNote = e.getMessage();
        }
        return new Review(row, branch, built, problems, subtotal, tax, total, prepared, mode, codeLabel, modeNote);
    }

    private static PosBillingDtos.Availability availabilityOf(PosDtos.PricedLine line, Map<UUID, StockReservationService.Position> positions,
                                                              Map<UUID, BigDecimal> requestedPerItem) {
        if (line.itemType() != CatalogItemType.GOODS) {
            return new PosBillingDtos.Availability("NOT_TRACKED", null, null, null, null, line.canonicalUnit());
        }
        BigDecimal requested = requestedPerItem.get(line.itemId());
        StockReservationService.Position position = positions.get(line.itemId());
        if (position == null) {
            return new PosBillingDtos.Availability("NO_STOCK_RECORD", "0", "0", "0", PosService.plain(requested), line.canonicalUnit());
        }
        String state = position.available().compareTo(requested) >= 0 ? "SUFFICIENT" : "INSUFFICIENT";
        return new PosBillingDtos.Availability(state, PosService.plain(position.physical()), PosService.plain(position.reserved()), PosService.plain(position.available()),
                PosService.plain(requested), line.canonicalUnit());
    }

    private PosBillingDtos.Review toDto(PosService.DraftRow row, Review review) {
        List<PosBillingDtos.ReviewLine> lines = new ArrayList<>();
        int n = 0;
        for (Built b : review.lines()) {
            PosDtos.PricedLine l = b.priced();
            n++;
            boolean changed = b.draftPriceVersion() != l.priceVersion() || b.draftUnitPrice() != l.unitPriceRwf();
            lines.add(new PosBillingDtos.ReviewLine(n, l.itemId(), l.name(), l.code(), l.enteredQuantity(), l.enteredUnit(), l.packageLabel(), l.saleUnit(),
                    l.quantityInSaleUnit(), l.canonicalQuantity(), l.canonicalUnit(), l.priceVersion(), l.unitPriceRwf(), b.draftPriceVersion(), b.draftUnitPrice(), changed,
                    b.taxCategory(), b.taxRateBp(), b.taxApproved(), b.money() == null ? 0 : b.money().netAmount(), b.money() == null ? 0 : b.money().taxAmount(),
                    b.money() == null ? 0 : b.money().lineTotal(), b.availability()));
        }
        boolean billable = review.problems().isEmpty() && review.prepared() != null;
        return new PosBillingDtos.Review(row.id(), row.version(), review.branch().id(), review.branch().name(), lines, review.problems(), review.subtotal(), review.tax(),
                review.total(), billable, review.mode(), review.codeLabel(), review.modeNote(), PosDtos.STOCK_NOTE, PosDtos.TAX_NOTE, taxPolicy.approvedLabels());
    }

    // ---- invoice consistency and snapshots ---------------------------------------------------------------------------------------------

    /** The invoice engine computes its own money. It must equal what the cashier reviewed, line by line; otherwise the whole bill rolls back. */
    private static void requireSameMoney(Review review, InvoiceDtos.InvoiceDto invoice) {
        boolean same = invoice.items().size() == review.lines().size() && invoice.grandTotal() == review.total() && invoice.subtotal() == review.subtotal()
                && invoice.taxTotal() == review.tax();
        for (int i = 0; same && i < review.lines().size(); i++) {
            InvoiceCalculator.Line mine = review.lines().get(i).money();
            InvoiceDtos.ItemDto theirs = invoice.items().get(i);
            same = mine.netAmount() == theirs.netAmount() && mine.taxAmount() == theirs.taxAmount() && mine.lineTotal() == theirs.lineTotal();
        }
        if (!same) {
            throw ApiException.conflict("pricing_mismatch", "The invoice could not be priced exactly as reviewed, so nothing was billed.");
        }
    }

    private void insertSnapshot(UUID merchantId, InvoiceDtos.InvoiceDto invoice, InvoiceDtos.ItemDto item, int lineNo, Built b) {
        PosDtos.PricedLine l = b.priced();
        UUID packageId = l.packageId();
        jdbc.sql("insert into pos_sale_lines (invoice_item_id, invoice_id, merchant_id, line_no, catalog_item_id, item_type, item_name, item_code, measurement_dimension, "
                        + "entered_quantity, entered_unit, package_id, package_label, sale_unit, quantity_milli, canonical_quantity, price_version, unit_price_rwf, tax_category, "
                        + "tax_rate_bp, net_rwf, tax_rwf, line_total_rwf) values (:ii, :inv, :m, :no, :item, :type, :name, :code, :dim, :eq, :eu, :pid, :plabel, :su, :milli, :canon, "
                        + ":pv, :price, :tc, :tr, :net, :tax, :total)")
                .param("ii", item.id()).param("inv", invoice.id()).param("m", merchantId).param("no", lineNo).param("item", l.itemId()).param("type", l.itemType().name())
                .param("name", l.name()).param("code", l.code()).param("dim", l.measurementDimension()).param("eq", l.enteredQuantity()).param("eu", l.enteredUnit())
                .param("pid", packageId).param("plabel", l.packageLabel()).param("su", l.saleUnit())
                .param("milli", InvoiceCalculator.toMilli(new BigDecimal(l.quantityInSaleUnit())))
                .param("canon", new BigDecimal(l.canonicalQuantity()).setScale(6, java.math.RoundingMode.UNNECESSARY)).param("pv", l.priceVersion())
                .param("price", l.unitPriceRwf()).param("tc", b.taxCategory()).param("tr", b.taxRateBp()).param("net", b.money().netAmount())
                .param("tax", b.money().taxAmount()).param("total", b.money().lineTotal()).update();
    }

    // ---- the sale as shown ------------------------------------------------------------------------------------------------------------------

    private PosBillingDtos.BilledSale assemble(UUID merchantId, CodeCheckoutDtos.CodeSaleDto sale) {
        var head = jdbc.sql("select draft_id, presentation_mode, subtotal_rwf, tax_total_rwf, total_rwf from pos_sales where payment_request_id = :id and merchant_id = :m")
                .param("id", sale.saleId()).param("m", merchantId).query((rs, i) -> new Object[] {rs.getObject(1, UUID.class), rs.getString(2), rs.getLong(3), rs.getLong(4),
                        rs.getLong(5)}).optional().orElseThrow(PosBillingService::saleNotFound);
        List<PosBillingDtos.SaleLine> lines = jdbc.sql("select line_no, catalog_item_id, item_type, item_name, item_code, entered_quantity, entered_unit, package_label, sale_unit, "
                        + "quantity_milli, canonical_quantity, measurement_dimension, price_version, unit_price_rwf, tax_category, tax_rate_bp, net_rwf, tax_rwf, line_total_rwf "
                        + "from pos_sale_lines where invoice_id = :inv and merchant_id = :m order by line_no")
                .param("inv", sale.invoiceId()).param("m", merchantId)
                .query((rs, i) -> new PosBillingDtos.SaleLine(rs.getInt(1), rs.getObject(2, UUID.class), rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6),
                        rs.getString(7), rs.getString(8), rs.getString(9), PosService.plain(BigDecimal.valueOf(rs.getLong(10), 3)), PosService.plain(rs.getBigDecimal(11)),
                        MeasurementDimension.valueOf(rs.getString(12)).canonicalUnit().code(), rs.getInt(13), rs.getLong(14), rs.getString(15), rs.getInt(16), rs.getLong(17),
                        rs.getLong(18), rs.getLong(19))).list();
        String mode = (String) head[1];
        PosBillingDtos.ReservationView reservation = reservations.forInvoice(merchantId, sale.invoiceId()).map(r -> {
            String state = switch (r.status()) {
                case "ACTIVE" -> "RESERVED";
                default -> r.status();
            };
            List<PosBillingDtos.ReservationLine> reservedLines = r.lines().stream().map(l -> new PosBillingDtos.ReservationLine(l.itemId(), l.itemName(),
                    PosService.plain(l.quantity()), canonicalUnitOf(lines, l.itemId()), l.enteredQuantity(), l.enteredUnit(), l.packageLabel())).toList();
            return new PosBillingDtos.ReservationView(state, noteFor(r.status()), r.expiryReviewAt(), r.releasedAt(), r.releaseReason(), reservedLines);
        }).orElseGet(() -> new PosBillingDtos.ReservationView("NOT_RESERVED", "DEMONSTRATION".equals(mode) ? PosBillingDtos.DEMO_RESERVATION_NOTE
                : "This sale has no goods, so nothing is reserved.", null, null, null, List.of()));
        return new PosBillingDtos.BilledSale(sale, (UUID) head[0], mode, lines, (Long) head[2], (Long) head[3], (Long) head[4], reservation,
                PosDtos.TAX_NOTE, fulfilments.view(merchantId, sale.saleId()));
    }

    private static String canonicalUnitOf(List<PosBillingDtos.SaleLine> lines, UUID itemId) {
        return lines.stream().filter(l -> l.itemId().equals(itemId)).map(PosBillingDtos.SaleLine::canonicalUnit).findFirst().orElse("");
    }

    private static String noteFor(String status) {
        return switch (status) {
            case "ACTIVE" -> PosBillingDtos.RESERVATION_NOTE;
            case "RELEASED" -> "The reservation was released by hand. The goods are available to sell again.";
            default -> "The goods of this sale were fulfilled.";
        };
    }

    /** A negative grace would make a reservation reviewable before its payment request closes: it is treated as no grace at all. */
    private static Duration nonNegative(Duration grace) {
        return grace.isNegative() ? Duration.ZERO : grace;
    }

    private static ApiException draftNotFound() {
        return ApiException.notFound("This draft could not be found.");
    }

    private static ApiException saleNotFound() {
        return ApiException.notFound("This sale could not be found.");
    }
}
