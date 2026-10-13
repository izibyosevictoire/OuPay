package rw.oupay.ledger;

import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Merchant-facing ledger API. Note what is NOT here: nothing creates a bank transaction, confirms a
 * payment or marks an invoice paid. Those can only come from the trusted provider boundary.
 */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}")
public class ReconciliationController {

    private final ReconciliationService service;

    public ReconciliationController(ReconciliationService service) {
        this.service = service;
    }

    @GetMapping("/bank-transactions")
    List<ReconciliationDtos.BankTransactionView> list(@PathVariable UUID merchantId) {
        return service.listTransactions(merchantId);
    }

    @GetMapping("/bank-transactions/{transactionId}")
    ReconciliationDtos.Details get(@PathVariable UUID merchantId, @PathVariable UUID transactionId) {
        return service.details(merchantId, transactionId);
    }

    @GetMapping("/payment-allocations")
    List<ReconciliationDtos.AllocationView> allocations(@PathVariable UUID merchantId) {
        return service.listAllocations(merchantId);
    }

    @GetMapping("/payable-invoices")
    List<ReconciliationDtos.PayableInvoice> payable(@PathVariable UUID merchantId) {
        return service.payableInvoices(merchantId);
    }

    @PostMapping("/reconciliation/allocations")
    ReconciliationDtos.Details allocate(@PathVariable UUID merchantId, @Valid @RequestBody ReconciliationDtos.ManualAllocationRequest request) {
        return service.allocateManually(merchantId, request);
    }

    @PostMapping("/reconciliation/allocations/{allocationId}/reverse")
    ReconciliationDtos.Details reverse(@PathVariable UUID merchantId, @PathVariable UUID allocationId,
                                       @Valid @RequestBody ReconciliationDtos.ReverseRequest request) {
        return service.reverseAllocation(merchantId, allocationId, request.reason());
    }

    @PostMapping("/bank-transactions/{transactionId}/review")
    ReconciliationDtos.Details review(@PathVariable UUID merchantId, @PathVariable UUID transactionId,
                                      @Valid @RequestBody ReconciliationDtos.ReviewRequest request) {
        return service.markReviewed(merchantId, transactionId, request.note(), request.expectedTransactionVersion());
    }
}
