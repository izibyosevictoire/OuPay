package rw.oupay.reports;

import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/reports")
public class ReportsController {

    private final ReportsService service;

    public ReportsController(ReportsService service) {
        this.service = service;
    }

    @GetMapping("/summary")
    ReportsService.Summary summary(
            @PathVariable UUID merchantId,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate from,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate to) {

        return service.summary(merchantId, from, to);
    }
}
