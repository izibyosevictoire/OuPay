package rw.oupay.dashboard;

import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.ledger.ReconciliationDtos.BankTransactionView;

@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/dashboard")
public class DashboardController {

    private final DashboardService service;

    public DashboardController(DashboardService service) {
        this.service = service;
    }

    @GetMapping("/summary")
    DashboardService.Summary summary(@PathVariable UUID merchantId) {
        return service.summary(merchantId);
    }

    @GetMapping("/recent-transactions")
    List<BankTransactionView> recent(@PathVariable UUID merchantId, @RequestParam(defaultValue = "8") int limit) {
        return service.recent(merchantId, limit);
    }

    @GetMapping("/daily-payment-activity")
    List<DashboardService.DailyActivity> daily(@PathVariable UUID merchantId) {
        return service.daily(merchantId);
    }

    @GetMapping("/provider-breakdown")
    List<DashboardService.ProviderShare> providers(@PathVariable UUID merchantId) {
        return service.providers(merchantId);
    }
}
