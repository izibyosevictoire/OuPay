package rw.oupay.payment;

import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** Merchant-side payment links and invoice payment requests (authenticated, business-scoped). */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}")
public class PaymentController {

    private final PaymentProfileService service;

    public PaymentController(PaymentProfileService service) {
        this.service = service;
    }

    @GetMapping("/payment-profiles")
    List<PaymentDtos.ProfileDto> list(@PathVariable UUID merchantId) {
        return service.list(merchantId);
    }

    @GetMapping("/payment-profiles/form-options")
    PaymentDtos.FormOptions options(@PathVariable UUID merchantId) {
        return service.formOptions(merchantId);
    }

    @GetMapping("/payment-profiles/{profileId}")
    PaymentDtos.ProfileDto get(@PathVariable UUID merchantId, @PathVariable UUID profileId) {
        return service.get(merchantId, profileId);
    }

    @PostMapping("/payment-profiles")
    @ResponseStatus(HttpStatus.CREATED)
    PaymentDtos.ProfileDto create(@PathVariable UUID merchantId, @Valid @RequestBody PaymentDtos.CreateProfileRequest request) {
        return service.create(merchantId, request);
    }

    @PutMapping("/payment-profiles/{profileId}/active")
    PaymentDtos.ProfileDto setActive(@PathVariable UUID merchantId, @PathVariable UUID profileId, @RequestBody PaymentDtos.ActiveRequest request) {
        return service.setActive(merchantId, profileId, request.isActive());
    }

    @PostMapping("/payment-profiles/{profileId}/reissue")
    PaymentDtos.ProfileDto reissue(@PathVariable UUID merchantId, @PathVariable UUID profileId) {
        return service.reissue(merchantId, profileId);
    }

    @PostMapping("/invoices/{invoiceId}/payment-requests")
    PaymentDtos.RequestDto createInvoiceRequest(@PathVariable UUID merchantId, @PathVariable UUID invoiceId) {
        return service.createInvoiceRequest(merchantId, invoiceId);
    }

    @GetMapping("/invoices/{invoiceId}/payment-requests")
    List<PaymentDtos.RequestDto> invoiceRequests(@PathVariable UUID merchantId, @PathVariable UUID invoiceId) {
        return service.listInvoiceRequests(merchantId, invoiceId);
    }

    @PostMapping("/payment-requests/{requestId}/cancel")
    PaymentDtos.RequestDto cancel(@PathVariable UUID merchantId, @PathVariable UUID requestId) {
        return service.cancelRequest(merchantId, requestId);
    }

}
