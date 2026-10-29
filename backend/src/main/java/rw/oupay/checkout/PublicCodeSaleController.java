package rw.oupay.checkout;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Anonymous and read-only: the customer page of a code sale. Never cached, so a status is never served stale from a shared cache. */
@RestController
@RequestMapping("/api/v1/public/code-sales")
public class PublicCodeSaleController {

    private final PublicCodeSaleService service;

    public PublicCodeSaleController(PublicCodeSaleService service) {
        this.service = service;
    }

    @GetMapping("/{reference}")
    ResponseEntity<CodeCheckoutDtos.PublicCodeSale> sale(@PathVariable String reference) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(service.sale(reference));
    }
}
