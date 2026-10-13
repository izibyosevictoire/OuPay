package rw.oupay.invoice;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/invoices")
public class InvoiceController {

    private final InvoiceService service;

    public InvoiceController(InvoiceService service) {
        this.service = service;
    }

    @GetMapping
    InvoiceDtos.InvoicePage list(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                 @RequestParam(required = false) String cursor) {
        return service.list(merchantId, limit, cursor);
    }

    @GetMapping("/form-options")
    InvoiceDtos.FormOptions formOptions(@PathVariable UUID merchantId) {
        return service.formOptions(merchantId);
    }

    @GetMapping("/{invoiceId}")
    InvoiceDtos.InvoiceDto get(@PathVariable UUID merchantId, @PathVariable UUID invoiceId) {
        return service.get(merchantId, invoiceId);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    InvoiceDtos.InvoiceDto create(@PathVariable UUID merchantId, @Valid @RequestBody InvoiceDtos.DraftRequest request) {
        return service.createDraft(merchantId, request);
    }

    @PutMapping("/{invoiceId}")
    InvoiceDtos.InvoiceDto update(@PathVariable UUID merchantId, @PathVariable UUID invoiceId,
                                  @RequestParam long expectedVersion, @Valid @RequestBody InvoiceDtos.DraftRequest request) {
        return service.updateDraft(merchantId, invoiceId, request, expectedVersion);
    }

    @PostMapping("/{invoiceId}/issue")
    InvoiceDtos.InvoiceDto issue(@PathVariable UUID merchantId, @PathVariable UUID invoiceId, @RequestParam long expectedVersion) {
        return service.issue(merchantId, invoiceId, expectedVersion);
    }

    @PostMapping("/{invoiceId}/cancel")
    InvoiceDtos.InvoiceDto cancel(@PathVariable UUID merchantId, @PathVariable UUID invoiceId, @RequestParam long expectedVersion) {
        return service.cancelDraft(merchantId, invoiceId, expectedVersion);
    }

    @PostMapping("/{invoiceId}/void")
    InvoiceDtos.InvoiceDto voidInvoice(@PathVariable UUID merchantId, @PathVariable UUID invoiceId,
                                       @RequestParam long expectedVersion, @Valid @RequestBody InvoiceDtos.VoidRequest request) {
        return service.voidInvoice(merchantId, invoiceId, request.reason(), expectedVersion);
    }
}
