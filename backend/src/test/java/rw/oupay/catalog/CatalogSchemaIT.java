package rw.oupay.catalog;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
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
 * R5b / Flyway V9: the database itself refuses what the service layer should never allow, so a bug or a lost race can never
 * leave an inconsistent catalog. Rows are written with plain SQL on purpose, bypassing the application.
 */
class CatalogSchemaIT extends IntegrationTest {

    @Autowired
    PlatformTransactionManager transactions;

    World w;
    TransactionTemplate tx;

    @BeforeEach
    void world() {
        w = World.create(this);
        tx = new TransactionTemplate(transactions);
    }

    private void insertItem(UUID id, UUID merchantId, String type, String name, String code, String dimension, String stockUnit,
                            String saleUnit, long price, int priceVersion) {
        jdbc.update("insert into catalog_items (id, merchant_id, item_type, name, code, measurement_dimension, stock_unit, sale_unit, "
                + "price_per_sale_unit_rwf, current_price_version, created_by_user_id, created_at, updated_at) "
                + "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now())",
                id, merchantId, type, name, code, dimension, stockUnit, saleUnit, price, priceVersion, w.ownerPerson.userId());
    }

    private void insertPrice(UUID itemId, UUID merchantId, int version, long price, String unit) {
        jdbc.update("insert into catalog_item_prices (id, item_id, merchant_id, version, price_per_sale_unit_rwf, sale_unit, "
                + "created_by_user_id, effective_at) values (?, ?, ?, ?, ?, ?, ?, now())",
                UUID.randomUUID(), itemId, merchantId, version, price, unit, w.ownerPerson.userId());
    }

    /** An item and its first price version, inserted together as the application does. */
    private UUID validItem(UUID merchantId, String type, String code, String dimension, String stockUnit, String saleUnit, long price) {
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> {
            insertItem(id, merchantId, type, "Item " + id, code, dimension, stockUnit, saleUnit, price, 1);
            insertPrice(id, merchantId, 1, price, saleUnit);
        });
        return id;
    }

    private void insertPackage(UUID itemId, UUID merchantId, String itemType, String dimension, String label, String quantity) {
        jdbc.update("insert into catalog_item_packages (id, item_id, merchant_id, item_type, measurement_dimension, label, "
                + "quantity_per_package, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?::numeric, now(), now())",
                UUID.randomUUID(), itemId, merchantId, itemType, dimension, label, quantity);
    }

    // --- migration --------------------------------------------------------------------------------------

    @Test
    void v9AppliedAndIsPurelyAdditive() throws java.io.IOException {
        assertThat(jdbc.queryForList("select version from flyway_schema_history where success order by installed_rank", String.class))
                .contains("9");
        assertThat(jdbc.queryForList("select tablename from pg_tables where schemaname = 'public' and tablename like 'catalog\\_%' order by 1",
                String.class)).containsExactly("catalog_item_packages", "catalog_item_prices", "catalog_items");
        String sql = new ClassPathResource("db/migration/V9__goods_and_services_catalog.sql").getContentAsString(java.nio.charset.StandardCharsets.UTF_8)
                .toLowerCase(java.util.Locale.ROOT);
        // It only creates things: nothing existing is altered (except the deferred key it adds to its OWN table), dropped or rewritten.
        assertThat(sql).doesNotContain("drop ").doesNotContain("delete from").doesNotContain("truncate").doesNotContain("insert into").doesNotContain("alter table invoice").doesNotContain("alter table payment")
                .doesNotContain("alter table bank").doesNotContain("alter table merchants").doesNotContain("alter table audit");
        assertThat(sql.indexOf("alter table")).isEqualTo(sql.lastIndexOf("alter table"));
        assertThat(sql).contains("alter table catalog_items");
    }

    @Test
    void theCatalogTablesHoldNoFloatingPointAndMoneyIsBigint() {
        assertThat(jdbc.queryForList("select column_name from information_schema.columns where table_name like 'catalog\\_%' "
                + "and data_type in ('double precision', 'real', 'money')", String.class)).isEmpty();
        assertThat(jdbc.queryForList("select data_type from information_schema.columns where table_name like 'catalog\\_%' "
                + "and column_name like '%\\_rwf'", String.class)).isNotEmpty().containsOnly("bigint");
        assertThat(jdbc.queryForObject("select numeric_precision || ',' || numeric_scale from information_schema.columns "
                + "where table_name = 'catalog_item_packages' and column_name = 'quantity_per_package'", String.class)).isEqualTo("20,6");
    }

    // --- items ------------------------------------------------------------------------------------------

    @Test
    void acceptsEveryDocumentedUnitConfiguration() {
        validItem(w.merchantId, "GOODS", null, "MASS", "g", "kg", 1_500);
        validItem(w.merchantId, "GOODS", null, "MASS", "g", "g", 2);
        validItem(w.merchantId, "GOODS", null, "VOLUME", "ml", "l", 2_500);
        validItem(w.merchantId, "GOODS", null, "LENGTH", "mm", "m", 4_000);
        validItem(w.merchantId, "GOODS", null, "AREA", "mm2", "m2", 18_000);
        validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 150_000);
        validItem(w.merchantId, "SERVICE", null, "COUNT", null, "pc", 3_000);
        assertThat(jdbc.queryForObject("select count(*) from catalog_items", Long.class)).isEqualTo(7);
    }

    @Test
    void refusesIncompatibleUnitConfigurations() {
        String[][] bad = {
            {"GOODS", "MASS", "g", "l"},        // sale unit of another dimension
            {"GOODS", "MASS", "kg", "kg"},      // stock must be the canonical unit
            {"GOODS", "VOLUME", "ml", "kg"},
            {"GOODS", "COUNT", "pc", "g"},
            {"GOODS", "COUNT", null, "pc"},     // goods always have a stock unit
            {"SERVICE", "MASS", null, "kg"},    // a service is counted per service
            {"SERVICE", "COUNT", "pc", "pc"},   // and has no stock unit
            {"SERVICE", "COUNT", null, "kg"},
            {"WIDGET", "COUNT", "pc", "pc"},
        };
        for (String[] row : bad) {
            assertThatThrownBy(() -> validItem(w.merchantId, row[0], null, row[1], row[2], row[3], 100))
                    .as(String.join("/", String.valueOf(row[0]), row[1], String.valueOf(row[2]), row[3]))
                    .isInstanceOf(RuntimeException.class);
        }
        assertThat(jdbc.queryForObject("select count(*) from catalog_items", Long.class)).isZero();
    }

    @Test
    void refusesBadPricesNamesAndCodes() {
        assertThatThrownBy(() -> validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", -1)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 1_000_000_001L)).isInstanceOf(RuntimeException.class);
        validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 1_000_000_000L);
        assertThatThrownBy(() -> validItem(w.merchantId, "GOODS", "lower", "COUNT", "pc", "pc", 1)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> validItem(w.merchantId, "GOODS", "HAS SPACE", "COUNT", "pc", "pc", 1)).isInstanceOf(DataAccessException.class);
        UUID blank = UUID.randomUUID();
        assertThatThrownBy(() -> jdbc.update("insert into catalog_items (id, merchant_id, item_type, name, measurement_dimension, stock_unit, "
                + "sale_unit, price_per_sale_unit_rwf, current_price_version, created_by_user_id, created_at, updated_at) "
                + "values (?, ?, 'GOODS', '   ', 'COUNT', 'pc', 'pc', 1, 1, ?, now(), now())", blank, w.merchantId, w.ownerPerson.userId()))
                .isInstanceOf(DataAccessException.class);
    }

    @Test
    void codesAreUniquePerMerchantAndOptional() {
        validItem(w.merchantId, "GOODS", "SKU-1", "COUNT", "pc", "pc", 1);
        assertThatThrownBy(() -> validItem(w.merchantId, "GOODS", "SKU-1", "COUNT", "pc", "pc", 1)).isInstanceOf(RuntimeException.class);
        validItem(w.cafeMerchantId, "GOODS", "SKU-1", "COUNT", "pc", "pc", 1);
        validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 1);
        validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 1);
    }

    @Test
    void theCurrentPriceMustBeOneOfTheItemsOwnVersions() {
        // An item with no price version at all cannot be committed.
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> insertItem(UUID.randomUUID(), w.merchantId, "GOODS", "Orphan", null,
                "COUNT", "pc", "pc", 10, 1))).isInstanceOf(RuntimeException.class);
        // A version whose price or unit differs from the item's current price is refused.
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
            UUID id = UUID.randomUUID();
            insertItem(id, w.merchantId, "GOODS", "Liar", null, "MASS", "g", "kg", 100, 1);
            insertPrice(id, w.merchantId, 1, 999, "kg");
        })).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
            UUID id = UUID.randomUUID();
            insertItem(id, w.merchantId, "GOODS", "Wrong unit", null, "MASS", "g", "kg", 100, 1);
            insertPrice(id, w.merchantId, 1, 100, "g");
        })).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("select count(*) from catalog_items", Long.class)).isZero();
    }

    @Test
    void moveTheCurrentPriceOnlyToAnExistingVersion() {
        UUID id = validItem(w.merchantId, "GOODS", null, "MASS", "g", "kg", 100);
        // Pointing at version 2 before it exists fails; with the version in the same transaction it works.
        assertThatThrownBy(() -> tx.executeWithoutResult(s ->
                jdbc.update("update catalog_items set current_price_version = 2, price_per_sale_unit_rwf = 200 where id = ?", id)))
                .isInstanceOf(RuntimeException.class);
        tx.executeWithoutResult(s -> {
            jdbc.update("update catalog_items set current_price_version = 2, price_per_sale_unit_rwf = 200 where id = ?", id);
            insertPrice(id, w.merchantId, 2, 200, "kg");
        });
        assertThat(jdbc.queryForObject("select current_price_version from catalog_items where id = ?", Integer.class, id)).isEqualTo(2);
    }

    @Test
    void whatAnItemIsCanNeverChangeButItsDescriptionCan() {
        UUID id = validItem(w.merchantId, "GOODS", null, "MASS", "g", "kg", 100);
        jdbc.update("update catalog_items set name = 'Renamed', description = 'Updated', active = false where id = ?", id);
        assertThat(jdbc.queryForObject("select name from catalog_items where id = ?", String.class, id)).isEqualTo("Renamed");
        for (String change : List.of("item_type = 'SERVICE'", "measurement_dimension = 'VOLUME'", "stock_unit = 'ml'",
                "merchant_id = '" + w.cafeMerchantId + "'", "created_at = now() - interval '1 day'")) {
            assertThatThrownBy(() -> jdbc.update("update catalog_items set " + change + " where id = ?", id)).as(change).isInstanceOf(RuntimeException.class);
        }
        assertThat(jdbc.queryForObject("select item_type || measurement_dimension || stock_unit from catalog_items where id = ?", String.class, id))
                .isEqualTo("GOODSMASSg");
    }

    // --- price versions ---------------------------------------------------------------------------------

    @Test
    void priceVersionsAreAppendOnly() {
        UUID id = validItem(w.merchantId, "GOODS", null, "MASS", "g", "kg", 100);
        assertThatThrownBy(() -> jdbc.update("update catalog_item_prices set price_per_sale_unit_rwf = 1 where item_id = ?", id))
                .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> jdbc.update("delete from catalog_item_prices where item_id = ?", id)).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("select price_per_sale_unit_rwf from catalog_item_prices where item_id = ?", Long.class, id)).isEqualTo(100);
    }

    @Test
    void priceVersionsAreUniquePerItemAndStayInsideTheBusiness() {
        UUID id = validItem(w.merchantId, "GOODS", null, "MASS", "g", "kg", 100);
        assertThatThrownBy(() -> insertPrice(id, w.merchantId, 1, 100, "kg")).isInstanceOf(DataAccessException.class);
        // A price row cannot claim another business's id for this item.
        assertThatThrownBy(() -> insertPrice(id, w.cafeMerchantId, 2, 100, "kg")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> insertPrice(id, w.merchantId, 0, 100, "kg")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> insertPrice(id, w.merchantId, 2, 100, "stone")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> insertPrice(id, w.merchantId, 2, -5, "kg")).isInstanceOf(DataAccessException.class);
    }

    @Test
    void anItemOfOneBusinessCannotBeReachedFromAnother() {
        UUID id = validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 10);
        assertThatThrownBy(() -> insertPackage(id, w.cafeMerchantId, "GOODS", "COUNT", "Carton", "24")).isInstanceOf(DataAccessException.class);
        insertPackage(id, w.merchantId, "GOODS", "COUNT", "Carton", "24");
    }

    // --- packages ---------------------------------------------------------------------------------------

    @Test
    void packagesBelongOnlyToGoodsOfTheSameDimension() {
        UUID soda = validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 10);
        UUID haircut = validItem(w.merchantId, "SERVICE", null, "COUNT", null, "pc", 3_000);
        insertPackage(soda, w.merchantId, "GOODS", "COUNT", "Carton", "24");
        // A service cannot own a package, however the row is dressed up.
        assertThatThrownBy(() -> insertPackage(haircut, w.merchantId, "GOODS", "COUNT", "Bundle", "5")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> insertPackage(haircut, w.merchantId, "SERVICE", "COUNT", "Bundle", "5")).isInstanceOf(DataAccessException.class);
        // The dimension must be the item's.
        assertThatThrownBy(() -> insertPackage(soda, w.merchantId, "GOODS", "MASS", "Sack", "5")).isInstanceOf(DataAccessException.class);
    }

    @Test
    void packageQuantitiesAreExactPositiveAndWholeForPieces() {
        UUID soda = validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 10);
        UUID rice = validItem(w.merchantId, "GOODS", null, "MASS", "g", "kg", 10);
        assertThatThrownBy(() -> insertPackage(soda, w.merchantId, "GOODS", "COUNT", "Half", "24.5")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> insertPackage(soda, w.merchantId, "GOODS", "COUNT", "Zero", "0")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> insertPackage(rice, w.merchantId, "GOODS", "MASS", "Negative", "-1")).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> insertPackage(rice, w.merchantId, "GOODS", "MASS", "Huge", "100000000000000")).isInstanceOf(DataAccessException.class);
        insertPackage(rice, w.merchantId, "GOODS", "MASS", "Max", "99999999999999.999999");
        insertPackage(rice, w.merchantId, "GOODS", "MASS", "Tiny", "0.000001");
        // NUMERIC(20,6) keeps six places exactly: nothing is stored as a float.
        assertThat(jdbc.queryForObject("select quantity_per_package::text from catalog_item_packages where label = 'Tiny'", String.class))
                .isEqualTo("0.000001");
    }

    @Test
    void packageNamesAreUniquePerItemIgnoringCaseButNotAcrossItems() {
        UUID soda = validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 10);
        UUID water = validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 10);
        insertPackage(soda, w.merchantId, "GOODS", "COUNT", "Carton", "24");
        assertThatThrownBy(() -> insertPackage(soda, w.merchantId, "GOODS", "COUNT", "CARTON", "12")).isInstanceOf(DataAccessException.class);
        insertPackage(water, w.merchantId, "GOODS", "COUNT", "Carton", "12");
    }

    @Test
    void anItemWithPackagesCannotChangeItsTypeOrDimension() {
        UUID soda = validItem(w.merchantId, "GOODS", null, "COUNT", "pc", "pc", 10);
        insertPackage(soda, w.merchantId, "GOODS", "COUNT", "Carton", "24");
        assertThatThrownBy(() -> jdbc.update("update catalog_items set item_type = 'SERVICE' where id = ?", soda)).isInstanceOf(RuntimeException.class);
    }
}
