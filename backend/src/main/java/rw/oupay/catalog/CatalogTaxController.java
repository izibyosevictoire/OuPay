package rw.oupay.catalog;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The tax classification of a catalog item. The merchant comes from the URL and is authorised by the service. */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/catalog/items/{itemId}/tax")
public class CatalogTaxController {

    private final CatalogTaxService service;

    public CatalogTaxController(CatalogTaxService service) {
        this.service = service;
    }

    @GetMapping
    CatalogTaxService.TaxView get(@PathVariable UUID merchantId, @PathVariable UUID itemId) {
        return service.get(merchantId, itemId);
    }

    @PutMapping
    CatalogTaxService.TaxView set(@PathVariable UUID merchantId, @PathVariable UUID itemId, @Valid @RequestBody CatalogTaxService.SetTaxRequest request) {
        return service.set(merchantId, itemId, request);
    }
}
