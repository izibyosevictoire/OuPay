package rw.oupay.staff;

import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.auth.AuthDtos;
import rw.oupay.common.ApiException;

@RestController
@RequestMapping("/api/v1")
public class StaffController {

    private final StaffService service;

    public StaffController(StaffService service) {
        this.service = service;
    }

    @GetMapping("/merchants/{merchantId}/staff")
    List<StaffDtos.StaffMemberDto> list(@PathVariable UUID merchantId) {
        return service.list(merchantId);
    }

    @PutMapping("/merchants/{merchantId}/memberships/{membershipId}/role")
    AuthDtos.MembershipDto changeRole(@PathVariable UUID merchantId, @PathVariable UUID membershipId,
                                      @Valid @RequestBody StaffDtos.RoleRequest request) {
        return service.changeRole(merchantId, membershipId, request.role());
    }

    @PostMapping("/merchants/{merchantId}/memberships/{membershipId}/suspend")
    AuthDtos.MembershipDto suspend(@PathVariable UUID merchantId, @PathVariable UUID membershipId) {
        return service.suspend(merchantId, membershipId);
    }

    @PostMapping("/merchants/{merchantId}/memberships/{membershipId}/reactivate")
    AuthDtos.MembershipDto reactivate(@PathVariable UUID merchantId, @PathVariable UUID membershipId) {
        return service.reactivate(merchantId, membershipId);
    }

    @PostMapping("/merchants/{merchantId}/memberships/{membershipId}/revoke")
    AuthDtos.MembershipDto revoke(@PathVariable UUID merchantId, @PathVariable UUID membershipId) {
        return service.revoke(merchantId, membershipId);
    }

    // ---- Invitations: contract only. They need an email channel and single-use tokens, which are
    // ---- not built. The endpoints exist so the frontend contract is visible, and say so honestly.

    @PostMapping("/merchants/{merchantId}/invitations")
    void invite(@PathVariable UUID merchantId) {
        service.invitationsNotImplemented(merchantId);
    }

    @GetMapping("/merchants/{merchantId}/invitations")
    void listInvitations(@PathVariable UUID merchantId) {
        service.invitationsNotImplemented(merchantId);
    }

    @GetMapping("/public/invitations/{token}")
    void invitationPreview(@PathVariable String token) {
        throw ApiException.notImplemented("Staff invitations are not implemented yet (needs an email channel).");
    }

    @PostMapping("/invitations/{token}/accept")
    void accept(@PathVariable String token) {
        throw ApiException.notImplemented("Staff invitations are not implemented yet (needs an email channel).");
    }
}
