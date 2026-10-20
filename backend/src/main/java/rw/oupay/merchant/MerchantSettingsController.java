package rw.oupay.merchant;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/settings")
public class MerchantSettingsController {

    private final MerchantSettingsService service;

    public MerchantSettingsController(MerchantSettingsService service) {
        this.service = service;
    }

    @GetMapping
    MerchantDtos.SettingsDto get(@PathVariable UUID merchantId) {
        return service.get(merchantId);
    }

    @PutMapping
    MerchantDtos.SettingsDto update(@PathVariable UUID merchantId, @Valid @RequestBody MerchantDtos.UpdateSettingsRequest request) {
        return service.update(merchantId, request);
    }
}
