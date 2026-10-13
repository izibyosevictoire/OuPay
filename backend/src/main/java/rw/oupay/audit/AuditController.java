package rw.oupay.audit;

import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.common.Pagination;

/** The business's own audit trail (owners and managers). Append-only; there is no write endpoint. */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/audit-log")
public class AuditController {

    private final AuditService service;

    public AuditController(AuditService service) {
        this.service = service;
    }

    @GetMapping
    Pagination.Page<AuditService.Entry> list(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                             @RequestParam(required = false) String cursor) {
        return service.listForMerchant(merchantId, limit, cursor);
    }
}
