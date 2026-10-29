package rw.oupay.inventory;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/**
 * R5c / Flyway V10: the database itself refuses what the service layer should never allow. Rows are written with plain SQL on
 * purpose, bypassing the application, to prove that stock can only change through an immutable stock movement and that a balance
 * can never differ from the sum of its movements.
 */
class InventorySchemaIT extends IntegrationTest {

    static final String SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Autowired
    PlatformTransactionManager transactions;

    World w;
    TransactionTemplate tx;
    UUID rice;
    UUID soda;
    UUID haircut;
    UUID cafeItem;

    @BeforeEach
    void world() {
        w = World.create(this);
        tx = new TransactionTemplate(transactions);
        rice = goodsItem(w.merchantId, "MASS", "g", "kg");
        soda = goodsItem(w.merchantId, "COUNT", "pc", "pc");
        haircut = serviceItem(w.merchantId);
        cafeItem = goodsItem(w.cafeMerchantId, "MASS", "g", "kg");
    }

    // --- catalog fixtures (plain SQL) --------------------------------------------------------------------

    private UUID goodsItem(UUID merchantId, String dimension, String stockUnit, String saleUnit) {
        return item(merchantId, "GOODS", dimension, stockUnit, saleUnit);
    }

    private UUID serviceItem(UUID merchantId) {
        return item(merchantId, "SERVICE", "COUNT", null, "pc");
    }

    private UUID item(UUID merchantId, String type, String dimension, String stockUnit, String saleUnit) {
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> {
            jdbc.update("insert into catalog_items (id, merchant_id, item_type, name, measurement_dimension, stock_unit, sale_unit, "
                    + "price_per_sale_unit_rwf, current_price_version, created_by_user_id, created_at, updated_at) "
                    + "values (?, ?, ?, ?, ?, ?, ?, 100, 1, ?, now(), now())",
                    id, merchantId, type, "Item " + id, dimension, stockUnit, saleUnit, w.ownerPerson.userId());
            jdbc.update("insert into catalog_item_prices (id, item_id, merchant_id, version, price_per_sale_unit_rwf, sale_unit, "
                    + "created_by_user_id, effective_at) values (?, ?, ?, 1, 100, ?, ?, now())",
                    UUID.randomUUID(), id, merchantId, saleUnit, w.ownerPerson.userId());
        });
        return id;
    }

    /** An empty balance, as the application creates it. */
    private void emptyBalance(UUID merchantId, UUID branchId, UUID itemId, String itemType, String dimension) {
        balanceWith(merchantId, branchId, itemId, itemType, dimension, "0");
    }

    private void balanceWith(UUID merchantId, UUID branchId, UUID itemId, String itemType, String dimension, String quantity) {
        jdbc.update("insert into inventory_balances (id, merchant_id, branch_id, item_id, item_type, measurement_dimension, quantity_on_hand, "
                + "created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?::numeric, now(), now())",
                UUID.randomUUID(), merchantId, branchId, itemId, itemType, dimension, quantity);
    }

    private void emptyBalance(UUID itemId, String dimension) {
        emptyBalance(w.merchantId, w.branchId, itemId, "GOODS", dimension);
    }

    private BigDecimal quantity(UUID merchantId, UUID branchId, UUID itemId) {
        return jdbc.queryForObject("select quantity_on_hand from inventory_balances where merchant_id = ? and branch_id = ? and item_id = ?",
                BigDecimal.class, merchantId, branchId, itemId);
    }

    private BigDecimal quantity(UUID itemId) {
        return quantity(w.merchantId, w.branchId, itemId);
    }

    /** A raw movement; the caller supplies balance_after exactly as the application would. */
    private void rawMovement(UUID merchantId, UUID branchId, UUID itemId, String type, String delta, String after, String reason, UUID operation,
                             String sha) {
        jdbc.update("insert into stock_movements (id, merchant_id, branch_id, item_id, movement_type, quantity_delta, balance_after, reason, "
                + "operation_id, request_sha256, actor_user_id, created_at) values (?, ?, ?, ?, ?, ?::numeric, ?::numeric, ?, ?, ?, ?, now())",
                UUID.randomUUID(), merchantId, branchId, itemId, type, delta, after, reason, operation, sha, w.ownerPerson.userId());
    }

    /** A well-formed movement at the shop's branch: balance_after is computed from the current balance. */
    private void move(UUID itemId, String type, String delta) {
        BigDecimal after = quantity(itemId).add(new BigDecimal(delta));
        rawMovement(w.merchantId, w.branchId, itemId, type, delta, after.toPlainString(), type.startsWith("ADJUST") ? "Because" : null,
                UUID.randomUUID(), SHA);
    }

    private long count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Long.class);
    }

    private void assertBalancesMatchHistory() {
        assertThat(jdbc.queryForList("select b.id from inventory_balances b where b.quantity_on_hand <> "
                + "coalesce((select sum(m.quantity_delta) from stock_movements m where m.merchant_id = b.merchant_id "
                + "and m.branch_id = b.branch_id and m.item_id = b.item_id), 0)", UUID.class)).isEmpty();
    }

    // --- migration --------------------------------------------------------------------------------------

    @Test
    void v10AppliedAndIsPurelyAdditive() throws java.io.IOException {
        assertThat(jdbc.queryForList("select version from flyway_schema_history where success order by installed_rank", String.class)).contains("10");
        assertThat(jdbc.queryForList("select tablename from pg_tables where schemaname = 'public' and (tablename like 'inventory\\_%' "
                + "or tablename like 'stock\\_%') order by 1", String.class)).containsExactly("inventory_balances", "stock_movements", "stock_reservation_lines", "stock_reservations");  // the last two arrive with V17 (R7b)
        String sql = new ClassPathResource("db/migration/V10__branch_inventory.sql").getContentAsString(java.nio.charset.StandardCharsets.UTF_8)
                .toLowerCase(java.util.Locale.ROOT);
        assertThat(sql).doesNotContain("drop ").doesNotContain("delete from").doesNotContain("truncate").doesNotContain("insert into")
                .doesNotContain("alter table");
        assertThat(jdbc.queryForList("select tgname from pg_trigger where not tgisinternal and tgrelid in "
                + "('inventory_balances'::regclass, 'stock_movements'::regclass) order by 1", String.class))
                .containsExactly("trg_inventory_balances_identity", "trg_inventory_balances_reserved", "trg_inventory_balances_start_empty", "trg_stock_movements_apply",
                        "trg_stock_movements_immutable");
    }

    @Test
    void quantitiesAreExactDecimalsAndNothingIsAFloat() {
        assertThat(jdbc.queryForList("select table_name || '.' || column_name from information_schema.columns where table_schema = 'public' "
                + "and table_name in ('inventory_balances', 'stock_movements') and data_type in ('double precision', 'real', 'money')",
                String.class)).isEmpty();
        assertThat(jdbc.queryForList("select table_name || '.' || column_name || ':' || numeric_precision || ',' || numeric_scale "
                + "from information_schema.columns where table_schema = 'public' and table_name in ('inventory_balances', 'stock_movements') "
                + "and data_type = 'numeric' order by 1", String.class)).containsExactly("inventory_balances.quantity_on_hand:20,6",
                "stock_movements.balance_after:20,6", "stock_movements.quantity_delta:20,6");
    }

    // --- stock changes only through movements -----------------------------------------------------------

    @Test
    void aBalanceIsBornEmpty() {
        assertThatThrownBy(() -> balanceWith(w.merchantId, w.branchId, rice, "GOODS", "MASS", "5")).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> balanceWith(w.merchantId, w.branchId, rice, "GOODS", "MASS", "0.000001")).isInstanceOf(RuntimeException.class);
        emptyBalance(rice, "MASS");
        assertThat(quantity(rice).signum()).isZero();
        assertThat(count("inventory_balances")).isEqualTo(1);
    }

    @Test
    void aBalanceQuantityCannotBeChangedBySqlOutsideAMovement() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        assertThatThrownBy(() -> jdbc.update("update inventory_balances set quantity_on_hand = 999 where item_id = ?", rice))
                .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update inventory_balances set quantity_on_hand = quantity_on_hand + 1")).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update inventory_balances set quantity_on_hand = 0")).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> jdbc.update("update inventory_balances set quantity_on_hand = 5"))).isInstanceOf(RuntimeException.class);
        assertThat(quantity(rice).toPlainString()).isEqualTo("10.000000");
        assertBalancesMatchHistory();
    }

    @Test
    void insertingAMovementAppliesItToTheBalanceInTheSameStatement() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        assertThat(quantity(rice).toPlainString()).isEqualTo("10.000000");
        move(rice, "RECEIVE", "5.5");
        move(rice, "ADJUST_IN", "0.000001");
        move(rice, "ADJUST_OUT", "-2");
        assertThat(quantity(rice).toPlainString()).isEqualTo("13.500001");
        assertThat(jdbc.queryForObject("select version from inventory_balances where item_id = ?", Long.class, rice)).isEqualTo(4);
        assertThat(count("stock_movements")).isEqualTo(4);
        assertBalancesMatchHistory();
    }

    @Test
    void aMovementMustContinueExactlyFromTheCurrentBalance() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        // A wrong or stale balance_after is refused, and neither the balance nor the history changes.
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "RECEIVE", "5", "16", null, UUID.randomUUID(), SHA))
                .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "RECEIVE", "5", "5", null, UUID.randomUUID(), SHA))
                .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "RECEIVE", "5", "14.999999", null, UUID.randomUUID(), SHA))
                .isInstanceOf(RuntimeException.class);
        assertThat(quantity(rice).toPlainString()).isEqualTo("10.000000");
        assertThat(count("stock_movements")).isEqualTo(1);
        // The same value at another decimal scale is the same number.
        rawMovement(w.merchantId, w.branchId, rice, "RECEIVE", "5.000000", "15", null, UUID.randomUUID(), SHA);
        assertThat(quantity(rice).toPlainString()).isEqualTo("15.000000");
        assertBalancesMatchHistory();
    }

    @Test
    void aMovementCanNeverTakeStockBelowZeroOrBeyondTheRange() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "ADJUST_OUT", "-11", "-1", "Why", UUID.randomUUID(), SHA))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> move(rice, "ADJUST_OUT", "-10.000001")).isInstanceOf(DataAccessException.class);
        move(rice, "ADJUST_OUT", "-10");
        assertThat(quantity(rice).signum()).isZero();
        assertThatThrownBy(() -> move(rice, "ADJUST_OUT", "-0.000001")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "RECEIVE", "100000000000000", "100000000000000", null, UUID.randomUUID(), SHA))
                .isInstanceOf(DataAccessException.class);
        move(rice, "RECEIVE", "99999999999999.999999");
        assertThatThrownBy(() -> move(rice, "RECEIVE", "0.000001")).isInstanceOf(DataAccessException.class);
        assertThat(quantity(rice).toPlainString()).isEqualTo("99999999999999.999999");
        assertBalancesMatchHistory();
    }

    @Test
    void aRolledBackMovementLeavesTheBalanceUntouched() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
            move(rice, "RECEIVE", "5");
            throw new IllegalStateException("fail after the movement");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(quantity(rice).toPlainString()).isEqualTo("10.000000");
        assertThat(count("stock_movements")).isEqualTo(1);
        // A failure of the second of two movements in one transaction takes the first with it.
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
            move(rice, "RECEIVE", "5");
            move(rice, "ADJUST_OUT", "-100");
        })).isInstanceOf(RuntimeException.class);
        assertThat(quantity(rice).toPlainString()).isEqualTo("10.000000");
        assertThat(count("stock_movements")).isEqualTo(1);
        assertBalancesMatchHistory();
    }

    @Test
    void openingStockMustBeTheFirstMovementAndHappenOnce() {
        emptyBalance(rice, "MASS");
        move(rice, "RECEIVE", "3");
        assertThatThrownBy(() -> move(rice, "OPENING", "5")).isInstanceOf(RuntimeException.class);
        emptyBalance(soda, "COUNT");
        move(soda, "OPENING", "5");
        assertThatThrownBy(() -> move(soda, "OPENING", "5")).isInstanceOf(RuntimeException.class);
        assertThat(quantity(rice).toPlainString()).isEqualTo("3.000000");
        assertThat(quantity(soda).toPlainString()).isEqualTo("5.000000");
        assertBalancesMatchHistory();
    }

    // --- goods only, isolation, exactness ---------------------------------------------------------------

    @Test
    void goodsHaveBalancesAndServicesNever() {
        emptyBalance(rice, "MASS");
        assertThatThrownBy(() -> emptyBalance(w.merchantId, w.branchId, haircut, "SERVICE", "COUNT")).isInstanceOf(DataAccessException.class);
        // Dressing a service up as goods does not help: the item key includes its real type.
        assertThatThrownBy(() -> emptyBalance(w.merchantId, w.branchId, haircut, "GOODS", "COUNT")).isInstanceOf(DataAccessException.class);
        assertThat(count("inventory_balances")).isEqualTo(1);
    }

    @Test
    void aBalanceCannotJoinAnotherBusinessesBranchAndItem() {
        assertThatThrownBy(() -> emptyBalance(w.merchantId, w.cafeBranchId, rice, "GOODS", "MASS")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> emptyBalance(w.merchantId, w.branchId, cafeItem, "GOODS", "MASS")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> emptyBalance(w.cafeMerchantId, w.branchId, cafeItem, "GOODS", "MASS")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> emptyBalance(w.cafeMerchantId, w.cafeBranchId, rice, "GOODS", "MASS")).isInstanceOf(DataAccessException.class);
        emptyBalance(w.cafeMerchantId, w.cafeBranchId, cafeItem, "GOODS", "MASS");
        assertThat(count("inventory_balances")).isEqualTo(1);
    }

    @Test
    void aBalanceHasTheItemsDimensionIsUniqueAndHoldsWholePiecesForCounts() {
        assertThatThrownBy(() -> emptyBalance(w.merchantId, w.branchId, rice, "GOODS", "VOLUME")).isInstanceOf(DataAccessException.class);
        emptyBalance(rice, "MASS");
        assertThatThrownBy(() -> emptyBalance(rice, "MASS")).isInstanceOf(DataAccessException.class);
        // The same item at another branch is its own balance.
        UUID second = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        emptyBalance(w.merchantId, second, rice, "GOODS", "MASS");
        // Discrete goods never hold a fraction of a piece.
        emptyBalance(soda, "COUNT");
        assertThatThrownBy(() -> move(soda, "RECEIVE", "1.5")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> move(soda, "RECEIVE", "0.000001")).isInstanceOf(DataAccessException.class);
        move(soda, "RECEIVE", "24");
        assertThat(quantity(soda).toPlainString()).isEqualTo("24.000000");
    }

    @Test
    void aBalanceCannotBeMovedToAnotherBranchOrItem() {
        emptyBalance(rice, "MASS");
        UUID second = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        assertThatThrownBy(() -> jdbc.update("update inventory_balances set branch_id = ? where item_id = ?", second, rice))
                .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update inventory_balances set item_id = ? where item_id = ?", soda, rice)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void catalogItemsAndBranchesWithStockCannotBeRemovedFromUnderneathIt() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "5");
        assertThatThrownBy(() -> jdbc.update("delete from catalog_items where id = ?", rice)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("delete from branches where id = ?", w.branchId)).isInstanceOf(DataAccessException.class);
        // And what an item is cannot change under its stock (the V9 trigger).
        assertThatThrownBy(() -> jdbc.update("update catalog_items set measurement_dimension = 'VOLUME' where id = ?", rice))
                .isInstanceOf(RuntimeException.class);
    }

    // --- movement shape ---------------------------------------------------------------------------------

    @Test
    void movementsFollowTheirSignRulesAndNeedABalance() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        move(rice, "RECEIVE", "5");
        move(rice, "ADJUST_IN", "1");
        move(rice, "ADJUST_OUT", "-2");
        assertThatThrownBy(() -> move(rice, "RECEIVE", "-5")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> move(rice, "ADJUST_OUT", "2")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> move(rice, "ADJUST_IN", "-2")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> move(rice, "RECEIVE", "0")).isInstanceOf(DataAccessException.class);
        // Types that are not implemented yet cannot be written.
        for (String later : new String[] {"RESERVE", "RELEASE", "SALE", "RETURN", "CORRECTION", "ADJUST", "receive"}) {
            assertThatThrownBy(() -> move(rice, later, "1")).as(later).isInstanceOf(DataAccessException.class);
        }
        // A movement needs the balance of its own business, branch and item.
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, soda, "RECEIVE", "1", "1", null, UUID.randomUUID(), SHA))
                .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> rawMovement(w.cafeMerchantId, w.branchId, rice, "RECEIVE", "1", "1", null, UUID.randomUUID(), SHA))
                .isInstanceOf(RuntimeException.class);
        assertThat(count("stock_movements")).isEqualTo(4);
        assertThat(quantity(rice).toPlainString()).isEqualTo("14.000000");
        assertBalancesMatchHistory();
    }

    @Test
    void adjustmentsNeedAReasonAndTheHashMustBeWellFormed() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "ADJUST_OUT", "-1", "9", null, UUID.randomUUID(), SHA))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "ADJUST_IN", "1", "11", "   ", UUID.randomUUID(), SHA))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "RECEIVE", "1", "11", "   ", UUID.randomUUID(), SHA))
                .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "RECEIVE", "1", "11", null, UUID.randomUUID(), "not-a-hash"))
                .isInstanceOf(DataAccessException.class);
        rawMovement(w.merchantId, w.branchId, rice, "ADJUST_OUT", "-1", "9", "Spilled", UUID.randomUUID(), SHA);
        assertThat(quantity(rice).toPlainString()).isEqualTo("9.000000");
    }

    @Test
    void anOperationIdIsUniquePerBusiness() {
        emptyBalance(rice, "MASS");
        UUID operation = UUID.randomUUID();
        rawMovement(w.merchantId, w.branchId, rice, "OPENING", "10", "10", null, operation, SHA);
        assertThatThrownBy(() -> rawMovement(w.merchantId, w.branchId, rice, "RECEIVE", "1", "11", null, operation, SHA))
                .isInstanceOf(DataAccessException.class);
        assertThat(quantity(rice).toPlainString()).isEqualTo("10.000000");
        // Another business may use the same operation id.
        emptyBalance(w.cafeMerchantId, w.cafeBranchId, cafeItem, "GOODS", "MASS");
        rawMovement(w.cafeMerchantId, w.cafeBranchId, cafeItem, "OPENING", "1", "1", null, operation, SHA);
        assertThat(count("stock_movements")).isEqualTo(2);
    }

    // --- immutable history, accountability --------------------------------------------------------------

    @Test
    void movementsAreImmutableAndCannotBeDeleted() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        assertThatThrownBy(() -> jdbc.update("update stock_movements set quantity_delta = 99, balance_after = 99")).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update stock_movements set reason = 'edited'")).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("update stock_movements set operation_id = gen_random_uuid()")).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("delete from stock_movements")).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("select quantity_delta::text from stock_movements", String.class)).isEqualTo("10.000000");
        assertThat(quantity(rice).toPlainString()).isEqualTo("10.000000");
    }

    @Test
    void aBalanceWithHistoryCannotBeDeleted() {
        emptyBalance(rice, "MASS");
        move(rice, "OPENING", "10");
        assertThatThrownBy(() -> jdbc.update("delete from inventory_balances")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("delete from inventory_balances where item_id = ?", rice)).isInstanceOf(DataAccessException.class);
        // Even when the stock has gone back to zero, the history stays accountable to its balance.
        move(rice, "ADJUST_OUT", "-10");
        assertThatThrownBy(() -> jdbc.update("delete from inventory_balances where item_id = ?", rice)).isInstanceOf(DataAccessException.class);
        assertThat(count("inventory_balances")).isEqualTo(1);
        assertThat(count("stock_movements")).isEqualTo(2);
    }

    @Test
    void anEmptyBalanceWithNoHistoryHasNothingToAccountForAndMayBeRemoved() {
        emptyBalance(rice, "MASS");
        assertThat(jdbc.update("delete from inventory_balances where item_id = ?", rice)).isEqualTo(1);
    }

    @Test
    void everyBalanceEqualsItsHistoryAfterManyMixedMovements() {
        emptyBalance(rice, "MASS");
        emptyBalance(soda, "COUNT");
        move(rice, "OPENING", "100");
        move(soda, "OPENING", "48");
        for (int i = 0; i < 20; i++) {
            move(rice, i % 3 == 0 ? "ADJUST_OUT" : "RECEIVE", i % 3 == 0 ? "-1.25" : "2.5");
            move(soda, i % 4 == 0 ? "ADJUST_OUT" : "RECEIVE", i % 4 == 0 ? "-2" : "3");
        }
        assertBalancesMatchHistory();
        assertThat(jdbc.queryForList("select b.id from inventory_balances b where b.quantity_on_hand <> (select m.balance_after from stock_movements m "
                + "where m.merchant_id = b.merchant_id and m.branch_id = b.branch_id and m.item_id = b.item_id order by m.created_at desc, m.id desc limit 1)",
                UUID.class)).isEmpty();
    }
}
