package rw.oupay.merchant;

import java.time.Clock;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.auth.CurrentUser;
import rw.oupay.common.ApiException;
import rw.oupay.membership.Actor;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;

@Service
public class MerchantService {

    private static final java.util.Set<String> REGISTRATION_REQUIRED =
            java.util.Set.of("registered_company", "cooperative", "non_profit");

    private final MerchantRepository merchants;
    private final MembershipRepository memberships;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;

    public MerchantService(MerchantRepository merchants, MembershipRepository memberships, MerchantAccess access,
                           AuditService audit, Clock clock) {
        this.merchants = merchants;
        this.memberships = memberships;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    /** Registers a business. The result is ALWAYS pending verification, and the caller becomes its OWNER. */
    @Transactional
    public MerchantDtos.MerchantDto create(MerchantDtos.CreateRequest request) {
        UUID userId = CurrentUser.require().userId();
        String tin = blankToNull(request.registration().tin());
        String registrationNumber = blankToNull(request.registration().registrationNumber());
        if (REGISTRATION_REQUIRED.contains(request.businessType()) && registrationNumber == null) {
            throw ApiException.validation("A registration number is required for this type of business.");
        }
        if (tin != null && merchants.existsByTin(tin)) {
            throw new ApiException(HttpStatus.CONFLICT, "duplicate_tin", "A business with this TIN is already registered.");
        }
        if (registrationNumber != null && merchants.existsByRegistrationNumber(registrationNumber)) {
            throw new ApiException(HttpStatus.CONFLICT, "duplicate_registration_number",
                    "A business with this registration number is already registered.");
        }
        var now = clock.instant();
        var location = request.location();
        var contact = request.contact();
        Merchant merchant = new Merchant(UUID.randomUUID(), userId, request.legalName().trim(),
                blankToNull(request.tradingName()), request.businessType(), registrationNumber, tin,
                location.province(), location.district(), location.sector(), location.physicalAddress().trim(),
                contact.fullName().trim(), contact.email().trim().toLowerCase(java.util.Locale.ROOT), contact.phoneNumber(), now);
        try {
            merchants.saveAndFlush(merchant);
        } catch (DataIntegrityViolationException race) {
            throw new ApiException(HttpStatus.CONFLICT, "duplicate_tin", "A business with these details is already registered.");
        }
        memberships.save(new Membership(UUID.randomUUID(), userId, merchant.getId(), Role.OWNER, MembershipStatus.ACTIVE, now));
        audit.record(merchant.getId(), userId, "MERCHANT_REGISTERED", "merchant", merchant.getId(), "Business registered; pending verification.");
        return toDto(merchant, true);
    }

    @Transactional(readOnly = true)
    public List<MerchantDtos.MerchantDto> listForCurrentUser() {
        UUID userId = CurrentUser.require().userId();
        var active = memberships.findByUserId(userId).stream().filter(Membership::isActive).toList();
        var ids = active.stream().map(Membership::getMerchantId).toList();
        if (ids.isEmpty()) {
            return List.of();
        }
        var roles = new java.util.HashMap<UUID, Role>();
        active.forEach(m -> roles.put(m.getMerchantId(), m.getRole()));
        return merchants.findByIdIn(ids).stream()
                .sorted(java.util.Comparator.comparing(Merchant::getCreatedAt))
                .map(m -> toDto(m, Permission.PROFILE_VIEW.scopeFor(roles.get(m.getId())).orElse(null) == Permission.Scope.ALL))
                .toList();
    }

    @Transactional(readOnly = true)
    public MerchantDtos.MerchantDto get(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.PROFILE_VIEW);
        Merchant merchant = merchants.findById(merchantId).orElseThrow(() -> ApiException.notFound("This business could not be found."));
        return toDto(merchant, actor.hasFullScope(Permission.PROFILE_VIEW));
    }

    @Transactional
    public MerchantDtos.MerchantDto update(UUID merchantId, MerchantDtos.UpdateRequest request) {
        Actor actor = access.require(merchantId, Permission.PROFILE_EDIT);
        Merchant merchant = merchants.findById(merchantId).orElseThrow(() -> ApiException.notFound("This business could not be found."));
        if ("suspended".equals(merchant.getStatus()) || "rejected".equals(merchant.getStatus())) {
            throw new ApiException(HttpStatus.CONFLICT, "profile_locked", "This business profile can no longer be edited.");
        }
        var contact = request.contact();
        merchant.updateProfile(blankToNull(request.tradingName()), request.physicalAddress().trim(), contact.fullName().trim(),
                contact.email().trim().toLowerCase(java.util.Locale.ROOT), contact.phoneNumber(), clock.instant());
        audit.record(merchantId, actor.userId(), "MERCHANT_UPDATED", "merchant", merchantId, "Business profile updated.");
        return toDto(merchant, true);
    }

    /** Cashiers receive the limited view: no registration data and no contact details. */
    private MerchantDtos.MerchantDto toDto(Merchant m, boolean full) {
        var registration = full
                ? new MerchantDtos.Registration(m.getRegistrationNumber(), m.getTin())
                : new MerchantDtos.Registration(null, null);
        var contact = full
                ? new MerchantDtos.Contact(m.getContactFullName(), m.getContactEmail(), m.getContactPhone())
                : new MerchantDtos.Contact(m.getContactFullName(), "", "");
        return new MerchantDtos.MerchantDto(m.getId(), m.getOwnerUserId(), m.getLegalName(), m.getTradingName(),
                m.getBusinessType(), m.getStatus(), registration,
                new MerchantDtos.Location(m.getProvince(), m.getDistrict(), m.getSector(), m.getPhysicalAddress(), m.getCountry()),
                contact, new MerchantDtos.BankingConfiguration("not_configured"), m.getCreatedAt(), m.getUpdatedAt());
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
