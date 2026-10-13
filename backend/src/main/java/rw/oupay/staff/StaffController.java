package rw.oupay.staff;

import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.auth.AuthDtos;

@RestController
@RequestMapping("/api/v1")
public class StaffController {

    private final StaffService service;
    private final InvitationService invitations;

    public StaffController(StaffService service, InvitationService invitations) {
        this.service = service;
        this.invitations = invitations;
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

    // ---- Invitations ----

    @PostMapping("/merchants/{merchantId}/invitations")
    @ResponseStatus(HttpStatus.CREATED)
    StaffDtos.InvitationDto invite(@PathVariable UUID merchantId, @Valid @RequestBody StaffDtos.InviteRequest request) {
        return invitations.invite(merchantId, request);
    }

    @GetMapping("/merchants/{merchantId}/invitations")
    List<StaffDtos.InvitationDto> listInvitations(@PathVariable UUID merchantId) {
        return invitations.list(merchantId);
    }

    /** Open to anyone holding the link, and rate limited. Reveals only what an invitee needs. */
    @GetMapping("/public/invitations/{token}")
    StaffDtos.InvitationPreviewDto invitationPreview(@PathVariable String token) {
        return invitations.preview(token);
    }

    /** Signed-in users only: the invitation must have been sent to the signed-in user's own address. */
    @PostMapping("/invitations/{token}/accept")
    AuthDtos.MembershipDto accept(@PathVariable String token) {
        return invitations.accept(token);
    }
}
