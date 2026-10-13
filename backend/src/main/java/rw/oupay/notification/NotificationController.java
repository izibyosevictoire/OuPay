package rw.oupay.notification;

import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import rw.oupay.common.Pagination;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/notifications")
public class NotificationController {

    private final NotificationService service;

    public NotificationController(NotificationService service) {
        this.service = service;
    }

    @GetMapping
    Pagination.Page<NotificationService.NotificationDto> list(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                                              @RequestParam(required = false) String cursor) {
        return service.list(merchantId, limit, cursor);
    }

    @PostMapping("/{notificationId}/read")
    NotificationService.NotificationDto markRead(@PathVariable UUID merchantId, @PathVariable UUID notificationId) {
        return service.markRead(merchantId, notificationId);
    }

    @PostMapping("/read-all")
    ResponseEntity<Void> markAllRead(@PathVariable UUID merchantId) {
        service.markAllRead(merchantId);
        return ResponseEntity.noContent().build();
    }
}
