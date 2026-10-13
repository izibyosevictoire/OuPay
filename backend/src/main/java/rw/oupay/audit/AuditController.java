package rw.oupay.audit;

import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The business's own audit trail (owners and managers). Append-only; there is no write endpoint. */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/audit-log")
public class AuditController {

    private final AuditService service;

    public AuditController(AuditService service) {
        this.service = service;
    }

    @GetMapping
    List<AuditService.Entry> list(@PathVariable UUID merchantId, @RequestParam(defaultValue = "50") int limit) {
        return service.listForMerchant(merchantId, limit);
    }
}
