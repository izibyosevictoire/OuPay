package rw.oupay.entry;

import jakarta.validation.Valid;
import java.util.List;
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

/**
 * The merchant is only ever the URL. A device is a doorway: there is no endpoint here that creates a bill, records a payment or marks anything
 * paid. Binding leads a device to a sale that already exists.
 */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/entry-devices")
public class EntryDeviceController {

    private final EntryDeviceService service;

    public EntryDeviceController(EntryDeviceService service) {
        this.service = service;
    }

    @GetMapping("/options")
    EntryDtos.Options options(@PathVariable UUID merchantId) {
        return service.options(merchantId);
    }

    @GetMapping
    List<EntryDtos.DeviceDto> list(@PathVariable UUID merchantId, @RequestParam(required = false) String status, @RequestParam(required = false) UUID branchId) {
        return service.list(merchantId, status, branchId);
    }

    /** 201 when this call registered the device, 200 with {@code replayed: true} when the same request had already been made. */
    @PostMapping
    ResponseEntity<EntryDtos.WriteResult> register(@PathVariable UUID merchantId, @Valid @RequestBody EntryDtos.CreateRequest request) {
        EntryDeviceService.Written written = service.register(merchantId, request);
        return ResponseEntity.status(written.created() ? HttpStatus.CREATED : HttpStatus.OK).body(new EntryDtos.WriteResult(written.device(), !written.created()));
    }

    @GetMapping("/{deviceId}")
    EntryDtos.DeviceDto get(@PathVariable UUID merchantId, @PathVariable UUID deviceId) {
        return service.get(merchantId, deviceId);
    }

    @GetMapping("/{deviceId}/assignments")
    List<EntryDtos.AssignmentDto> assignments(@PathVariable UUID merchantId, @PathVariable UUID deviceId) {
        return service.assignments(merchantId, deviceId);
    }

    @GetMapping("/{deviceId}/bindings")
    List<EntryDtos.BindingHistoryDto> bindings(@PathVariable UUID merchantId, @PathVariable UUID deviceId) {
        return service.bindings(merchantId, deviceId);
    }

    @GetMapping("/{deviceId}/eligible-sales")
    List<EntryDtos.EligibleSaleDto> eligibleSales(@PathVariable UUID merchantId, @PathVariable UUID deviceId) {
        return service.eligibleSales(merchantId, deviceId);
    }

    @PostMapping("/{deviceId}/assignment")
    EntryDtos.DeviceDto assign(@PathVariable UUID merchantId, @PathVariable UUID deviceId, @Valid @RequestBody EntryDtos.AssignRequest request) {
        return service.assign(merchantId, deviceId, request);
    }

    @PostMapping("/{deviceId}/suspend")
    EntryDtos.DeviceDto suspend(@PathVariable UUID merchantId, @PathVariable UUID deviceId, @Valid @RequestBody EntryDtos.StatusRequest request) {
        return service.suspend(merchantId, deviceId, request);
    }

    @PostMapping("/{deviceId}/reactivate")
    EntryDtos.DeviceDto reactivate(@PathVariable UUID merchantId, @PathVariable UUID deviceId, @Valid @RequestBody EntryDtos.StatusRequest request) {
        return service.reactivate(merchantId, deviceId, request);
    }

    @PostMapping("/{deviceId}/revoke")
    EntryDtos.DeviceDto revoke(@PathVariable UUID merchantId, @PathVariable UUID deviceId, @Valid @RequestBody EntryDtos.StatusRequest request) {
        return service.revoke(merchantId, deviceId, request);
    }

    @PostMapping("/{deviceId}/binding")
    EntryDtos.DeviceDto bind(@PathVariable UUID merchantId, @PathVariable UUID deviceId, @Valid @RequestBody EntryDtos.BindRequest request) {
        return service.bind(merchantId, deviceId, request);
    }

    @PostMapping("/{deviceId}/binding/end")
    EntryDtos.DeviceDto unbind(@PathVariable UUID merchantId, @PathVariable UUID deviceId, @Valid @RequestBody EntryDtos.UnbindRequest request) {
        return service.unbind(merchantId, deviceId, request);
    }
}
