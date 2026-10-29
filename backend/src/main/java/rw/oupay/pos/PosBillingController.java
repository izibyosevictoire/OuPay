package rw.oupay.pos;

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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.idempotency.IdempotencyService;

/** POS billing (R7b): the final review, the atomic bill, and the sale it makes. Nothing here accepts a price, a tax or a stock figure. */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/pos")
public class PosBillingController {

    private final PosBillingService service;

    public PosBillingController(PosBillingService service) {
        this.service = service;
    }

    /** The server's current price, tax and availability for a draft: what the cashier reviews before billing. */
    @GetMapping("/drafts/{draftId}/billing-review")
    ResponseEntity<PosBillingDtos.Review> review(@PathVariable UUID merchantId, @PathVariable UUID draftId, @RequestParam(required = false) UUID collectionCodeId) {
        return noStore(HttpStatus.OK, service.preview(merchantId, draftId, collectionCodeId));
    }

    /** 201 when this call billed the draft, 200 when it is a repeat of an earlier bill (the original sale, never a second). */
    @PostMapping("/drafts/{draftId}/bill")
    ResponseEntity<PosBillingDtos.BilledSale> bill(@PathVariable UUID merchantId, @PathVariable UUID draftId,
                                                   @RequestHeader(value = IdempotencyService.HEADER, required = false) String idempotencyKey,
                                                   @Valid @RequestBody PosBillingDtos.BillRequest request) {
        var outcome = service.bill(merchantId, draftId, idempotencyKey, request);
        return noStore(outcome.created() ? HttpStatus.CREATED : HttpStatus.OK, outcome.sale());
    }

    @GetMapping("/sales/{saleId}")
    ResponseEntity<PosBillingDtos.BilledSale> sale(@PathVariable UUID merchantId, @PathVariable UUID saleId) {
        return noStore(HttpStatus.OK, service.get(merchantId, saleId));
    }

    @PostMapping("/sales/{saleId}/release-reservation")
    ResponseEntity<PosBillingDtos.BilledSale> release(@PathVariable UUID merchantId, @PathVariable UUID saleId, @Valid @RequestBody PosBillingDtos.ReleaseRequest request) {
        return noStore(HttpStatus.OK, service.release(merchantId, saleId, request));
    }

    private static <T> ResponseEntity<T> noStore(HttpStatus status, T body) {
        return ResponseEntity.status(status).header("Cache-Control", "no-store").body(body);
    }
}
