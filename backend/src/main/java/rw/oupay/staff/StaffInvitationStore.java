package rw.oupay.staff;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import rw.oupay.membership.Role;

/**
 * Persistence for staff invitations. Tokens are stored as SHA-256 hashes only. Status changes are
 * conditional UPDATEs ({@code where status = :from}), so a single-use rule holds even when two requests
 * race for the same invitation.
 */
@Repository
public class StaffInvitationStore {

    public record Row(UUID id, UUID merchantId, UUID membershipId, String email, Role role, String note, UUID invitedByUserId,
                      String status, Instant expiresAt, Instant createdAt, Instant updatedAt) {

        /** PENDING in the table, but past its expiry: reported as EXPIRED. */
        public String effectiveStatus(Instant now) {
            return "PENDING".equals(status) && !expiresAt.isAfter(now) ? "EXPIRED" : status;
        }
    }

    private static final String COLUMNS = "id, merchant_id, membership_id, email, role, note, invited_by_user_id, status, expires_at, created_at, updated_at";

    private final JdbcClient jdbc;

    public StaffInvitationStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    private static Row map(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Row(rs.getObject("id", UUID.class), rs.getObject("merchant_id", UUID.class), rs.getObject("membership_id", UUID.class),
                rs.getString("email"), Role.valueOf(rs.getString("role")), rs.getString("note"),
                rs.getObject("invited_by_user_id", UUID.class), rs.getString("status"),
                rs.getTimestamp("expires_at").toInstant(), rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant());
    }

    public void insert(Row row, byte[] tokenHash, List<UUID> branchIds) {
        jdbc.sql("insert into staff_invitations (id, merchant_id, membership_id, email, role, note, invited_by_user_id, token_hash, status, "
                        + "expires_at, created_at, updated_at) values (:id, :m, :mem, :email, :role, :note, :by, :h, 'PENDING', :exp, :now, :now)")
                .param("id", row.id()).param("m", row.merchantId()).param("mem", row.membershipId()).param("email", row.email())
                .param("role", row.role().name()).param("note", row.note()).param("by", row.invitedByUserId()).param("h", tokenHash)
                .param("exp", Timestamp.from(row.expiresAt())).param("now", Timestamp.from(row.createdAt()))
                .update();
        for (UUID branchId : branchIds) {
            jdbc.sql("insert into staff_invitation_branches (invitation_id, merchant_id, branch_id) values (:i, :m, :b)")
                    .param("i", row.id()).param("m", row.merchantId()).param("b", branchId).update();
        }
    }

    public Optional<Row> findByTokenHash(byte[] hash) {
        return jdbc.sql("select " + COLUMNS + " from staff_invitations where token_hash = :h").param("h", hash)
                .query(StaffInvitationStore::map).optional();
    }

    /** Row lock: serialises two people (or two requests) accepting the same invitation. */
    public Optional<Row> lockByTokenHash(byte[] hash) {
        return jdbc.sql("select " + COLUMNS + " from staff_invitations where token_hash = :h for update").param("h", hash)
                .query(StaffInvitationStore::map).optional();
    }

    public Optional<Row> lockPendingForMembership(UUID membershipId) {
        return jdbc.sql("select " + COLUMNS + " from staff_invitations where membership_id = :m and status = 'PENDING' for update")
                .param("m", membershipId).query(StaffInvitationStore::map).optional();
    }

    public List<Row> listForMerchant(UUID merchantId) {
        return jdbc.sql("select " + COLUMNS + " from staff_invitations where merchant_id = :m order by created_at desc, id desc")
                .param("m", merchantId).query(StaffInvitationStore::map).list();
    }

    public List<UUID> branchIds(UUID invitationId) {
        return jdbc.sql("select branch_id from staff_invitation_branches where invitation_id = :i order by branch_id")
                .param("i", invitationId).query(UUID.class).list();
    }

    /** Branches of every PENDING invitation of a business, keyed by membership (for the staff list). */
    public Map<UUID, List<UUID>> pendingBranchesByMembership(UUID merchantId) {
        Map<UUID, List<UUID>> result = new HashMap<>();
        jdbc.sql("select i.membership_id, b.branch_id from staff_invitations i join staff_invitation_branches b on b.invitation_id = i.id "
                        + "where i.merchant_id = :m and i.status = 'PENDING' order by b.branch_id")
                .param("m", merchantId)
                .query((rs, n) -> Map.entry(rs.getObject("membership_id", UUID.class), rs.getObject("branch_id", UUID.class)))
                .list().forEach(e -> result.computeIfAbsent(e.getKey(), k -> new java.util.ArrayList<>()).add(e.getValue()));
        return result;
    }

    /** Conditional transition. False when the invitation was no longer in {@code from}. */
    public boolean transition(UUID id, String from, String to, Instant now) {
        return jdbc.sql("update staff_invitations set status = :to, updated_at = :now, responded_at = :now where id = :id and status = :from")
                .param("to", to).param("now", Timestamp.from(now)).param("id", id).param("from", from).update() == 1;
    }
}
