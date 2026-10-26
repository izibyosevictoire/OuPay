package rw.oupay.collection;

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
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.common.Pagination;

/**
 * The merchant is only ever the URL. There is NO endpoint here that approves a code, records a bank-issued code or activates anything:
 * see {@link CollectionCodeApprovalService}, which has no HTTP surface.
 */
@RestController
@RequestMapping("/api/v1/merchants/{merchantId}/collection-codes")
public class CollectionCodeController {

    private final CollectionCodeService service;

    public CollectionCodeController(CollectionCodeService service) {
        this.service = service;
    }

    @GetMapping("/options")
    CollectionCodeDtos.Options options(@PathVariable UUID merchantId) {
        return service.options(merchantId);
    }

    @GetMapping("/mine")
    CollectionCodeDtos.MyCollectionCode mine(@PathVariable UUID merchantId) {
        return service.mine(merchantId);
    }

    @GetMapping
    Pagination.Page<CollectionCodeDtos.CodeDto> list(@PathVariable UUID merchantId, @RequestParam(required = false) Integer limit,
                                                     @RequestParam(required = false) String cursor,
                                                     @RequestParam(required = false) CollectionCodeStatus status,
                                                     @RequestParam(required = false) UUID branchId, @RequestParam(required = false) String q) {
        return service.list(merchantId, limit, cursor, status, branchId, q);
    }

    /** 201 when this call registered the request, 200 with {@code replayed: true} when the same request had already been made. */
    @PostMapping
    ResponseEntity<CollectionCodeDtos.WriteResult> request(@PathVariable UUID merchantId,
                                                           @Valid @RequestBody CollectionCodeDtos.RequestCodeRequest request) {
        CollectionCodeService.Written written = service.request(merchantId, request);
        return ResponseEntity.status(written.created() ? HttpStatus.CREATED : HttpStatus.OK)
                .body(new CollectionCodeDtos.WriteResult(written.code(), !written.created()));
    }

    @GetMapping("/{codeId}")
    CollectionCodeDtos.CodeDto get(@PathVariable UUID merchantId, @PathVariable UUID codeId) {
        return service.get(merchantId, codeId);
    }

    @GetMapping("/{codeId}/assignments")
    Pagination.Page<CollectionCodeDtos.AssignmentDto> history(@PathVariable UUID merchantId, @PathVariable UUID codeId,
                                                              @RequestParam(required = false) Integer limit,
                                                              @RequestParam(required = false) String cursor) {
        return service.history(merchantId, codeId, limit, cursor);
    }

    @PostMapping("/{codeId}/assignments")
    @ResponseStatus(HttpStatus.CREATED)
    CollectionCodeDtos.AssignmentDto assign(@PathVariable UUID merchantId, @PathVariable UUID codeId,
                                            @Valid @RequestBody CollectionCodeDtos.AssignRequest request) {
        return service.assign(merchantId, codeId, request);
    }

    @PostMapping("/{codeId}/assignments/end")
    CollectionCodeDtos.AssignmentDto end(@PathVariable UUID merchantId, @PathVariable UUID codeId,
                                         @Valid @RequestBody CollectionCodeDtos.EndRequest request) {
        return service.endAssignment(merchantId, codeId, request);
    }

    @PostMapping("/{codeId}/reassign")
    CollectionCodeDtos.AssignmentDto reassign(@PathVariable UUID merchantId, @PathVariable UUID codeId,
                                              @Valid @RequestBody CollectionCodeDtos.ReassignRequest request) {
        return service.reassign(merchantId, codeId, request);
    }

    @PostMapping("/{codeId}/submission")
    CollectionCodeDtos.CodeDto recordBankRequest(@PathVariable UUID merchantId, @PathVariable UUID codeId,
                                                 @Valid @RequestBody CollectionCodeDtos.SubmissionRequest request) {
        return service.recordBankRequest(merchantId, codeId, request);
    }

    @PostMapping("/{codeId}/suspend")
    CollectionCodeDtos.CodeDto suspend(@PathVariable UUID merchantId, @PathVariable UUID codeId,
                                       @Valid @RequestBody CollectionCodeDtos.StatusChangeRequest request) {
        return service.suspend(merchantId, codeId, request);
    }

    @PostMapping("/{codeId}/deactivate")
    CollectionCodeDtos.CodeDto deactivate(@PathVariable UUID merchantId, @PathVariable UUID codeId,
                                          @Valid @RequestBody CollectionCodeDtos.StatusChangeRequest request) {
        return service.deactivate(merchantId, codeId, request);
    }
}
