package rw.oupay.pos;

import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.common.Pagination;
import rw.oupay.idempotency.IdempotencyService;

/** The business POS (R7a): prices a cart and saves it as a draft. Nothing here issues an invoice, takes a payment or touches stock. */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/pos")
public class PosController {

    private final PosService service;

    public PosController(PosService service) {
        this.service = service;
    }

    @GetMapping("/options")
    ResponseEntity<PosDtos.Options> options(@PathVariable UUID merchantId) {
        return noStore(service.options(merchantId));
    }

    /** A missing branch is answered by the service AFTER authorisation (a non-member must see the same 404 as for any other route). */
    @GetMapping("/items")
    ResponseEntity<List<PosDtos.CatalogItemView>> items(@PathVariable UUID merchantId, @RequestParam(required = false) UUID branchId,
                                                         @RequestParam(required = false) String q, @RequestParam(required = false) Integer limit) {
        return noStore(service.catalog(merchantId, branchId, q, limit));
    }

    @PostMapping("/quote")
    ResponseEntity<PosDtos.Quote> quote(@PathVariable UUID merchantId, @Valid @RequestBody PosDtos.QuoteRequest request) {
        return noStore(service.quote(merchantId, request));
    }

    /** 201 when this call made the draft, 200 when it is a repeat of an earlier one (the original draft, never a second). */
    @PostMapping("/drafts")
    ResponseEntity<PosDtos.Draft> create(@PathVariable UUID merchantId,
                                         @RequestHeader(value = IdempotencyService.HEADER, required = false) String idempotencyKey,
                                         @Valid @RequestBody PosDtos.DraftRequest request) {
        var saved = service.create(merchantId, idempotencyKey, request);
        return ResponseEntity.status(saved.created() ? HttpStatus.CREATED : HttpStatus.OK).header("Cache-Control", "no-store").body(saved.draft());
    }

    @GetMapping("/drafts")
    ResponseEntity<Pagination.Page<PosDtos.DraftSummary>> list(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                                                @RequestParam(required = false) String cursor) {
        return noStore(service.list(merchantId, limit, cursor));
    }

    @GetMapping("/drafts/{draftId}")
    ResponseEntity<PosDtos.Draft> get(@PathVariable UUID merchantId, @PathVariable UUID draftId) {
        return noStore(service.get(merchantId, draftId));
    }

    @PutMapping("/drafts/{draftId}")
    ResponseEntity<PosDtos.Draft> update(@PathVariable UUID merchantId, @PathVariable UUID draftId, @Valid @RequestBody PosDtos.UpdateRequest request) {
        return noStore(service.update(merchantId, draftId, request));
    }

    @DeleteMapping("/drafts/{draftId}")
    ResponseEntity<PosDtos.Draft> discard(@PathVariable UUID merchantId, @PathVariable UUID draftId, @RequestParam long expectedVersion) {
        return noStore(service.discard(merchantId, draftId, expectedVersion));
    }

    private static <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(body);
    }
}
