package rw.oupay.checkout;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.idempotency.IdempotencyService;

@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/checkout/simple")
public class SimplifiedCheckoutController {

    private final SimplifiedCheckoutService service;

    public SimplifiedCheckoutController(SimplifiedCheckoutService service) {
        this.service = service;
    }

    @GetMapping("/options")
    CheckoutDtos.SimpleCheckoutOptions options(@PathVariable UUID merchantId) {
        return service.options(merchantId);
    }

    /** 201 when this call created the sale, 200 when it is a repeat of an earlier one (same body, nothing new created). */
    @PostMapping
    ResponseEntity<CheckoutDtos.SimpleCheckoutResult> bill(@PathVariable UUID merchantId,
                                                           @RequestHeader(value = IdempotencyService.HEADER, required = false) String idempotencyKey,
                                                           @Valid @RequestBody CheckoutDtos.SimpleCheckoutRequest request) {
        var billed = service.bill(merchantId, idempotencyKey, request);
        return ResponseEntity.status(billed.created() ? HttpStatus.CREATED : HttpStatus.OK).body(billed.result());
    }
}
