package rw.oupay.entry;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Anonymous and cookie-less (the {@code /api/v1/public/} surface): the page a QR code or NFC tag opens. The GET only reads. Taking the device is
 * an explicit POST, so a link pre-fetcher can never take it. Never cached, and every answer about an unusable token looks the same.
 *
 * <p>The customer session secret travels in the {@code X-Entry-Claim} header, never in the URL, so it is not recorded in access logs, browser
 * history or a shared link.
 */
@RestController
@RequestMapping("/api/v1/public/entry")
public class PublicEntryController {

    static final String CLAIM_HEADER = "X-Entry-Claim";

    private final PublicEntryService service;

    public PublicEntryController(PublicEntryService service) {
        this.service = service;
    }

    @GetMapping("/{token}")
    ResponseEntity<EntryDtos.PublicEntry> resolve(@PathVariable String token, @RequestHeader(value = CLAIM_HEADER, required = false) String claim) {
        return noStore(service.resolve(token, claim));
    }

    @PostMapping("/{token}/claim")
    ResponseEntity<EntryDtos.PublicEntry> claim(@PathVariable String token, @RequestHeader(value = CLAIM_HEADER, required = false) String claim) {
        return noStore(service.claim(token, claim));
    }

    @PostMapping("/{token}/release")
    ResponseEntity<EntryDtos.PublicEntry> release(@PathVariable String token, @RequestHeader(value = CLAIM_HEADER, required = false) String claim) {
        return noStore(service.release(token, claim));
    }

    private static ResponseEntity<EntryDtos.PublicEntry> noStore(EntryDtos.PublicEntry body) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(body);
    }
}
