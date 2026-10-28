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
@RequestMapping("/api/v1/merchants/{merchantId}/checkout/code-sale")
public class CodeCheckoutController {

    private final CodeCheckoutService service;

    public CodeCheckoutController(CodeCheckoutService service) {
        this.service = service;
    }

    @GetMapping("/options")
    ResponseEntity<CodeCheckoutDtos.Options> options(@PathVariable UUID merchantId) {
        return noStore(service.options(merchantId));
    }

    /** 201 when this call created the sale, 200 when it is a repeat of an earlier one (the original sale, never a new one). */
    @PostMapping
    ResponseEntity<CodeCheckoutDtos.CodeSaleDto> bill(@PathVariable UUID merchantId,
                                                      @RequestHeader(value = IdempotencyService.HEADER, required = false) String idempotencyKey,
                                                      @Valid @RequestBody CodeCheckoutDtos.CodeSaleRequest request) {
        var billed = service.bill(merchantId, idempotencyKey, request);
        return ResponseEntity.status(billed.created() ? HttpStatus.CREATED : HttpStatus.OK).header("Cache-Control", "no-store").body(billed.sale());
    }

    @GetMapping("/{saleId}")
    ResponseEntity<CodeCheckoutDtos.CodeSaleDto> get(@PathVariable UUID merchantId, @PathVariable UUID saleId) {
        return noStore(service.get(merchantId, saleId));
    }

    private static <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(body);
    }
}
