package rw.oupay.banking;

import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class BankingController {

    private final BankingService service;

    public BankingController(BankingService service) {
        this.service = service;
    }

    @GetMapping("/banking/providers")
    List<BankingDtos.ProviderDto> providers() {
        return service.providers();
    }

    @GetMapping("/merchants/{merchantId}/bank-connections")
    List<BankingDtos.ConnectionDto> connections(@PathVariable UUID merchantId) {
        return service.listConnections(merchantId);
    }

    @GetMapping("/merchants/{merchantId}/payment-destinations")
    List<BankingDtos.DestinationDto> destinations(@PathVariable UUID merchantId) {
        return service.listDestinations(merchantId);
    }

    @PostMapping("/merchants/{merchantId}/bank-connections")
    BankingDtos.ConnectionDto startLink(@PathVariable UUID merchantId, @Valid @RequestBody BankingDtos.LinkRequest request) {
        return service.startLink(merchantId, request);
    }

    @PostMapping("/merchants/{merchantId}/bank-connections/{connectionId}/complete")
    BankingDtos.ConnectionDto complete(@PathVariable UUID merchantId, @PathVariable UUID connectionId) {
        return service.completeLink(merchantId, connectionId);
    }

    @PostMapping("/merchants/{merchantId}/bank-connections/{connectionId}/disable")
    BankingDtos.ConnectionDto disable(@PathVariable UUID merchantId, @PathVariable UUID connectionId) {
        return service.disable(merchantId, connectionId);
    }
}
