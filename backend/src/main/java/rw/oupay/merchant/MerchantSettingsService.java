package rw.oupay.merchant;

import java.sql.Timestamp;
import java.time.Clock;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;

/**
 * A business's settings (today: its operating mode). Reading follows profile visibility, changing follows
 * profile editing (owners only). A business without a settings row, such as one registered by an older
 * application version during a rolling deploy, is read as {@link OperatingMode#DEFAULT}.
 */
@Service
public class MerchantSettingsService {

    private final MerchantSettingsRepository settings;
    private final MerchantRepository merchants;
    private final MerchantAccess access;
    private final AuditService audit;
    private final JdbcClient jdbc;
    private final Clock clock;

    public MerchantSettingsService(MerchantSettingsRepository settings, MerchantRepository merchants, MerchantAccess access,
                                   AuditService audit, JdbcClient jdbc, Clock clock) {
        this.settings = settings;
        this.merchants = merchants;
        this.access = access;
        this.audit = audit;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public MerchantDtos.SettingsDto get(UUID merchantId) {
        access.require(merchantId, Permission.PROFILE_VIEW);
        return settings.findById(merchantId).map(MerchantSettingsService::toDto)
                .orElseGet(() -> new MerchantDtos.SettingsDto(merchantId, OperatingMode.DEFAULT, null, 0));
    }

    @Transactional
    public MerchantDtos.SettingsDto update(UUID merchantId, MerchantDtos.UpdateSettingsRequest request) {
        Actor actor = access.require(merchantId, Permission.PROFILE_EDIT);
        assertEditable(merchantId);
        MerchantSettings current = settings.findById(merchantId).orElseGet(() -> createDefault(merchantId));
        if (current.getVersion() != request.expectedVersion()) {
            throw ApiException.conflict("version_conflict", "The settings were changed by someone else. Reload them and try again.");
        }
        if (current.getOperatingMode() == request.operatingMode()) {
            return toDto(current);
        }
        OperatingMode previous = current.getOperatingMode();
        current.changeOperatingMode(request.operatingMode(), clock.instant());
        // The version check is enforced again by the database at flush, so two simultaneous changes cannot both win.
        settings.saveAndFlush(current);
        audit.record(merchantId, actor.userId(), "MERCHANT_OPERATING_MODE_CHANGED", "merchant", merchantId,
                "Operating mode changed from " + previous + " to " + request.operatingMode() + ".");
        return toDto(current);
    }

    /** For callers that have already authorised access to this business. */
    @Transactional(readOnly = true)
    public OperatingMode operatingModeOf(UUID merchantId) {
        return settings.findById(merchantId).map(MerchantSettings::getOperatingMode).orElse(OperatingMode.DEFAULT);
    }

    /** For callers that have already authorised access to these businesses. Missing rows read as the default. */
    @Transactional(readOnly = true)
    public Map<UUID, OperatingMode> operatingModesOf(Collection<UUID> merchantIds) {
        Map<UUID, OperatingMode> modes = new HashMap<>();
        merchantIds.forEach(id -> modes.put(id, OperatingMode.DEFAULT));
        settings.findAllById(merchantIds).forEach(s -> modes.put(s.getMerchantId(), s.getOperatingMode()));
        return modes;
    }

    /** Same rule as the business profile: a suspended or rejected business is not configurable. */
    private void assertEditable(UUID merchantId) {
        Merchant merchant = merchants.findById(merchantId).orElseThrow(() -> ApiException.notFound("This business could not be found."));
        if ("suspended".equals(merchant.getStatus()) || "rejected".equals(merchant.getStatus())) {
            throw new ApiException(HttpStatus.CONFLICT, "profile_locked", "This business can no longer be configured.");
        }
    }

    /**
     * Creates the default row if nobody has yet, then loads whichever row exists. The insert ignores a conflict, so two
     * simultaneous first changes never fail on a duplicate key: the loser simply reads the winner's row and is then
     * stopped by the version check.
     */
    private MerchantSettings createDefault(UUID merchantId) {
        jdbc.sql("insert into merchant_settings (merchant_id, operating_mode, updated_at, version) values (:m, :mode, :now, 0) "
                        + "on conflict (merchant_id) do nothing")
                .param("m", merchantId).param("mode", OperatingMode.DEFAULT.name()).param("now", Timestamp.from(clock.instant()))
                .update();
        return settings.findById(merchantId).orElseThrow();
    }

    private static MerchantDtos.SettingsDto toDto(MerchantSettings s) {
        return new MerchantDtos.SettingsDto(s.getMerchantId(), s.getOperatingMode(), s.getUpdatedAt(), s.getVersion());
    }
}
