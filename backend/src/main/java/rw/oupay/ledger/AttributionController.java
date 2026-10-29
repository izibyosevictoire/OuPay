package rw.oupay.ledger;

import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.common.Pagination;

/** Authenticated and read-only. Attribution is evidence about money that already arrived: nothing here can change it. */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/bank-attributions")
public class AttributionController {

    private final AttributionService service;

    public AttributionController(AttributionService service) {
        this.service = service;
    }

    @GetMapping
    ResponseEntity<Pagination.Page<AttributionDtos.AttributionView>> list(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                                                           @RequestParam(required = false) String cursor) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(service.list(merchantId, limit, cursor));
    }

    @GetMapping("/{transactionId}")
    ResponseEntity<AttributionDtos.AttributionView> get(@PathVariable UUID merchantId, @PathVariable UUID transactionId) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(service.get(merchantId, transactionId));
    }
}
