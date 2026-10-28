package rw.oupay.ledger;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.branch.BranchAssignment;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.Pagination;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;

/**
 * Who may see how a bank transaction was attributed, and how much of it:
 * <ul>
 *   <li><b>Owner</b>: every incoming transaction of the business, attributed or not, with the reported code in full.</li>
 *   <li><b>Manager</b>: only attributed transactions whose code AND sale (each one present) belong to branches they are actively assigned to,
 *       so a conflict between two branches never shows one branch the other's code or sale. A business-wide
 *       code, an unresolved code and a transaction without attribution are the owner's. The reported value is shown in full only when it
 *       resolved to one of the business's own codes; otherwise it is masked.</li>
 *   <li><b>Cashier</b>: only verified (confirmed) transactions whose agent is CONFIRMED from the immutable snapshot of THEIR OWN sale. A sale
 *       that is merely named, a code alone, or who holds a code, is never reliable enough to show a person money. The code is always masked.</li>
 * </ul>
 * Authorisation is decided here, in the query, so a request can never ask for more than its role may see. Another business's record is
 * simply not found.
 */
@Service
public class AttributionService {

    private static final String SELECT = """
            select t.id, t.merchant_id, t.provider_transaction_id, t.status, t.amount_rwf, t.provider_occurred_at, t.created_at, t.review_state,
                   t.reported_code, t.attribution_status, t.attribution_basis, t.agent_attribution, t.collection_code_id,
                   c.display_label as code_label, c.branch_id as code_branch_id,
                   cs.sale_reference, cs.agent_name, cs.agent_user_id, cs.invoice_id, cs.branch_id as sale_branch_id,
                   exists (select 1 from payment_allocations a where a.bank_transaction_id = t.id and a.merchant_id = t.merchant_id
                           and a.invoice_id = cs.invoice_id and a.status = 'ACTIVE') as matched
            from bank_transactions t
            left join collection_codes c on c.id = t.collection_code_id and c.merchant_id = t.merchant_id
            left join code_sales cs on cs.payment_request_id = t.referenced_code_sale_id and cs.merchant_id = t.merchant_id
            where t.merchant_id = :m and t.direction = 'INCOMING'
            """;

    private record Row(UUID id, UUID merchantId, String providerTransactionId, BankTransactionStatus status, long amount, java.time.Instant occurredAt,
                       java.time.Instant createdAt, ReviewState reviewState, String reportedCode, String attributionStatus, String basis,
                       String agentAttribution, UUID codeId, String codeLabel, UUID codeBranchId, String saleReference, String agentName,
                       boolean matched) {}

    private final JdbcClient jdbc;
    private final MerchantAccess access;
    private final BranchAssignmentRepository branchAssignments;

    public AttributionService(JdbcClient jdbc, MerchantAccess access, BranchAssignmentRepository branchAssignments) {
        this.jdbc = jdbc;
        this.access = access;
        this.branchAssignments = branchAssignments;
    }

    @Transactional(readOnly = true)
    public Pagination.Page<AttributionDtos.AttributionView> list(UUID merchantId, Integer limit, String cursor) {
        Actor actor = access.require(merchantId, Permission.TRANSACTIONS_VIEW);
        int size = Pagination.limit(limit);
        var position = Pagination.decode(cursor);
        Scope scope = scopeOf(actor);
        if (scope.nothing()) {
            return new Pagination.Page<>(List.of(), null, 0L);
        }
        var query = jdbc.sql(SELECT + scope.sql() + " and (t.created_at < :at or (t.created_at = :at and t.id < :id)) order by t.created_at desc, t.id desc limit :n")
                .param("m", merchantId).param("at", Timestamp.from(position.at())).param("id", position.id()).param("n", size + 1);
        List<Row> rows = scope.bind(query).query((rs, i) -> row(rs)).list();
        var page = Pagination.page(rows, size, Row::createdAt, Row::id, null);
        return new Pagination.Page<>(page.items().stream().map(r -> view(r, actor)).toList(), page.nextCursor(), null);
    }

    @Transactional(readOnly = true)
    public AttributionDtos.AttributionView get(UUID merchantId, UUID transactionId) {
        Actor actor = access.require(merchantId, Permission.TRANSACTIONS_VIEW);
        Scope scope = scopeOf(actor);
        if (scope.nothing()) {
            throw notFound();
        }
        var query = jdbc.sql(SELECT + scope.sql() + " and t.id = :tx").param("m", merchantId).param("tx", transactionId);
        return scope.bind(query).query((rs, i) -> row(rs)).optional().map(r -> view(r, actor)).orElseThrow(AttributionService::notFound);
    }

    // ---- scope ----------------------------------------------------------------------------------

    private record Scope(String sql, List<UUID> branches, UUID userId, boolean nothing) {

        JdbcClient.StatementSpec bind(JdbcClient.StatementSpec spec) {
            JdbcClient.StatementSpec bound = spec;
            if (branches != null) {
                bound = bound.param("branches", branches);
            }
            if (userId != null) {
                bound = bound.param("user", userId);
            }
            return bound;
        }
    }

    private Scope scopeOf(Actor actor) {
        if (actor.role() == Role.OWNER) {
            return new Scope("", null, null, false);
        }
        if (actor.role() == Role.MANAGER) {
            List<UUID> branches = branchAssignments.findByMembershipIdAndStatus(actor.membership().getId(), "ACTIVE").stream()
                    .map(BranchAssignment::getBranchId).distinct().collect(Collectors.toCollection(ArrayList::new));
            return branches.isEmpty() ? new Scope("", null, null, true)
                    : new Scope(" and t.attribution_status is not null and (c.id is not null or cs.payment_request_id is not null)"
                            + " and (c.id is null or c.branch_id in (:branches)) and (cs.payment_request_id is null or cs.branch_id in (:branches))",
                            branches, null, false);
        }
        return new Scope(" and t.agent_attribution = 'CONFIRMED_FROM_SALE_SNAPSHOT' and t.status = 'CONFIRMED' and cs.agent_user_id = :user", null, actor.userId(), false);
    }

    // ---- shape ----------------------------------------------------------------------------------

    private static Row row(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Row(rs.getObject("id", UUID.class), rs.getObject("merchant_id", UUID.class), rs.getString("provider_transaction_id"),
                BankTransactionStatus.valueOf(rs.getString("status")), rs.getLong("amount_rwf"), rs.getTimestamp("provider_occurred_at").toInstant(),
                rs.getTimestamp("created_at").toInstant(), ReviewState.valueOf(rs.getString("review_state")), rs.getString("reported_code"),
                rs.getString("attribution_status"), rs.getString("attribution_basis"), rs.getString("agent_attribution"),
                rs.getObject("collection_code_id", UUID.class), rs.getString("code_label"), rs.getObject("code_branch_id", UUID.class),
                rs.getString("sale_reference"), rs.getString("agent_name"), rs.getBoolean("matched"));
    }

    private static AttributionDtos.AttributionView view(Row r, Actor actor) {
        // A reported value is shown in full to the owner, and to a manager only when it resolved to one of the business's own codes.
        boolean full = r.reportedCode() != null && (actor.role() == Role.OWNER || (actor.role() == Role.MANAGER && r.codeId() != null));
        String reported = r.reportedCode() == null ? null : full ? r.reportedCode() : mask(r.reportedCode());
        var code = r.codeId() == null ? null : new AttributionDtos.CodeRef(r.codeId(), r.codeLabel(), r.codeBranchId());
        // The collector is named only when the evidence agrees (code, sale and account) AND the money is verified: not for pending, failed or
        // reversed money, and never for a sale that is merely named.
        boolean confirmed = "CONFIRMED_FROM_SALE_SNAPSHOT".equals(r.agentAttribution()) && r.status() == BankTransactionStatus.CONFIRMED;
        return new AttributionDtos.AttributionView(r.merchantId(), r.id(), r.providerTransactionId(), r.status(), r.amount(), r.occurredAt(), reported,
                r.reportedCode() != null && !full, code, r.attributionStatus() == null ? "NOT_EVALUATED" : r.attributionStatus(), r.basis(),
                r.agentAttribution(), confirmed ? r.agentName() : null, r.saleReference(), r.matched(), r.reviewState(), r.createdAt());
    }

    /** Keeps only the last two characters of a longer value: enough to recognise it, never enough to use it. */
    static String mask(String value) {
        return value.length() <= 4 ? "••••" : "••••" + value.substring(value.length() - 2);
    }

    private static ApiException notFound() {
        return ApiException.notFound("This transaction could not be found.");
    }
}
