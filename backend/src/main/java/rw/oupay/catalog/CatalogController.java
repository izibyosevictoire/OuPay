package rw.oupay.catalog;

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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.common.Pagination;

/** The merchant always comes from the URL and is authorised by the service; no body field names a merchant. */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/catalog")
public class CatalogController {

    private final CatalogService service;

    public CatalogController(CatalogService service) {
        this.service = service;
    }

    @GetMapping("/measurement-units")
    List<CatalogDtos.MeasurementUnitOption> measurementUnits(@PathVariable UUID merchantId) {
        return service.measurementUnits(merchantId);
    }

    @GetMapping("/items")
    Pagination.Page<CatalogDtos.ItemDto> list(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                              @RequestParam(required = false) String cursor, @RequestParam(required = false) String q,
                                              @RequestParam(required = false) CatalogItemType type,
                                              @RequestParam(required = false) Boolean active) {
        return service.list(merchantId, limit, cursor, q, type, active);
    }

    @PostMapping("/items")
    @ResponseStatus(HttpStatus.CREATED)
    CatalogDtos.ItemDto create(@PathVariable UUID merchantId, @Valid @RequestBody CatalogDtos.CreateItemRequest request) {
        return service.create(merchantId, request);
    }

    @GetMapping("/items/{itemId}")
    CatalogDtos.ItemDto get(@PathVariable UUID merchantId, @PathVariable UUID itemId) {
        return service.get(merchantId, itemId);
    }

    @PutMapping("/items/{itemId}")
    CatalogDtos.ItemDto update(@PathVariable UUID merchantId, @PathVariable UUID itemId,
                               @Valid @RequestBody CatalogDtos.UpdateItemRequest request) {
        return service.update(merchantId, itemId, request);
    }

    @PutMapping("/items/{itemId}/status")
    CatalogDtos.ItemDto changeStatus(@PathVariable UUID merchantId, @PathVariable UUID itemId,
                                     @Valid @RequestBody CatalogDtos.StatusRequest request) {
        return service.changeStatus(merchantId, itemId, request);
    }

    @GetMapping("/items/{itemId}/price-history")
    List<CatalogDtos.PriceVersionDto> priceHistory(@PathVariable UUID merchantId, @PathVariable UUID itemId) {
        return service.priceHistory(merchantId, itemId);
    }

    @PostMapping("/items/{itemId}/packages")
    @ResponseStatus(HttpStatus.CREATED)
    CatalogDtos.PackageDto createPackage(@PathVariable UUID merchantId, @PathVariable UUID itemId,
                                         @Valid @RequestBody CatalogDtos.CreatePackageRequest request) {
        return service.createPackage(merchantId, itemId, request);
    }

    @PutMapping("/items/{itemId}/packages/{packageId}")
    CatalogDtos.PackageDto updatePackage(@PathVariable UUID merchantId, @PathVariable UUID itemId, @PathVariable UUID packageId,
                                         @Valid @RequestBody CatalogDtos.UpdatePackageRequest request) {
        return service.updatePackage(merchantId, itemId, packageId, request);
    }
}
