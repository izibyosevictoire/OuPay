package rw.oupay.catalog;

import jakarta.validation.constraints.NotNull;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.invoice.InvoiceCalculator.TaxCategory;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.merchant.MerchantSettingsService;
import rw.oupay.merchant.OperatingMode;
import rw.oupay.pos.PosTaxPolicy;

/**
 * The explicit TAX CLASSIFICATION of a catalog item (R7b): the smallest configuration POS billing needs. An item has either a configured
 * treatment (one of the invoice model's categories, and for STANDARD a rate in basis points) or none. NONE is a real state and blocks
 * billing: nothing is ever defaulted to "not applicable" or guessed from an item's name.
 *
 * <p>Setting it needs {@code catalog:manage}, is audited with who and when, and is optimistic on the item's version. It does not rewrite
 * any invoice: an issued invoice keeps the tax snapshot it was billed with. Whether a configured treatment may be BILLED is the separate
 * {@link PosTaxPolicy} (approval); this class never claims tax compliance.
 */
@Service
public class CatalogTaxService {

    public record SetTaxRequest(@NotNull Long expectedVersion, @NotNull TaxCategory taxCategory, int taxRateBp) {}

    /** @param configured false when no classification has been set; {@code approvedForPos} whether POS billing may issue it. */
    public record TaxView(UUID itemId, long version, boolean configured, TaxCategory taxCategory, Integer taxRateBp, boolean approvedForPos, Instant configuredAt) {}

    private final JdbcClient jdbc;
    private final MerchantAccess access;
    private final MerchantSettingsService settings;
    private final AuditService audit;
    private final PosTaxPolicy policy;
    private final Clock clock;

    public CatalogTaxService(JdbcClient jdbc, MerchantAccess access, MerchantSettingsService settings, AuditService audit, PosTaxPolicy policy, Clock clock) {
        this.jdbc = jdbc;
        this.access = access;
        this.settings = settings;
        this.audit = audit;
        this.policy = policy;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public TaxView get(UUID merchantId, UUID itemId) {
        require(merchantId, Permission.CATALOG_VIEW);
        return view(merchantId, itemId, false);
    }

    @Transactional
    public TaxView set(UUID merchantId, UUID itemId, SetTaxRequest request) {
        Actor actor = require(merchantId, Permission.CATALOG_MANAGE);
        TaxView current = view(merchantId, itemId, true);
        if (current.version() != request.expectedVersion()) {
            throw ApiException.conflict("version_conflict", "This item was changed since you opened it. Reload it and try again.");
        }
        TaxCategory category = request.taxCategory();
        int rate = request.taxRateBp();
        boolean valid = category == TaxCategory.STANDARD ? rate >= 1 && rate <= 10_000 : rate == 0;
        if (!valid) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "invalid_tax_treatment", category == TaxCategory.STANDARD
                    ? "A standard-rated item needs a rate above 0% and at most 100%."
                    : "Only a standard-rated item has a rate.");
        }
        Instant now = clock.instant();
        jdbc.sql("update catalog_items set tax_category = :c, tax_rate_bp = :r, tax_configured_by_user_id = :u, tax_configured_at = :at, "
                        + "updated_at = :at, version = version + 1 where id = :id and merchant_id = :m")
                .param("c", category.name()).param("r", rate).param("u", actor.userId()).param("at", Timestamp.from(now)).param("id", itemId)
                .param("m", merchantId).update();
        audit.record(merchantId, actor.userId(), "CATALOG_ITEM_TAX_CONFIGURED", "catalog_item", itemId,
                "Tax treatment of an item set to " + new PosTaxPolicy.Treatment(category, rate).label() + ".");
        return view(merchantId, itemId, false);
    }

    private TaxView view(UUID merchantId, UUID itemId, boolean lock) {
        return jdbc.sql("select version, tax_category, tax_rate_bp, tax_configured_at from catalog_items where id = :id and merchant_id = :m"
                        + (lock ? " for update" : ""))
                .param("id", itemId).param("m", merchantId).query((rs, i) -> {
                    String category = rs.getString("tax_category");
                    Timestamp at = rs.getTimestamp("tax_configured_at");
                    boolean configured = category != null;
                    TaxCategory taxCategory = configured ? TaxCategory.valueOf(category) : null;
                    Integer rate = configured ? rs.getInt("tax_rate_bp") : null;
                    return new TaxView(itemId, rs.getLong("version"), configured, taxCategory, rate,
                            configured && policy.isApproved(taxCategory, rate), at == null ? null : at.toInstant());
                }).optional().orElseThrow(() -> ApiException.notFound("This item could not be found."));
    }

    private Actor require(UUID merchantId, Permission permission) {
        Actor actor = access.require(merchantId, permission);
        if (settings.operatingModeOf(merchantId) != OperatingMode.BUSINESS) {
            throw ApiException.invalidState("catalog_unavailable", "The catalog is available to businesses in business mode.");
        }
        return actor;
    }
}
