package rw.oupay.payment;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Anonymous customer payment API. No cookies, no sign-in. It is rate limited per client address, its
 * inputs are strictly validated, and every response is minimal: see {@link PublicPaymentService}.
 * Responses are marked non-cacheable so a status is never served stale from a shared cache.
 */
@RestController
@RequestMapping("/api/v1/public/payment-profiles")
public class PublicPaymentController {

    private final PublicPaymentService service;

    public PublicPaymentController(PublicPaymentService service) {
        this.service = service;
    }

    @GetMapping("/{token}")
    ResponseEntity<PaymentDtos.PublicProfile> profile(@PathVariable String token) {
        return noStore(ResponseEntity.ok(), service.profile(token));
    }

    @PostMapping("/{token}/requests")
    ResponseEntity<PaymentDtos.PublicRequest> create(@PathVariable String token, @RequestBody PaymentDtos.OpenRequestBody body) {
        return noStore(ResponseEntity.status(HttpStatus.CREATED), service.createOpenRequest(token, body.amount()));
    }

    @GetMapping("/{token}/requests/{reference}")
    ResponseEntity<PaymentDtos.PublicRequest> request(@PathVariable String token, @PathVariable String reference) {
        return noStore(ResponseEntity.ok(), service.request(token, reference));
    }

    @PostMapping("/{token}/requests/{reference}/instructions-opened")
    ResponseEntity<Void> opened(@PathVariable String token, @PathVariable String reference) {
        service.markInstructionsOpened(token, reference);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{token}/requests/{reference}/claim")
    ResponseEntity<Void> claim(@PathVariable String token, @PathVariable String reference) {
        service.claimPaymentInitiated(token, reference);
        return ResponseEntity.noContent().build();
    }

    private static <T> ResponseEntity<T> noStore(ResponseEntity.BodyBuilder builder, T body) {
        return builder.header("Cache-Control", "no-store").body(body);
    }
}
