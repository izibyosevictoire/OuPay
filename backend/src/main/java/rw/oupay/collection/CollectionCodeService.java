package rw.oupay.collection;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.banking.BankConnection;
import rw.oupay.banking.BankConnectionRepository;
import rw.oupay.banking.PaymentDestination;
import rw.oupay.banking.PaymentDestinationRepository;
import rw.oupay.branch.Branch;
import rw.oupay.branch.BranchAssignment;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.branch.BranchRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.Pagination;
import rw.oupay.common.SecureTokens;
import rw.oupay.idempotency.IdempotencyService;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * The merchant-facing side of the collection-code registry: requesting codes, recording that a bank request was made, suspending and
 * deactivating them, and assigning them to members or collection points.
 *
 * <h2>What this service can never do</h2>
 * It cannot approve a code, supply a bank-issued code or make anything {@code ACTIVE}. Those happen only in
 * {@link CollectionCodeApprovalService}, which has no HTTP endpoint and requires bank evidence. A code a merchant requests stays
 * {@code REQUESTED}, and is never presented as a payment code.
 *
 * <h2>Transactions and locking</h2>
 * Every write is ONE transaction. Lock order: (1) for a new request, the advisory lock of (business, client request id); (2) the
 * {@code SELECT ... FOR UPDATE} row lock of the code. Assign, end, reassign and the lifecycle changes all lock the same row, so they take
 * turns, and a stale view is a clean 409. Reassignment ends the open assignment and creates the next one inside the same transaction, so
 * there is never a moment with two open assignments or none by accident (a partial unique index backs that up).
 *
 * <h2>Staff changes never rewrite history</h2>
 * An assignment stores a snapshot of the person's name, role and the branch. If the person is later suspended or revoked, the history is
 * untouched; the open assignment is reported with the person's CURRENT status so the owner can end or reassign it. A suspended or revoked
 * member cannot receive a new assignment.
 */
@Service
public class CollectionCodeService {

    /** The result of a request, and whether this call created the code (false: the same request had already been made). */
    public record Written(CollectionCodeDtos.CodeDto code, boolean created) {}

    private static final int MAX_END_REASON = 200;

    private final CollectionCodeRepository codes;
    private final CollectionCodeAssignmentRepository assignments;
    private final PaymentDestinationRepository destinations;
    private final BankConnectionRepository connections;
    private final BranchRepository branches;
    private final BranchAssignmentRepository branchAssignments;
    private final MembershipRepository memberships;
    private final UserRepository users;
    private final MerchantAccess access;
    private final AuditService audit;
    private final IdempotencyService fingerprints;
    private final JdbcClient jdbc;
    private final Clock clock;

    public CollectionCodeService(CollectionCodeRepository codes, CollectionCodeAssignmentRepository assignments,
                                 PaymentDestinationRepository destinations, BankConnectionRepository connections, BranchRepository branches,
                                 BranchAssignmentRepository branchAssignments, MembershipRepository memberships, UserRepository users,
                                 MerchantAccess access, AuditService audit, IdempotencyService fingerprints, JdbcClient jdbc, Clock clock) {
        this.codes = codes;
        this.assignments = assignments;
        this.destinations = destinations;
        this.connections = connections;
        this.branches = branches;
        this.branchAssignments = branchAssignments;
        this.memberships = memberships;
        this.users = users;
        this.access = access;
        this.audit = audit;
        this.fingerprints = fingerprints;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    // ---------------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------------

    /** What the forms need: the settlement accounts, the branches and the members who could hold a code. */
    @Transactional(readOnly = true)
    public CollectionCodeDtos.Options options(UUID merchantId) {
        access.require(merchantId, Permission.COLLECTION_CODES_VIEW);
        Map<UUID, BankConnection.Status> connectionStatus = connections.findByMerchantIdOrderByCreatedAtAsc(merchantId).stream()
                .collect(Collectors.toMap(BankConnection::getId, BankConnection::getStatus));
        List<CollectionCodeDtos.DestinationOption> accounts = destinations.findByMerchantIdOrderByCreatedAtAsc(merchantId).stream()
                .map(d -> new CollectionCodeDtos.DestinationOption(d.getId(), d.getLabel(), d.getMaskedAccount(), d.getProviderId().name(),
                        d.isSimulated(), String.valueOf(connectionStatus.get(d.getBankConnectionId()))))
                .toList();
        List<CollectionCodeDtos.BranchOption> branchOptions = branches.findByMerchantIdOrderByNameAsc(merchantId).stream()
                .map(b -> new CollectionCodeDtos.BranchOption(b.getId(), b.getName(), b.getCode(), b.getStatus())).toList();
        Map<UUID, List<UUID>> branchesOf = branchAssignments.findByMerchantIdAndStatus(merchantId, "ACTIVE").stream()
                .collect(Collectors.groupingBy(BranchAssignment::getMembershipId,
                        Collectors.mapping(BranchAssignment::getBranchId, Collectors.toList())));
        List<Membership> active = memberships.findByMerchantId(merchantId).stream().filter(m -> m.getStatus() == MembershipStatus.ACTIVE).toList();
        Map<UUID, User> people = users.findAllById(active.stream().map(Membership::getUserId).toList()).stream()
                .collect(Collectors.toMap(User::getId, Function.identity()));
        List<CollectionCodeDtos.MemberOption> members = active.stream()
                .filter(m -> people.containsKey(m.getUserId()) && people.get(m.getUserId()).getStatus() == UserStatus.ACTIVE)
                .map(m -> new CollectionCodeDtos.MemberOption(m.getId(), m.getUserId(), people.get(m.getUserId()).getFullName(), m.getRole().name(),
                        branchesOf.getOrDefault(m.getId(), List.of())))
                .sorted(java.util.Comparator.comparing(CollectionCodeDtos.MemberOption::fullName)).toList();
        return new CollectionCodeDtos.Options(accounts, branchOptions, members);
    }

    @Transactional(readOnly = true)
    public Pagination.Page<CollectionCodeDtos.CodeDto> list(UUID merchantId, Integer limit, String cursor, CollectionCodeStatus status,
                                                            UUID branchId, String query) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_VIEW);
        int size = Pagination.limit(limit);
        Pagination.Position position = Pagination.decode(cursor);
        String text = query == null ? "" : query.trim();
        if (text.length() > 100) {
            throw ApiException.validation("The search text is too long.");
        }
        List<CollectionCode> fetched = codes.page(merchantId, position.at(), position.id(), status == null,
                status == null ? CollectionCodeStatus.REQUESTED : status, branchId == null, branchId == null ? new UUID(0L, 0L) : branchId,
                text.isEmpty(), "%" + escapeLike(text.toLowerCase(Locale.ROOT)) + "%", Pagination.fetch(size));
        Pagination.Page<CollectionCode> page = Pagination.page(fetched, size, CollectionCode::getCreatedAt, CollectionCode::getId, null);
        Lookup lookup = lookup(merchantId, page.items(), actor.can(Permission.COLLECTION_CODES_MANAGE));
        return page.map(code -> toDto(code, lookup));
    }

    @Transactional(readOnly = true)
    public CollectionCodeDtos.CodeDto get(UUID merchantId, UUID codeId) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_VIEW);
        CollectionCode code = find(merchantId, codeId);
        return toDto(code, lookup(merchantId, List.of(code), actor.can(Permission.COLLECTION_CODES_MANAGE)));
    }

    /** The full, immutable history of who held the code, newest first. */
    @Transactional(readOnly = true)
    public Pagination.Page<CollectionCodeDtos.AssignmentDto> history(UUID merchantId, UUID codeId, Integer limit, String cursor) {
        access.require(merchantId, Permission.COLLECTION_CODES_VIEW);
        find(merchantId, codeId);
        int size = Pagination.limit(limit);
        Pagination.Position position = Pagination.decode(cursor);
        List<CollectionCodeAssignment> fetched = assignments.history(merchantId, codeId, position.at(), position.id(), Pagination.fetch(size));
        Pagination.Page<CollectionCodeAssignment> page = Pagination.page(fetched, size, CollectionCodeAssignment::getValidFrom,
                CollectionCodeAssignment::getId, null);
        Map<UUID, MembershipStatus> current = currentStatuses(page.items());
        return page.map(a -> toDto(a, current));
    }

    /** The caller's OWN current code. Needs only an active membership: an agent sees nothing of anyone else's. */
    @Transactional(readOnly = true)
    public CollectionCodeDtos.MyCollectionCode mine(UUID merchantId) {
        Actor actor = access.requireMember(merchantId);
        List<CollectionCodeAssignment> open = assignments.findOpenForUser(merchantId, actor.userId());
        if (open.isEmpty()) {
            return new CollectionCodeDtos.MyCollectionCode(null, null);
        }
        CollectionCodeAssignment assignment = open.get(0);
        CollectionCode code = codes.findByIdAndMerchantId(assignment.getCodeId(), merchantId).orElseThrow();
        // The bank-issued code is shown to an agent only while the code is ELIGIBLE FOR COLLECTION right now (see eligibilityIssues): bank-approved,
        // real, assigned, on a connected account, at an active branch, and the agent still active and at that branch.
        List<String> issues = eligibilityIssues(code, assignment, lookup(merchantId, List.of(code), false));
        boolean eligible = issues.isEmpty();
        return new CollectionCodeDtos.MyCollectionCode(toDto(assignment, Map.of(actor.membership().getId(), actor.membership().getStatus())),
                new CollectionCodeDtos.MyCode(code.getId(), code.getDisplayLabel(), code.getStatus(), code.isSimulated(),
                        assignment.getBranchName(), eligible, eligible ? code.getExternalCode() : null, messageFor(code, issues)));
    }

    // ---------------------------------------------------------------------------------------------
    // Provisioning requests and lifecycle (owner)
    // ---------------------------------------------------------------------------------------------

    /**
     * Registers a request for a code on one of the merchant's settlement accounts. Durable and idempotent by {@code clientOperationId}:
     * the same request returns the same code, a different one under the same id is a 409. The code starts {@code REQUESTED}; nothing is
     * sent to the bank.
     */
    @Transactional
    public Written request(UUID merchantId, CollectionCodeDtos.RequestCodeRequest request) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_MANAGE);
        PaymentDestination destination = destinations.findByIdAndMerchantId(request.settlementDestinationId(), merchantId)
                .orElseThrow(() -> ApiException.notFound("This settlement account could not be found."));
        BankConnection connection = connections.findByIdAndMerchantId(destination.getBankConnectionId(), merchantId).orElseThrow();
        if (connection.getStatus() != BankConnection.Status.CONNECTED) {
            throw ApiException.invalidState("settlement_account_unavailable", "That settlement account is not connected.");
        }
        UUID branchId = null;
        if (request.branchId() != null) {
            Branch branch = branches.findByIdAndMerchantId(request.branchId(), merchantId)
                    .orElseThrow(() -> ApiException.notFound("This branch could not be found."));
            if (!branch.isActive()) {
                throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_not_eligible", "Choose an active branch.");
            }
            branchId = branch.getId();
        }
        String label = request.displayLabel().trim();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("actor", actor.userId());
        body.put("settlementDestinationId", destination.getId());
        body.put("displayLabel", label);
        body.put("branchId", branchId == null ? "" : branchId.toString());
        String fingerprint = fingerprints.fingerprintOf("COLLECTION_CODE_REQUEST", Map.of("merchantId", merchantId), body);

        // Lock 1: repeats of one request take turns. A repeat finds the committed code.
        jdbc.sql("select pg_advisory_xact_lock(hashtextextended(:key, 0))")
                .param("key", "collection-code-request:" + merchantId + ":" + request.clientOperationId())
                .query((rs, row) -> Boolean.TRUE).single();
        Optional<CollectionCode> existing = codes.findByMerchantIdAndClientRequestId(merchantId, request.clientOperationId());
        if (existing.isPresent()) {
            if (!fingerprint.equals(existing.get().getRequestSha256())) {
                throw ApiException.conflict("client_request_id_reuse", "This request identifier was already used for a different request.");
            }
            return new Written(toDto(existing.get(), lookup(merchantId, List.of(existing.get()), true)), false);
        }
        String internalRef;
        do {
            internalRef = SecureTokens.collectionCodeReference();
        } while (codes.existsByInternalRef(internalRef));
        CollectionCode code = codes.saveAndFlush(new CollectionCode(merchantId, destination.getProviderId(), destination.getId(),
                destination.isSimulated(), internalRef, label, branchId, request.clientOperationId(), fingerprint, actor.userId(), clock.instant()));
        audit.record(merchantId, actor.userId(), "COLLECTION_CODE_REQUESTED", "collection_code", code.getId(),
                "Collection code " + code.getInternalRef() + " (\"" + label + "\") requested. Nothing has been sent to the bank.");
        return new Written(toDto(code, lookup(merchantId, List.of(code), true)), true);
    }

    /** The owner records that a request WAS made to the bank, with its reference. This is a declaration, not an approval. */
    @Transactional
    public CollectionCodeDtos.CodeDto recordBankRequest(UUID merchantId, UUID codeId, CollectionCodeDtos.SubmissionRequest request) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_MANAGE);
        CollectionCode code = lock(merchantId, codeId);
        requireVersion(code, request.expectedVersion());
        requireTransition(code, CollectionCodeStatus.REQUEST_DECLARED);
        code.recordBankRequest(request.bankRequestRef().trim(), clock.instant());
        code = codes.saveAndFlush(code);
        audit.record(merchantId, actor.userId(), "COLLECTION_CODE_BANK_REQUEST_RECORDED", "collection_code", code.getId(),
                "The owner recorded a request to the bank for " + code.getInternalRef() + ". Not verified by OuPay.");
        return toDto(code, lookup(merchantId, List.of(code), true));
    }

    /** Stops the code from being used. Only the bank (through the trusted approval process) can resume it. */
    @Transactional
    public CollectionCodeDtos.CodeDto suspend(UUID merchantId, UUID codeId, CollectionCodeDtos.StatusChangeRequest request) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_MANAGE);
        CollectionCode code = lock(merchantId, codeId);
        requireVersion(code, request.expectedVersion());
        requireTransition(code, CollectionCodeStatus.SUSPENDED);
        code.suspend(request.reason().trim(), clock.instant());
        code = codes.saveAndFlush(code);
        audit.record(merchantId, actor.userId(), "COLLECTION_CODE_SUSPENDED", "collection_code", code.getId(),
                "Collection code " + code.getInternalRef() + " suspended. Reason: " + request.reason().trim());
        return toDto(code, lookup(merchantId, List.of(code), true));
    }

    /** Final. The open assignment is ended first, in the same transaction, and the bank-issued code stays reserved for ever. */
    @Transactional
    public CollectionCodeDtos.CodeDto deactivate(UUID merchantId, UUID codeId, CollectionCodeDtos.StatusChangeRequest request) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_MANAGE);
        CollectionCode code = lock(merchantId, codeId);
        requireVersion(code, request.expectedVersion());
        requireTransition(code, CollectionCodeStatus.DEACTIVATED);
        Instant now = clock.instant();
        endOpenAssignment(merchantId, code, actor.userId(), actor.user().getFullName(), "Collection code deactivated", now);
        code.deactivate(request.reason().trim(), now);
        code = codes.saveAndFlush(code);
        audit.record(merchantId, actor.userId(), "COLLECTION_CODE_DEACTIVATED", "collection_code", code.getId(),
                "Collection code " + code.getInternalRef() + " deactivated. Reason: " + request.reason().trim());
        return toDto(code, lookup(merchantId, List.of(code), true));
    }

    // ---------------------------------------------------------------------------------------------
    // Assignments
    // ---------------------------------------------------------------------------------------------

    @Transactional
    public CollectionCodeDtos.AssignmentDto assign(UUID merchantId, UUID codeId, CollectionCodeDtos.AssignRequest request) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_ASSIGN);
        CollectionCode code = lock(merchantId, codeId);
        requireAssignScope(actor, code);
        requireAssignable(code);
        if (assignments.findByCodeIdAndMerchantIdAndValidToIsNull(codeId, merchantId).isPresent()) {
            throw ApiException.conflict("already_assigned", "This code already has an agent. Reassign it instead.");
        }
        CollectionCodeAssignment created = open(merchantId, code, resolveSubject(merchantId, code, request.membershipId(),
                request.collectionPointLabel(), request.branchId()), actor, nextStart(merchantId, codeId));
        audit.record(merchantId, actor.userId(), "COLLECTION_CODE_ASSIGNED", "collection_code", code.getId(),
                "Collection code " + code.getInternalRef() + " assigned to " + created.getAssigneeName() + ".");
        return toDto(created, currentStatuses(List.of(created)));
    }

    @Transactional
    public CollectionCodeDtos.AssignmentDto endAssignment(UUID merchantId, UUID codeId, CollectionCodeDtos.EndRequest request) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_ASSIGN);
        CollectionCode code = lock(merchantId, codeId);
        requireAssignScope(actor, code);
        CollectionCodeAssignment open = requireOpen(merchantId, codeId, request.expectedAssignmentId());
        open.end(actor.userId(), actor.user().getFullName(), request.reason().trim(), clock.instant());
        open = assignments.saveAndFlush(open);
        audit.record(merchantId, actor.userId(), "COLLECTION_CODE_ASSIGNMENT_ENDED", "collection_code", code.getId(),
                "Assignment of " + code.getInternalRef() + " to " + open.getAssigneeName() + " ended. Reason: " + request.reason().trim());
        return toDto(open, Map.of());
    }

    /** Ends the open assignment and creates the next one in ONE transaction: the code is never left with two agents or none by accident. */
    @Transactional
    public CollectionCodeDtos.AssignmentDto reassign(UUID merchantId, UUID codeId, CollectionCodeDtos.ReassignRequest request) {
        Actor actor = access.require(merchantId, Permission.COLLECTION_CODES_ASSIGN);
        CollectionCode code = lock(merchantId, codeId);
        requireAssignScope(actor, code);
        requireAssignable(code);
        CollectionCodeAssignment previous = requireOpen(merchantId, codeId, request.expectedAssignmentId());
        CollectionCodeAssignment.Subject next = resolveSubject(merchantId, code, request.membershipId(), request.collectionPointLabel(), request.branchId());
        boolean same = next.kind() == previous.getAssigneeKind()
                && (next.kind() == AssigneeKind.MEMBER ? next.membershipId().equals(previous.getMembershipId())
                : next.collectionPointLabel().equalsIgnoreCase(previous.getCollectionPointLabel()));
        if (same) {
            throw ApiException.conflict("already_assigned", "This code is already assigned to that agent.");
        }
        Instant now = nextStart(merchantId, codeId);
        previous.end(actor.userId(), actor.user().getFullName(), request.reason().trim(), now);
        assignments.saveAndFlush(previous);
        CollectionCodeAssignment created = open(merchantId, code, next, actor, now);
        audit.record(merchantId, actor.userId(), "COLLECTION_CODE_REASSIGNED", "collection_code", code.getId(),
                "Collection code " + code.getInternalRef() + " reassigned from " + previous.getAssigneeName() + " to " + created.getAssigneeName()
                        + ". Reason: " + request.reason().trim());
        return toDto(created, currentStatuses(List.of(created)));
    }

    // ---------------------------------------------------------------------------------------------
    // Rules
    // ---------------------------------------------------------------------------------------------

    /**
     * When a new period of a code starts: now, but never before the previous period began (plus one microsecond) or ended. History is ordered by
     * (valid_from, id) and the id is random, so two periods of ONE code must never start in the same instant; this keeps them strictly ordered
     * (and never overlapping) even within one clock tick or if the clock steps back. It only ever moves a start by microseconds, and only forward.
     */
    private Instant nextStart(UUID merchantId, UUID codeId) {
        // The database keeps microseconds: compare and store the same value.
        Instant now = clock.instant().truncatedTo(java.time.temporal.ChronoUnit.MICROS);
        return assignments.findFirstByCodeIdAndMerchantIdOrderByValidFromDescIdDesc(codeId, merchantId).map(previous -> {
            Instant floor = previous.getValidFrom().plus(1, java.time.temporal.ChronoUnit.MICROS);
            if (previous.getValidTo() != null && previous.getValidTo().isAfter(floor)) {
                floor = previous.getValidTo();
            }
            return now.isBefore(floor) ? floor : now;
        }).orElse(now);
    }

    private CollectionCodeAssignment open(UUID merchantId, CollectionCode code, CollectionCodeAssignment.Subject subject, Actor actor, Instant now) {
        return assignments.saveAndFlush(new CollectionCodeAssignment(code.getId(), merchantId, subject, actor.userId(), actor.user().getFullName(), now));
    }

    private void endOpenAssignment(UUID merchantId, CollectionCode code, UUID byUserId, String byName, String reason, Instant now) {
        assignments.findByCodeIdAndMerchantIdAndValidToIsNull(code.getId(), merchantId).ifPresent(open -> {
            open.end(byUserId, byName, reason.length() > MAX_END_REASON ? reason.substring(0, MAX_END_REASON) : reason, now);
            assignments.saveAndFlush(open);
        });
    }

    private CollectionCodeAssignment requireOpen(UUID merchantId, UUID codeId, UUID expectedAssignmentId) {
        CollectionCodeAssignment open = assignments.findByCodeIdAndMerchantIdAndValidToIsNull(codeId, merchantId)
                .orElseThrow(() -> ApiException.conflict("no_open_assignment", "This code has no current agent."));
        if (!open.getId().equals(expectedAssignmentId)) {
            throw ApiException.conflict("assignment_changed", "This code was reassigned by someone else. Reload it and try again.");
        }
        return open;
    }

    /**
     * Who may hold a code, and where. A member must be ACTIVE (and their user active); if the assignment has a branch, that branch must be
     * active and the member must be actively assigned to it, exactly as for invoices. A code with a branch can only be assigned at that
     * branch. A collection point is a named place with no person.
     */
    private CollectionCodeAssignment.Subject resolveSubject(UUID merchantId, CollectionCode code, UUID membershipId, String pointLabel, UUID requestedBranch) {
        boolean byMember = membershipId != null;
        boolean byPoint = pointLabel != null && !pointLabel.isBlank();
        if (byMember == byPoint) {
            throw ApiException.validation("Choose either a staff member or a collection point.");
        }
        UUID branchId = effectiveBranch(code, requestedBranch);
        Branch branch = null;
        if (branchId != null) {
            branch = branches.findByIdAndMerchantId(branchId, merchantId)
                    .orElseThrow(() -> new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_not_eligible", "That branch could not be found."));
            if (!branch.isActive()) {
                throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_not_eligible", "Choose an active branch.");
            }
        }
        String branchName = branch == null ? null : branch.getName();
        String branchCode = branch == null ? null : branch.getCode();
        if (byPoint) {
            String label = pointLabel.trim();
            return new CollectionCodeAssignment.Subject(AssigneeKind.COLLECTION_POINT, null, null, label, label, null, branchId, branchName, branchCode);
        }
        Membership membership = memberships.findByIdAndMerchantId(membershipId, merchantId)
                .orElseThrow(() -> new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "assignee_not_eligible", "That staff member could not be found."));
        User person = users.findById(membership.getUserId()).filter(u -> u.getStatus() == UserStatus.ACTIVE)
                .orElseThrow(() -> new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "assignee_not_eligible", "That person cannot be assigned a code."));
        if (membership.getStatus() != MembershipStatus.ACTIVE) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "assignee_not_eligible",
                    "Only active staff can be assigned a collection code.");
        }
        if (branchId != null && !branchAssignments.existsByMembershipIdAndBranchIdAndStatus(membership.getId(), branchId, "ACTIVE")) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "assignee_not_eligible", "That person is not assigned to that branch.");
        }
        return new CollectionCodeAssignment.Subject(AssigneeKind.MEMBER, membership.getId(), person.getId(), null, person.getFullName(),
                membership.getRole().name(), branchId, branchName, branchCode);
    }

    private static UUID effectiveBranch(CollectionCode code, UUID requested) {
        if (code.getBranchId() != null) {
            if (requested != null && !requested.equals(code.getBranchId())) {
                throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_not_eligible", "This code belongs to a different branch.");
            }
            return code.getBranchId();
        }
        return requested;
    }

    /** A manager (limited scope) may only handle codes of branches they are actively assigned to; a code without a branch is the owner's. */
    private void requireAssignScope(Actor actor, CollectionCode code) {
        if (actor.hasFullScope(Permission.COLLECTION_CODES_ASSIGN)) {
            return;
        }
        if (code.getBranchId() == null
                || !branchAssignments.existsByMembershipIdAndBranchIdAndStatus(actor.membership().getId(), code.getBranchId(), "ACTIVE")) {
            throw ApiException.forbidden("You can only assign codes of branches you are assigned to.");
        }
    }

    private static void requireAssignable(CollectionCode code) {
        if (!code.getStatus().assignable()) {
            throw ApiException.conflict("code_status_invalid", "A code that is " + code.getStatus().name().toLowerCase(Locale.ROOT) + " cannot be assigned.");
        }
    }

    private static void requireTransition(CollectionCode code, CollectionCodeStatus target) {
        if (!code.getStatus().canMoveTo(target)) {
            throw ApiException.conflict("code_status_invalid", "A code that is " + code.getStatus().name().toLowerCase(Locale.ROOT)
                    + " cannot become " + target.name().toLowerCase(Locale.ROOT) + ".");
        }
    }

    private static void requireVersion(CollectionCode code, long expected) {
        if (code.getVersion() != expected) {
            throw ApiException.conflict("version_conflict", "This code was changed by someone else. Reload it and try again.");
        }
    }

    private CollectionCode find(UUID merchantId, UUID codeId) {
        return codes.findByIdAndMerchantId(codeId, merchantId).orElseThrow(CollectionCodeService::notFound);
    }

    private CollectionCode lock(UUID merchantId, UUID codeId) {
        return codes.lockByIdAndMerchantId(codeId, merchantId).orElseThrow(CollectionCodeService::notFound);
    }

    private static ApiException notFound() {
        return ApiException.notFound("This collection code could not be found.");
    }

    // ---------------------------------------------------------------------------------------------
    // Presentation
    // ---------------------------------------------------------------------------------------------

    /**
     * Everything needed to present codes, loaded in batches. {@code privileged} is true for people who manage codes (owners): only they see
     * approval evidence references and the owner-declared bank request reference.
     */
    private record Lookup(Map<UUID, PaymentDestination> destinations, Map<UUID, Branch> branches, Map<UUID, CollectionCodeAssignment> open,
                          Map<UUID, MembershipStatus> memberStatus, Map<UUID, BankConnection.Status> connections,
                          Map<UUID, UserStatus> userStatus, Set<String> staffAtBranch, boolean privileged) {}

    private Lookup lookup(UUID merchantId, Collection<CollectionCode> list, boolean privileged) {
        if (list.isEmpty()) {
            return new Lookup(Map.of(), Map.of(), Map.of(), Map.of(), Map.of(), Map.of(), Set.of(), privileged);
        }
        Map<UUID, PaymentDestination> accounts = destinations.findAllById(list.stream().map(CollectionCode::getSettlementDestinationId).collect(Collectors.toSet()))
                .stream().collect(Collectors.toMap(PaymentDestination::getId, Function.identity()));
        Map<UUID, CollectionCodeAssignment> open = assignments.findOpenForCodes(merchantId, list.stream().map(CollectionCode::getId).toList())
                .stream().collect(Collectors.toMap(CollectionCodeAssignment::getCodeId, Function.identity()));
        Set<UUID> branchIds = list.stream().map(CollectionCode::getBranchId).filter(java.util.Objects::nonNull).collect(Collectors.toSet());
        open.values().stream().map(CollectionCodeAssignment::getBranchId).filter(java.util.Objects::nonNull).forEach(branchIds::add);
        Map<UUID, Branch> branchMap = branchIds.isEmpty() ? Map.of()
                : branches.findAllById(branchIds).stream().collect(Collectors.toMap(Branch::getId, Function.identity()));
        Map<UUID, BankConnection.Status> connectionStatus = connections.findAllById(accounts.values().stream()
                .map(PaymentDestination::getBankConnectionId).collect(Collectors.toSet())).stream()
                .collect(Collectors.toMap(BankConnection::getId, BankConnection::getStatus));
        Set<UUID> userIds = open.values().stream().map(CollectionCodeAssignment::getAssigneeUserId).filter(java.util.Objects::nonNull)
                .collect(Collectors.toSet());
        Map<UUID, UserStatus> userStatus = new HashMap<>();
        Set<String> staffAtBranch = Set.of();
        if (!userIds.isEmpty()) {
            users.findAllById(userIds).forEach(u -> userStatus.put(u.getId(), u.getStatus()));
            staffAtBranch = branchAssignments.findByMerchantIdAndStatus(merchantId, "ACTIVE").stream()
                    .map(a -> a.getMembershipId() + ":" + a.getBranchId()).collect(Collectors.toSet());
        }
        return new Lookup(accounts, branchMap, open, currentStatuses(open.values()), connectionStatus, userStatus, staffAtBranch, privileged);
    }

    /** The CURRENT status of the members named by open assignments; history snapshots are never touched. */
    private Map<UUID, MembershipStatus> currentStatuses(Collection<CollectionCodeAssignment> list) {
        Set<UUID> ids = list.stream().filter(a -> a.isOpen() && a.getMembershipId() != null).map(CollectionCodeAssignment::getMembershipId)
                .collect(Collectors.toSet());
        Map<UUID, MembershipStatus> statuses = new HashMap<>();
        if (!ids.isEmpty()) {
            memberships.findAllById(ids).forEach(m -> statuses.put(m.getId(), m.getStatus()));
        }
        return statuses;
    }

    /**
     * Why a code cannot be used for collection RIGHT NOW; empty means it is ELIGIBLE FOR COLLECTION. Computed live from current state on
     * every read, never stored, so an open assignment record can never keep a code usable after its agent, branch or account stops being
     * valid. The conditions, all required:
     * <ol>
     *   <li>the code is real: not simulated ({@code SIMULATED}); the bank provisioned it: ACTIVE with a bank-issued code and evidence
     *       ({@code NOT_BANK_APPROVED});</li>
     *   <li>it is assigned: there is one open assignment ({@code NOT_ASSIGNED});</li>
     *   <li>its settlement account is connected ({@code SETTLEMENT_ACCOUNT_NOT_CONNECTED});</li>
     *   <li>the branch of the assignment, if any, is active ({@code BRANCH_INACTIVE});</li>
     *   <li>for a member: the membership AND the user are ACTIVE ({@code ASSIGNEE_NOT_ACTIVE}) and, with a branch, the member is still
     *       actively assigned to it ({@code ASSIGNEE_NOT_AT_BRANCH}).</li>
     * </ol>
     * A collection point has no person, so only the code, account and branch conditions apply.
     */
    private static List<String> eligibilityIssues(CollectionCode code, CollectionCodeAssignment open, Lookup lookup) {
        List<String> issues = new ArrayList<>();
        if (code.isSimulated()) {
            issues.add("SIMULATED");
        }
        if (code.getStatus() != CollectionCodeStatus.ACTIVE || code.getExternalCode() == null) {
            issues.add("NOT_BANK_APPROVED");
        }
        if (open == null) {
            issues.add("NOT_ASSIGNED");
        }
        PaymentDestination account = lookup.destinations().get(code.getSettlementDestinationId());
        if (account == null || lookup.connections().get(account.getBankConnectionId()) != BankConnection.Status.CONNECTED) {
            issues.add("SETTLEMENT_ACCOUNT_NOT_CONNECTED");
        }
        if (open != null) {
            UUID branchId = open.getBranchId() != null ? open.getBranchId() : code.getBranchId();
            if (branchId != null) {
                Branch branch = lookup.branches().get(branchId);
                if (branch == null || !branch.isActive()) {
                    issues.add("BRANCH_INACTIVE");
                }
            }
            if (open.getAssigneeKind() == AssigneeKind.MEMBER) {
                if (lookup.memberStatus().get(open.getMembershipId()) != MembershipStatus.ACTIVE
                        || lookup.userStatus().get(open.getAssigneeUserId()) != UserStatus.ACTIVE) {
                    issues.add("ASSIGNEE_NOT_ACTIVE");
                } else if (branchId != null && !lookup.staffAtBranch().contains(open.getMembershipId() + ":" + branchId)) {
                    issues.add("ASSIGNEE_NOT_AT_BRANCH");
                }
            }
        }
        return issues;
    }

    private CollectionCodeDtos.CodeDto toDto(CollectionCode code, Lookup lookup) {
        PaymentDestination account = lookup.destinations().get(code.getSettlementDestinationId());
        Branch branch = code.getBranchId() == null ? null : lookup.branches().get(code.getBranchId());
        CollectionCodeAssignment open = lookup.open().get(code.getId());
        boolean approved = code.getExternalCode() != null;
        List<String> issues = eligibilityIssues(code, open, lookup);
        return new CollectionCodeDtos.CodeDto(code.getId(), code.getInternalRef(), code.getDisplayLabel(), code.getProviderId().name(),
                code.getSettlementDestinationId(), account == null ? null : account.getLabel(), account == null ? null : account.getMaskedAccount(),
                code.isSimulated(), code.getBranchId(), branch == null ? null : branch.getName(), branch == null ? null : branch.getCode(),
                code.getStatus(), code.getStatusReason(), lookup.privileged() ? code.getBankRequestRef() : null,
                approved ? "BANK_APPROVED" : "NOT_ISSUED", approved ? code.getExternalCode() : null,
                approved ? new CollectionCodeDtos.Approval(code.getApprovalSource(), lookup.privileged() ? code.getApprovalEvidenceRef() : null,
                        code.getApprovedAt()) : null,
                code.isBankProvisioned(), issues.isEmpty(), issues, open == null ? null : toDto(open, lookup.memberStatus()),
                code.getCreatedAt(), code.getUpdatedAt(), code.getVersion());
    }

    private static CollectionCodeDtos.AssignmentDto toDto(CollectionCodeAssignment a, Map<UUID, MembershipStatus> current) {
        return new CollectionCodeDtos.AssignmentDto(a.getId(), a.getCodeId(), a.getAssigneeKind(), a.getMembershipId(), a.getAssigneeUserId(),
                a.getAssigneeName(), a.getAssigneeRole(), a.getCollectionPointLabel(), a.getBranchId(), a.getBranchName(), a.getBranchCode(),
                a.getValidFrom(), a.getValidTo(), a.getAssignedByName(), a.getEndedByName(), a.getEndReason(),
                a.isOpen() && a.getMembershipId() != null ? current.get(a.getMembershipId()) : null);
    }

    /** What an agent is told about their own code, in plain language. */
    private static String messageFor(CollectionCode code, List<String> issues) {
        if (issues.isEmpty()) {
            return "This code is approved by the bank and assigned to you. You may collect with it.";
        }
        if (issues.contains("SIMULATED")) {
            return "This is a simulated code. It cannot receive real payments.";
        }
        return switch (code.getStatus()) {
            case REQUESTED -> "Your owner has requested this code. It is not usable yet; do not give it to customers.";
            case REQUEST_DECLARED -> "Your owner says a request was made to the bank. The bank has not confirmed it here; do not give this code to customers yet.";
            case SUSPENDED -> "This code is suspended. Do not use it.";
            case DEACTIVATED -> "This code is no longer in use.";
            case REJECTED -> "The bank did not approve this code.";
            case ACTIVE -> "This code is approved by the bank but cannot be used for collection right now: " + issues.stream()
                    .map(CollectionCodeService::describe).collect(Collectors.joining(", ")) + ".";
        };
    }

    private static String describe(String issue) {
        return switch (issue) {
            case "NOT_ASSIGNED" -> "it is not assigned to anyone";
            case "SETTLEMENT_ACCOUNT_NOT_CONNECTED" -> "the settlement account is not connected";
            case "BRANCH_INACTIVE" -> "the branch is not active";
            case "ASSIGNEE_NOT_ACTIVE" -> "the assigned person is not active";
            case "ASSIGNEE_NOT_AT_BRANCH" -> "the assigned person is no longer assigned to the branch";
            default -> issue.toLowerCase(Locale.ROOT).replace('_', ' ');
        };
    }

    private static String escapeLike(String text) {
        return text.replace("!", "!!").replace("%", "!%").replace("_", "!_");
    }

}
