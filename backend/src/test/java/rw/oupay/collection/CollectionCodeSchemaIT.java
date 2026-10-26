package rw.oupay.collection;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataAccessException;
import rw.oupay.support.Bank;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/**
 * R6a / Flyway V11: the database itself refuses what the service layer should never allow. Rows are written and changed with plain SQL
 * on purpose, bypassing the application, to prove the registry's guarantees hold whatever code runs.
 */
class CollectionCodeSchemaIT extends IntegrationTest {

    static final String SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    World w;
    UUID destination;
    UUID cafeDestination;
    UUID maker;
    UUID checker;

    @BeforeEach
    void world() {
        w = World.create(this);
        Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        destination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
        cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        maker = w.ownerPerson.userId();
        checker = w.managerPerson.userId();
    }

    // --- helpers (plain SQL) ----------------------------------------------------------------------------

    private static final String REF_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

    private static String ref(int n) {
        StringBuilder sb = new StringBuilder("CC-");
        int v = n;
        for (int i = 0; i < 8; i++) {
            sb.append(REF_CHARS.charAt(v % REF_CHARS.length()));
            v = v / REF_CHARS.length() + 7;
        }
        return sb.toString();
    }

    private int counter;

    private UUID code(UUID merchantId, UUID destinationId, String provider, UUID branchId) {
        UUID id = UUID.randomUUID();
        counter++;
        jdbc.update("insert into collection_codes (id, merchant_id, provider_id, settlement_destination_id, is_simulated, internal_ref, display_label, "
                + "branch_id, status, client_request_id, request_sha256, created_by_user_id, created_at, updated_at) "
                + "values (?, ?, ?, ?, true, ?, 'Label', ?, 'REQUESTED', ?, ?, ?, now(), now())",
                id, merchantId, provider, destinationId, ref(counter * 977), branchId, UUID.randomUUID(), SHA, maker);
        return id;
    }

    private UUID code() {
        return code(w.merchantId, destination, "EQUITY_MOCK", w.branchId);
    }

    private void pending(UUID id) {
        jdbc.update("update collection_codes set status = 'REQUEST_DECLARED', bank_request_ref = 'EQ-1', bank_request_recorded_at = now() where id = ?", id);
    }

    private void approve(UUID id, String external) {
        jdbc.update("update collection_codes set status = 'ACTIVE', external_code = ?, approval_source = 'OPERATOR', approval_evidence_ref = 'EV-1', "
                + "approval_recorded_by_user_id = ?, approval_checked_by_user_id = ?, approved_at = now() where id = ?", external, maker, checker, id);
    }

    private UUID activeCode(String external) {
        UUID id = code();
        pending(id);
        approve(id, external);
        return id;
    }

    private String status(UUID id) {
        return jdbc.queryForObject("select status from collection_codes where id = ?", String.class, id);
    }

    private void assignMember(UUID codeId, UUID membershipId, UUID userId, String validFrom) {
        assignMember(codeId, membershipId, userId, validFrom, w.branchId);
    }

    private void assignMember(UUID codeId, UUID membershipId, UUID userId, String validFrom, UUID branchId) {
        jdbc.update("insert into collection_code_assignments (id, code_id, merchant_id, branch_id, assignee_kind, membership_id, assignee_user_id, assignee_name, "
                + "assignee_role, valid_from, assigned_by_user_id, assigned_by_name, created_at) "
                + "values (?, ?, ?, ?, 'MEMBER', ?, ?, 'Agent', 'CASHIER', ?::timestamptz, ?, 'Owner', now())",
                UUID.randomUUID(), codeId, w.merchantId, branchId, membershipId, userId, validFrom, maker);
    }

    private void assignPoint(UUID codeId, String label, String validFrom) {
        assignPoint(codeId, label, validFrom, w.branchId);
    }

    private void assignPoint(UUID codeId, String label, String validFrom, UUID branchId) {
        jdbc.update("insert into collection_code_assignments (id, code_id, merchant_id, branch_id, assignee_kind, collection_point_label, assignee_name, valid_from, "
                + "assigned_by_user_id, assigned_by_name, created_at) values (?, ?, ?, ?, 'COLLECTION_POINT', ?, ?, ?::timestamptz, ?, 'Owner', now())",
                UUID.randomUUID(), codeId, w.merchantId, branchId, label, label, validFrom, maker);
    }

    private long count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Long.class);
    }

    // --- migration --------------------------------------------------------------------------------------

    @Test
    void v11AppliedAndOnlyAddsTheRegistry() throws java.io.IOException {
        assertThat(jdbc.queryForList("select version from flyway_schema_history where success order by installed_rank", String.class)).contains("11");
        assertThat(jdbc.queryForList("select tablename from pg_tables where schemaname = 'public' and tablename like 'collection\\_%' order by 1",
                String.class)).containsExactly("collection_code_assignments", "collection_codes");
        String sql = new ClassPathResource("db/migration/V11__collection_codes.sql").getContentAsString(java.nio.charset.StandardCharsets.UTF_8)
                .toLowerCase(java.util.Locale.ROOT);
        assertThat(sql).doesNotContain("drop ").doesNotContain("delete from").doesNotContain("truncate").doesNotContain("insert into")
                .doesNotContain("alter table invoice").doesNotContain("alter table bank_").doesNotContain("alter table merchants");
        // The single change to an existing table is one added unique key on payment_destinations.
        assertThat(sql.indexOf("alter table")).isEqualTo(sql.lastIndexOf("alter table"));
        assertThat(sql).contains("alter table payment_destinations");
    }

    // --- tenant scoping ---------------------------------------------------------------------------------

    @Test
    void aCodeBelongsToTheSettlementAccountOfItsOwnMerchantAndProvider() {
        code();
        assertThatThrownBy(() -> code(w.merchantId, cafeDestination, "EQUITY_MOCK", null)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> code(w.cafeMerchantId, destination, "EQUITY_MOCK", null)).isInstanceOf(DataAccessException.class);
        // The provider must be the account's own, and one of the known providers.
        assertThatThrownBy(() -> code(w.merchantId, destination, "MTN_MOMO", null)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> code(w.merchantId, destination, "EQUITY_RW", null)).isInstanceOf(DataAccessException.class);
        // A branch of another business.
        assertThatThrownBy(() -> code(w.merchantId, destination, "EQUITY_MOCK", w.cafeBranchId)).isInstanceOf(DataAccessException.class);
        code(w.cafeMerchantId, cafeDestination, "EQUITY_MOCK", w.cafeBranchId);
        assertThat(count("collection_codes")).isEqualTo(2);
    }

    @Test
    void anInternalReferenceIsWellFormedAndUnique() {
        UUID first = code();
        String existing = jdbc.queryForObject("select internal_ref from collection_codes where id = ?", String.class, first);
        assertThat(existing).matches("CC-[2-9A-HJKMNP-Z]{8}");
        for (String bad : new String[] {"CC-1234567", "TILL-0001", "cc-ABCDEFGH", "CC-ABCDEFGI", "CC-0BCDEFGH"}) {
            assertThatThrownBy(() -> jdbc.update("update collection_codes set internal_ref = ? where id = ?", bad, first)).as(bad).isInstanceOf(RuntimeException.class);
        }
        assertThatThrownBy(() -> jdbc.update("insert into collection_codes (id, merchant_id, provider_id, settlement_destination_id, is_simulated, internal_ref, "
                + "display_label, status, client_request_id, request_sha256, created_by_user_id, created_at, updated_at) "
                + "values (?, ?, 'EQUITY_MOCK', ?, true, ?, 'Dup', 'REQUESTED', ?, ?, ?, now(), now())",
                UUID.randomUUID(), w.merchantId, destination, existing, UUID.randomUUID(), SHA, maker)).isInstanceOf(DataAccessException.class);
    }

    @Test
    void aClientRequestIdIsUniquePerBusinessOnly() {
        UUID request = UUID.randomUUID();
        jdbc.update("insert into collection_codes (id, merchant_id, provider_id, settlement_destination_id, is_simulated, internal_ref, display_label, status, "
                + "client_request_id, request_sha256, created_by_user_id, created_at, updated_at) values (?, ?, 'EQUITY_MOCK', ?, true, ?, 'A', 'REQUESTED', ?, ?, ?, now(), now())",
                UUID.randomUUID(), w.merchantId, destination, ref(11), request, SHA, maker);
        assertThatThrownBy(() -> jdbc.update("insert into collection_codes (id, merchant_id, provider_id, settlement_destination_id, is_simulated, internal_ref, "
                + "display_label, status, client_request_id, request_sha256, created_by_user_id, created_at, updated_at) values (?, ?, 'EQUITY_MOCK', ?, true, ?, 'B', "
                + "'REQUESTED', ?, ?, ?, now(), now())", UUID.randomUUID(), w.merchantId, destination, ref(12), request, SHA, maker)).isInstanceOf(DataAccessException.class);
        jdbc.update("insert into collection_codes (id, merchant_id, provider_id, settlement_destination_id, is_simulated, internal_ref, display_label, status, "
                + "client_request_id, request_sha256, created_by_user_id, created_at, updated_at) values (?, ?, 'EQUITY_MOCK', ?, true, ?, 'C', 'REQUESTED', ?, ?, ?, now(), now())",
                UUID.randomUUID(), w.cafeMerchantId, cafeDestination, ref(13), request, SHA, maker);
    }

    // --- approval evidence ------------------------------------------------------------------------------

    @Test
    void aCodeCannotBeActiveWithoutABankIssuedCodeAndRecordedEvidence() {
        UUID id = code();
        pending(id);
        // Activating by status alone, or with partial evidence, is refused.
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'ACTIVE' where id = ?", id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'ACTIVE', external_code = 'TILL-1' where id = ?", id))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'ACTIVE', external_code = 'TILL-1', approval_source = 'OPERATOR', "
                + "approval_evidence_ref = 'EV', approved_at = now() where id = ?", id)).isInstanceOf(DataAccessException.class);
        // An operator approval needs TWO DIFFERENT people.
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'ACTIVE', external_code = 'TILL-1', approval_source = 'OPERATOR', "
                + "approval_evidence_ref = 'EV', approval_recorded_by_user_id = ?, approval_checked_by_user_id = ?, approved_at = now() where id = ?",
                maker, maker, id)).isInstanceOf(DataAccessException.class);
        // Blank evidence, an unknown source, a code equal to the internal reference.
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'ACTIVE', external_code = 'TILL-1', approval_source = 'OPERATOR', "
                + "approval_evidence_ref = '  ', approval_recorded_by_user_id = ?, approval_checked_by_user_id = ?, approved_at = now() where id = ?",
                maker, checker, id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'ACTIVE', external_code = 'TILL-1', approval_source = 'WEBFORM', "
                + "approval_evidence_ref = 'EV', approved_at = now() where id = ?", id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'ACTIVE', external_code = internal_ref, approval_source = 'OPERATOR', "
                + "approval_evidence_ref = 'EV', approval_recorded_by_user_id = ?, approval_checked_by_user_id = ?, approved_at = now() where id = ?",
                maker, checker, id)).isInstanceOf(DataAccessException.class);
        assertThat(status(id)).isEqualTo("REQUEST_DECLARED");
        // Complete operator evidence works, and so does a bank event with no person.
        approve(id, "TILL-1");
        assertThat(status(id)).isEqualTo("ACTIVE");
        UUID byEvent = code();
        pending(byEvent);
        jdbc.update("update collection_codes set status = 'ACTIVE', external_code = 'TILL-2', approval_source = 'BANK_EVENT', approval_evidence_ref = 'EVT-9', "
                + "approved_at = now() where id = ?", byEvent);
        assertThat(status(byEvent)).isEqualTo("ACTIVE");
    }

    @Test
    void evidenceExistsExactlyWhenTheBankIssuedCodeExistsAndPendingNeedsARequest() {
        UUID id = code();
        assertThatThrownBy(() -> jdbc.update("update collection_codes set external_code = 'TILL-1' where id = ?", id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set approval_source = 'OPERATOR', approval_evidence_ref = 'EV', approved_at = now() where id = ?", id))
                .isInstanceOf(DataAccessException.class);
        // REQUEST_DECLARED only because a request to the bank was recorded.
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'REQUEST_DECLARED' where id = ?", id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'REQUEST_DECLARED', bank_request_ref = '  ', bank_request_recorded_at = now() where id = ?", id))
                .isInstanceOf(DataAccessException.class);
        pending(id);
        // A bank-issued code of a SUSPENDED or ACTIVE row can never be missing.
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'SUSPENDED', status_reason = 'x' where id = ?", id)).isInstanceOf(RuntimeException.class);
    }

    // --- reservation of bank-issued codes ---------------------------------------------------------------

    @Test
    void aBankIssuedCodeBelongsToOneCodeInItsProviderNamespaceForEver() {
        UUID first = activeCode("TILL-7");
        UUID second = code();
        pending(second);
        assertThatThrownBy(() -> approve(second, "TILL-7")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> approve(second, "till-7")).as("case-insensitive").isInstanceOf(DataAccessException.class);
        // Another merchant of the same provider cannot take it either.
        UUID cafe = code(w.cafeMerchantId, cafeDestination, "EQUITY_MOCK", null);
        jdbc.update("update collection_codes set status = 'REQUEST_DECLARED', bank_request_ref = 'EQ-C', bank_request_recorded_at = now() where id = ?", cafe);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'ACTIVE', external_code = 'TILL-7', approval_source = 'BANK_EVENT', "
                + "approval_evidence_ref = 'EVT', approved_at = now() where id = ?", cafe)).isInstanceOf(DataAccessException.class);
        // Deactivation does not release it: the identity stays reserved.
        jdbc.update("update collection_codes set status = 'DEACTIVATED', status_reason = 'Closed' where id = ?", first);
        assertThatThrownBy(() -> approve(second, "TILL-7")).isInstanceOf(DataAccessException.class);
        assertThat(jdbc.queryForObject("select count(*) from collection_codes where upper(external_code) = 'TILL-7'", Long.class)).isEqualTo(1);
    }

    // --- identity and lifecycle -------------------------------------------------------------------------

    @Test
    void theIdentityOfACodeAndTheBankIssuedCodeNeverChange() {
        UUID id = activeCode("TILL-8");
        for (String change : new String[] {"merchant_id = '" + w.cafeMerchantId + "'", "settlement_destination_id = '" + cafeDestination + "'",
                "provider_id = 'MTN_MOMO'", "internal_ref = 'CC-ZZZZZZZZ'", "is_simulated = false", "client_request_id = gen_random_uuid()",
                "created_at = now() - interval '1 day'", "created_by_user_id = '" + checker + "'"}) {
            assertThatThrownBy(() -> jdbc.update("update collection_codes set " + change + " where id = ?", id)).as(change).isInstanceOf(RuntimeException.class);
        }
        for (String change : new String[] {"external_code = 'TILL-9'", "approval_evidence_ref = 'OTHER'", "approval_source = 'BANK_EVENT'",
                "approved_at = now() + interval '1 day'", "approval_recorded_by_user_id = '" + checker + "', approval_checked_by_user_id = '" + maker + "'"}) {
            assertThatThrownBy(() -> jdbc.update("update collection_codes set " + change + " where id = ?", id)).as(change).isInstanceOf(RuntimeException.class);
        }
        // The label and the status may change; the rest stays.
        jdbc.update("update collection_codes set display_label = 'Renamed' where id = ?", id);
        assertThat(jdbc.queryForObject("select external_code from collection_codes where id = ?", String.class, id)).isEqualTo("TILL-8");
    }

    @Test
    void onlyLegalLifecycleStepsAreAllowedAndFinalStatesAreFinal() {
        UUID id = code();
        assertThatThrownBy(() -> approve(id, "TILL-1")).as("REQUESTED -> ACTIVE").isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'SUSPENDED', status_reason = 'x' where id = ?", id)).isInstanceOf(RuntimeException.class);
        pending(id);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'REQUESTED' where id = ?", id)).as("backwards").isInstanceOf(RuntimeException.class);
        approve(id, "TILL-1");
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'REQUEST_DECLARED' where id = ?", id)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'REJECTED', status_reason = 'x' where id = ?", id)).isInstanceOf(RuntimeException.class);
        jdbc.update("update collection_codes set status = 'SUSPENDED', status_reason = 'Paused' where id = ?", id);
        jdbc.update("update collection_codes set status = 'ACTIVE', status_reason = null where id = ?", id);
        jdbc.update("update collection_codes set status = 'DEACTIVATED', status_reason = 'Closed' where id = ?", id);
        for (String target : new String[] {"ACTIVE", "SUSPENDED", "REQUESTED", "REQUEST_DECLARED", "REJECTED"}) {
            assertThatThrownBy(() -> jdbc.update("update collection_codes set status = ?, status_reason = 'x' where id = ?", target, id)).as(target).isInstanceOf(RuntimeException.class);
        }
        // A reason is required for suspension, deactivation and rejection.
        UUID other = code();
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'DEACTIVATED' where id = ?", other)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'REJECTED', status_reason = '  ' where id = ?", other)).isInstanceOf(DataAccessException.class);
        jdbc.update("update collection_codes set status = 'REJECTED', status_reason = 'Declined' where id = ?", other);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'REQUEST_DECLARED', bank_request_ref = 'EQ', bank_request_recorded_at = now() where id = ?", other))
                .isInstanceOf(RuntimeException.class);
    }

    @Test
    void codesAreNeverDeleted() {
        UUID id = code();
        assertThatThrownBy(() -> jdbc.update("delete from collection_codes where id = ?", id)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("delete from collection_codes")).isInstanceOf(RuntimeException.class);
        assertThat(count("collection_codes")).isEqualTo(1);
    }

    // --- assignments ------------------------------------------------------------------------------------

    @Test
    void aCodeHasAtMostOneOpenAssignmentAndPeriodsNeverOverlap() {
        UUID id = code();
        assignMember(id, w.cashierMembershipId, w.cashierPerson.userId(), "2026-01-01T10:00:00Z");
        assertThatThrownBy(() -> assignPoint(id, "Second", "2026-01-02T10:00:00Z")).as("second open").isInstanceOf(DataAccessException.class);
        // Ending it, then a new one that starts before the end, overlaps and is refused; one starting at the end is fine.
        jdbc.update("update collection_code_assignments set valid_to = '2026-01-05T10:00:00Z', ended_by_user_id = ?, ended_by_name = 'Owner', end_reason = 'Shift' where code_id = ?",
                maker, id);
        assertThatThrownBy(() -> assignPoint(id, "Overlap", "2026-01-04T10:00:00Z")).as("overlap").isInstanceOf(RuntimeException.class);
        assignPoint(id, "Next", "2026-01-05T10:00:00Z");
        assertThat(count("collection_code_assignments")).isEqualTo(2);
        // Two different codes can be open at the same time for the same person.
        UUID other = code();
        assignMember(other, w.cashierMembershipId, w.cashierPerson.userId(), "2026-01-01T10:00:00Z");
    }

    @Test
    void anAssignmentNeedsAnActiveMemberOfTheSameBusinessAndAUsableCode() {
        UUID id = code();
        for (String status : new String[] {"SUSPENDED", "REVOKED", "INVITED"}) {
            jdbc.update("update memberships set status = ? where id = ?", status, w.cashierMembershipId);
            assertThatThrownBy(() -> assignMember(id, w.cashierMembershipId, w.cashierPerson.userId(), "2026-01-01T10:00:00Z")).as(status)
                    .isInstanceOf(RuntimeException.class);
        }
        jdbc.update("update memberships set status = 'ACTIVE' where id = ?", w.cashierMembershipId);
        // A membership of another business, or a user that is not the membership's.
        UUID cafeMembership = jdbc.queryForObject("select id from memberships where merchant_id = ?", UUID.class, w.cafeMerchantId);
        assertThatThrownBy(() -> assignMember(id, cafeMembership, w.cashierPerson.userId(), "2026-01-01T10:00:00Z")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> assignMember(id, w.cashierMembershipId, w.managerPerson.userId(), "2026-01-01T10:00:00Z")).isInstanceOf(RuntimeException.class);
        // A deactivated, rejected or suspended code cannot be assigned.
        pending(id);
        approve(id, "TILL-A");
        jdbc.update("update collection_codes set status = 'SUSPENDED', status_reason = 'x' where id = ?", id);
        assertThatThrownBy(() -> assignPoint(id, "Suspended", "2026-01-01T10:00:00Z")).isInstanceOf(RuntimeException.class);
        jdbc.update("update collection_codes set status = 'DEACTIVATED', status_reason = 'x' where id = ?", id);
        assertThatThrownBy(() -> assignPoint(id, "Gone", "2026-01-01T10:00:00Z")).isInstanceOf(RuntimeException.class);
        assertThat(count("collection_code_assignments")).isZero();
    }

    @Test
    void anAssignmentIsOfAMemberOrACollectionPointNeverBothOrNeither() {
        UUID id = code();
        assertThatThrownBy(() -> jdbc.update("insert into collection_code_assignments (id, code_id, merchant_id, assignee_kind, membership_id, assignee_user_id, "
                + "collection_point_label, assignee_name, assignee_role, valid_from, assigned_by_user_id, assigned_by_name, created_at) "
                + "values (?, ?, ?, 'MEMBER', ?, ?, 'Both', 'x', 'CASHIER', now(), ?, 'o', now())", UUID.randomUUID(), id, w.merchantId,
                w.cashierMembershipId, w.cashierPerson.userId(), maker)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("insert into collection_code_assignments (id, code_id, merchant_id, assignee_kind, assignee_name, valid_from, "
                + "assigned_by_user_id, assigned_by_name, created_at) values (?, ?, ?, 'COLLECTION_POINT', 'x', now(), ?, 'o', now())",
                UUID.randomUUID(), id, w.merchantId, maker)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> assignPoint(id, "   ", "2026-01-01T10:00:00Z")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("insert into collection_code_assignments (id, code_id, merchant_id, assignee_kind, membership_id, assignee_user_id, "
                + "assignee_name, valid_from, assigned_by_user_id, assigned_by_name, created_at) values (?, ?, ?, 'MEMBER', ?, ?, 'x', now(), ?, 'o', now())",
                UUID.randomUUID(), id, w.merchantId, w.cashierMembershipId, w.cashierPerson.userId(), maker)).as("member without a role snapshot")
                .isInstanceOf(DataAccessException.class);
    }

    @Test
    void anAssignmentCanOnlyBeEndedOnceAndNeverRewrittenOrDeleted() {
        UUID id = code();
        assignMember(id, w.cashierMembershipId, w.cashierPerson.userId(), "2026-01-01T10:00:00Z");
        for (String change : new String[] {"assignee_name = 'Someone else'", "assignee_role = 'OWNER'", "branch_name = 'Elsewhere'", "valid_from = valid_from + interval '1 day'",
                "assigned_by_name = 'x'", "membership_id = null", "code_id = gen_random_uuid()", "collection_point_label = 'x'"}) {
            assertThatThrownBy(() -> jdbc.update("update collection_code_assignments set " + change)).as(change).isInstanceOf(RuntimeException.class);
        }
        assertThatThrownBy(() -> jdbc.update("update collection_code_assignments set valid_to = valid_from - interval '1 day', ended_by_name = 'o', end_reason = 'x'"))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_code_assignments set valid_to = '2026-02-01T10:00:00Z'")).as("end without who and why")
                .isInstanceOf(DataAccessException.class);
        jdbc.update("update collection_code_assignments set valid_to = '2026-02-01T10:00:00Z', ended_by_user_id = ?, ended_by_name = 'Owner', end_reason = 'Shift'", maker);
        // Ended once: nothing may change again, and it can never be reopened or deleted.
        assertThatThrownBy(() -> jdbc.update("update collection_code_assignments set end_reason = 'Edited'")).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_code_assignments set valid_to = null, ended_by_user_id = null, ended_by_name = null, end_reason = null"))
                .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("delete from collection_code_assignments")).isInstanceOf(RuntimeException.class);
        assertThat(count("collection_code_assignments")).isEqualTo(1);
    }

    @Test
    void aSystemProcessMayEndAnAssignmentWithoutAPerson() {
        UUID id = code();
        assignPoint(id, "Stall", "2026-01-01T10:00:00Z");
        jdbc.update("update collection_code_assignments set valid_to = '2026-01-02T10:00:00Z', ended_by_name = 'Bank process', end_reason = 'Code rejected'");
        assertThat(jdbc.queryForObject("select ended_by_user_id from collection_code_assignments", UUID.class)).isNull();
    }

    @Test
    void aCodeWithAnOpenAssignmentCannotBeDeactivatedOrRejectedUntilItIsEnded() {
        UUID id = code();
        assignPoint(id, "Stall", "2026-01-01T10:00:00Z");
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'DEACTIVATED', status_reason = 'x' where id = ?", id)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set status = 'REJECTED', status_reason = 'x' where id = ?", id)).isInstanceOf(RuntimeException.class);
        jdbc.update("update collection_code_assignments set valid_to = '2026-01-02T10:00:00Z', ended_by_name = 'Owner', end_reason = 'Closing'");
        jdbc.update("update collection_codes set status = 'DEACTIVATED', status_reason = 'x' where id = ?", id);
        assertThat(status(id)).isEqualTo("DEACTIVATED");
        assertThat(count("collection_code_assignments")).isEqualTo(1);
    }

    @Test
    void anAssignmentFollowsTheBranchRulesInTheDatabaseToo() {
        UUID second = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        // A code of a branch is only ever assigned at that branch.
        UUID atBranch = code();
        assertThatThrownBy(() -> assignPoint(atBranch, "Wrong branch", "2026-01-01T10:00:00Z", second)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> assignPoint(atBranch, "No branch", "2026-01-01T10:00:00Z", null)).isInstanceOf(RuntimeException.class);
        // A branchless code may be assigned at an active branch, never at an inactive one or another business's.
        UUID branchless = code(w.merchantId, destination, "EQUITY_MOCK", null);
        assertThatThrownBy(() -> assignPoint(branchless, "Closed shop", "2026-01-01T10:00:00Z", w.inactiveBranchId)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> assignPoint(branchless, "Foreign", "2026-01-01T10:00:00Z", w.cafeBranchId)).isInstanceOf(DataAccessException.class);
        // A member must be actively assigned to the branch (the cashier works at RM01 only).
        assertThatThrownBy(() -> assignMember(branchless, w.cashierMembershipId, w.cashierPerson.userId(), "2026-01-01T10:00:00Z", second))
                .isInstanceOf(RuntimeException.class);
        assignMember(branchless, w.cashierMembershipId, w.cashierPerson.userId(), "2026-01-01T10:00:00Z", w.branchId);
        assignPoint(atBranch, "Right branch", "2026-01-01T10:00:00Z", w.branchId);
        assertThat(count("collection_code_assignments")).isEqualTo(2);
    }

    @Test
    void aRecordedBankRequestReferenceNeverChanges() {
        UUID id = code();
        pending(id);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set bank_request_ref = 'OTHER' where id = ?", id)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update collection_codes set bank_request_recorded_at = now() + interval '1 day' where id = ?", id))
                .isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("select bank_request_ref from collection_codes where id = ?", String.class, id)).isEqualTo("EQ-1");
        // A declared request is never an approval: REQUEST_DECLARED carries no bank-issued code and no evidence.
        assertThat(jdbc.queryForObject("select external_code is null and approval_source is null and approved_at is null from collection_codes where id = ?",
                Boolean.class, id)).isTrue();
    }

    @Test
    void historyOfACodeStaysAccountableToIt() {
        UUID id = code();
        assignPoint(id, "Stall", "2026-01-01T10:00:00Z");
        assertThatThrownBy(() -> jdbc.update("delete from collection_codes where id = ?", id)).isInstanceOf(RuntimeException.class);
        // Not even a branch or a merchant with history can be removed from under it.
        UUID branchCode = code();
        assertThatThrownBy(() -> jdbc.update("delete from branches where id = ?", w.branchId)).isInstanceOf(DataAccessException.class);
        assertThat(count("collection_codes")).isEqualTo(2);
        assertThat(branchCode).isNotNull();
    }
}
