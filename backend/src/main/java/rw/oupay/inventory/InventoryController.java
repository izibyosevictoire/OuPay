package rw.oupay.inventory;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.common.Pagination;

/**
 * The merchant comes only from the URL and is authorised by the service. A write answers 201 when it recorded the operation and 200
 * with {@code replayed: true} when the same operation (same client id, same request) had already been recorded.
 */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/inventory")
public class InventoryController {

    private final InventoryService service;

    public InventoryController(InventoryService service) {
        this.service = service;
    }

    @GetMapping("/options")
    InventoryDtos.Options options(@PathVariable UUID merchantId) {
        return service.options(merchantId);
    }

    @GetMapping("/balances")
    Pagination.Page<InventoryDtos.BalanceDto> balances(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                                       @RequestParam(required = false) String cursor,
                                                       @RequestParam(required = false) UUID branchId,
                                                       @RequestParam(required = false) UUID itemId,
                                                       @RequestParam(required = false) String q) {
        return service.balances(merchantId, limit, cursor, branchId, itemId, q);
    }

    @GetMapping("/movements")
    Pagination.Page<InventoryDtos.MovementDto> movements(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                                         @RequestParam(required = false) String cursor,
                                                         @RequestParam(required = false) UUID branchId,
                                                         @RequestParam(required = false) UUID itemId,
                                                         @RequestParam(required = false) MovementType type) {
        return service.movements(merchantId, limit, cursor, branchId, itemId, type);
    }

    @PostMapping("/opening")
    ResponseEntity<InventoryDtos.MovementResult> opening(@PathVariable UUID merchantId,
                                                         @Valid @RequestBody InventoryDtos.OpeningRequest request) {
        return respond(service.recordOpening(merchantId, request));
    }

    @PostMapping("/receive")
    ResponseEntity<InventoryDtos.MovementResult> receive(@PathVariable UUID merchantId,
                                                         @Valid @RequestBody InventoryDtos.ReceiveRequest request) {
        return respond(service.receive(merchantId, request));
    }

    @PostMapping("/adjust")
    ResponseEntity<InventoryDtos.MovementResult> adjust(@PathVariable UUID merchantId,
                                                        @Valid @RequestBody InventoryDtos.AdjustRequest request) {
        return respond(service.adjust(merchantId, request));
    }

    private static ResponseEntity<InventoryDtos.MovementResult> respond(InventoryService.Outcome outcome) {
        return ResponseEntity.status(outcome.created() ? HttpStatus.CREATED : HttpStatus.OK).body(outcome.result());
    }
}
