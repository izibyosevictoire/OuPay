package rw.oupay.kyc;

import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Owner-only Equity KYC onboarding. There is deliberately NO endpoint that sets a status, records evidence of a hand-off, a request from the
 * bank or a decision: see {@link KycEvidenceService}, which has no HTTP surface. Responses that can carry a protected value are never cached.
 */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/kyc")
public class KycController {

    private final KycService service;

    public KycController(KycService service) {
        this.service = service;
    }

    @GetMapping("/options")
    ResponseEntity<KycDtos.Options> options(@PathVariable UUID merchantId) {
        return noStore(service.options(merchantId));
    }

    @GetMapping("/applications")
    ResponseEntity<List<KycDtos.ApplicationSummary>> list(@PathVariable UUID merchantId) {
        return noStore(service.list(merchantId));
    }

    /** 201 when this call started the application, 200 with {@code replayed: true} when the same request had already started it. */
    @PostMapping("/applications")
    ResponseEntity<KycDtos.WriteResult> start(@PathVariable UUID merchantId, @Valid @RequestBody KycDtos.StartRequest request) {
        KycService.Written written = service.start(merchantId, request);
        return ResponseEntity.status(written.created() ? HttpStatus.CREATED : HttpStatus.OK).body(new KycDtos.WriteResult(written.application(), !written.created()));
    }

    @GetMapping("/applications/{applicationId}")
    ResponseEntity<KycDtos.ApplicationDto> get(@PathVariable UUID merchantId, @PathVariable UUID applicationId) {
        return noStore(service.get(merchantId, applicationId));
    }

    @PutMapping("/applications/{applicationId}/answers")
    ResponseEntity<KycDtos.ApplicationDto> saveAnswers(@PathVariable UUID merchantId, @PathVariable UUID applicationId,
                                                       @Valid @RequestBody KycDtos.SaveAnswersRequest request) {
        return noStore(service.saveAnswers(merchantId, applicationId, request));
    }

    @PutMapping("/applications/{applicationId}/documents/{key}")
    ResponseEntity<KycDtos.ApplicationDto> declareDocument(@PathVariable UUID merchantId, @PathVariable UUID applicationId, @PathVariable String key,
                                                           @Valid @RequestBody KycDtos.DocumentRequest request) {
        return noStore(service.declareDocument(merchantId, applicationId, key, request));
    }

    /** Always refused for now (501): there is no secure storage. */
    @PostMapping("/applications/{applicationId}/documents/{key}/upload")
    void upload(@PathVariable UUID merchantId, @PathVariable UUID applicationId, @PathVariable String key) {
        service.upload(merchantId, applicationId, key);
    }

    @PostMapping("/applications/{applicationId}/consent")
    ResponseEntity<KycDtos.ApplicationDto> consent(@PathVariable UUID merchantId, @PathVariable UUID applicationId,
                                                   @Valid @RequestBody KycDtos.ConsentRequest request) {
        return noStore(service.consent(merchantId, applicationId, request));
    }

    @PostMapping("/applications/{applicationId}/submit")
    ResponseEntity<KycDtos.WriteResult> submit(@PathVariable UUID merchantId, @PathVariable UUID applicationId,
                                               @Valid @RequestBody KycDtos.SubmitRequest request) {
        KycService.Written written = service.submit(merchantId, applicationId, request);
        return ResponseEntity.status(written.created() ? HttpStatus.CREATED : HttpStatus.OK).header("Cache-Control", "no-store")
                .body(new KycDtos.WriteResult(written.application(), !written.created()));
    }

    @PostMapping("/applications/{applicationId}/information-requests/{requestId}/response")
    ResponseEntity<KycDtos.ApplicationDto> respond(@PathVariable UUID merchantId, @PathVariable UUID applicationId, @PathVariable UUID requestId,
                                                   @Valid @RequestBody KycDtos.InformationResponseRequest request) {
        return noStore(service.respond(merchantId, applicationId, requestId, request));
    }

    /** Disabled by default (501). When enabled it shows one protected value to the owner: a POST, because viewing it is recorded; never cached. */
    @PostMapping("/applications/{applicationId}/answers/{key}/reveal")
    ResponseEntity<KycDtos.Revealed> reveal(@PathVariable UUID merchantId, @PathVariable UUID applicationId, @PathVariable String key) {
        return noStore(service.reveal(merchantId, applicationId, key));
    }

    private static <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(body);
    }
}
