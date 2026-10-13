package rw.oupay.merchant;

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

@RestController
@RequestMapping("/api/v1/merchants")
public class MerchantController {

    private final MerchantService service;

    public MerchantController(MerchantService service) {
        this.service = service;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    MerchantDtos.MerchantDto create(@Valid @RequestBody MerchantDtos.CreateRequest request) {
        return service.create(request);
    }

    @GetMapping
    List<MerchantDtos.MerchantDto> list() {
        return service.listForCurrentUser();
    }

    @GetMapping("/{merchantId}")
    MerchantDtos.MerchantDto get(@PathVariable UUID merchantId) {
        return service.get(merchantId);
    }

    @PutMapping("/{merchantId}")
    MerchantDtos.MerchantDto update(@PathVariable UUID merchantId, @Valid @RequestBody MerchantDtos.UpdateRequest request) {
        return service.update(merchantId, request);
    }
}
