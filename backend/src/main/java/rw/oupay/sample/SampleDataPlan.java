package rw.oupay.sample;

import java.util.List;

/**
 * R9b: WHAT the sample dataset contains. Plain data: the importer turns each line into a call of the normal services, creating it only when it is
 * missing. Everything is recognisable as sample data (the {@code DEMO} prefix on every branch code, item code and name, and the batch identifier in
 * stock references and in the audit line), and nothing here is money, an approval, a tax decision or a balance.
 */
final class SampleDataPlan {

    private SampleDataPlan() {}

    /** Identifies this dataset in stock references and in the audit trail, so a later cleanup can find what this import made. */
    static final String BATCH = "R9B-SAMPLE-1";

    /** Bumped when the dataset definition changes, so a confirmation given for an older definition can never apply a newer one. */
    static final int PLAN_VERSION = 1;

    static final String MARKER = "Sample data (" + BATCH + ")";

    /** Branch codes allow letters and digits only (2 to 12), so the prefix is {@code DEMO} without a hyphen. */
    record BranchPlan(String code, String name, String district, String sector, String address) {}

    record ItemPlan(String code, String name, String description, boolean goods, String dimension, String unit, long priceRwf) {}

    record PackagePlan(String itemCode, String label, String amount, String unit) {}

    record StockPlan(String branchCode, String itemCode, String amount, String unit) {}

    record DevicePlan(String key, String type, String name, String branchCode) {}

    record StaffPlan(String key, String role, String fullNameHint, List<String> branchCodes) {}

    record DraftLine(String itemCode, String quantity, String unit) {}

    record DraftPlan(String key, String note, List<DraftLine> lines) {}

    static final List<BranchPlan> BRANCHES = List.of(
            new BranchPlan("DEMOKGL", "DEMO - Kigali Main", "Nyarugenge", "Nyarugenge", "KN 4 Ave (sample data)"),
            new BranchPlan("DEMORMR", "DEMO - Remera", "Gasabo", "Remera", "KG 11 Ave (sample data)"),
            new BranchPlan("DEMOKMR", "DEMO - Kimironko", "Gasabo", "Kimironko", "KG 19 Ave (sample data)"));

    /** Ten goods and two services. Tax treatment is deliberately NOT set: it is a business decision with its own approval gate. */
    static final List<ItemPlan> ITEMS = List.of(
            new ItemPlan("DEMO-RICE", "DEMO - Rice", "Long grain rice, sold by the kilogram. " + MARKER, true, "MASS", "kg", 1_200),
            new ItemPlan("DEMO-SUGAR", "DEMO - Sugar", "White sugar, sold by the kilogram. " + MARKER, true, "MASS", "kg", 1_500),
            new ItemPlan("DEMO-FLOUR", "DEMO - Maize flour", "Maize flour, sold by the kilogram. " + MARKER, true, "MASS", "kg", 1_100),
            new ItemPlan("DEMO-BEANS", "DEMO - Beans", "Dry beans, sold by the kilogram. " + MARKER, true, "MASS", "kg", 1_400),
            new ItemPlan("DEMO-SALT", "DEMO - Salt", "Table salt, sold by the kilogram. " + MARKER, true, "MASS", "kg", 600),
            new ItemPlan("DEMO-OIL", "DEMO - Cooking oil", "Sunflower cooking oil, sold by the litre. " + MARKER, true, "VOLUME", "l", 3_200),
            new ItemPlan("DEMO-SODA", "DEMO - Soda 500 ml", "Soft drink bottle, 500 ml. " + MARKER, true, "COUNT", "pc", 600),
            new ItemPlan("DEMO-WATER", "DEMO - Bottled water 1.5 l", "Drinking water bottle, 1.5 litres. " + MARKER, true, "COUNT", "pc", 900),
            new ItemPlan("DEMO-NOTE", "DEMO - Notebook A5", "Ruled A5 school notebook. " + MARKER, true, "COUNT", "pc", 800),
            new ItemPlan("DEMO-SOAP", "DEMO - Laundry soap bar", "Laundry soap bar. " + MARKER, true, "COUNT", "pc", 500),
            new ItemPlan("DEMO-CHARGE", "DEMO - Phone charging", "Phone charging service. " + MARKER, false, null, null, 200),
            new ItemPlan("DEMO-DELIVER", "DEMO - Delivery within Kigali", "Delivery of an order within Kigali. " + MARKER, false, null, null, 2_000));

    static final List<PackagePlan> PACKAGES = List.of(
            new PackagePlan("DEMO-RICE", "Sack", "25", "kg"),
            new PackagePlan("DEMO-SODA", "Crate", "24", "pc"));

    /** Opening stock, recorded as ordinary opening movements. The main branch carries every good; the others a realistic part of the range. */
    static final List<StockPlan> STOCK = List.of(
            new StockPlan("DEMOKGL", "DEMO-RICE", "150", "kg"),
            new StockPlan("DEMOKGL", "DEMO-SUGAR", "90", "kg"),
            new StockPlan("DEMOKGL", "DEMO-FLOUR", "100", "kg"),
            new StockPlan("DEMOKGL", "DEMO-BEANS", "80", "kg"),
            new StockPlan("DEMOKGL", "DEMO-SALT", "40", "kg"),
            new StockPlan("DEMOKGL", "DEMO-OIL", "60", "l"),
            new StockPlan("DEMOKGL", "DEMO-SODA", "240", "pc"),
            new StockPlan("DEMOKGL", "DEMO-WATER", "120", "pc"),
            new StockPlan("DEMOKGL", "DEMO-NOTE", "200", "pc"),
            new StockPlan("DEMOKGL", "DEMO-SOAP", "150", "pc"),
            new StockPlan("DEMORMR", "DEMO-RICE", "70", "kg"),
            new StockPlan("DEMORMR", "DEMO-SUGAR", "45", "kg"),
            new StockPlan("DEMORMR", "DEMO-OIL", "30", "l"),
            new StockPlan("DEMORMR", "DEMO-SODA", "120", "pc"),
            new StockPlan("DEMORMR", "DEMO-WATER", "60", "pc"),
            new StockPlan("DEMORMR", "DEMO-SOAP", "80", "pc"),
            new StockPlan("DEMOKMR", "DEMO-RICE", "50", "kg"),
            new StockPlan("DEMOKMR", "DEMO-BEANS", "35", "kg"),
            new StockPlan("DEMOKMR", "DEMO-SODA", "96", "pc"),
            new StockPlan("DEMOKMR", "DEMO-WATER", "48", "pc"),
            new StockPlan("DEMOKMR", "DEMO-NOTE", "90", "pc"));

    /** Two static QR payment points and one NFC tag. None is given a bill (that needs a code sale, which needs an approved collection code). */
    static final List<DevicePlan> DEVICES = List.of(
            new DevicePlan("qr-kigali-main", "STATIC_QR", "DEMO - Kigali Main counter QR", "DEMOKGL"),
            new DevicePlan("qr-remera", "STATIC_QR", "DEMO - Remera counter QR", "DEMORMR"),
            new DevicePlan("nfc-kimironko", "NFC_TAG", "DEMO - Kimironko door tag", "DEMOKMR"));

    /** One manager and two cashiers, invited through the real invitation flow to addresses the operator supplies. */
    static final List<StaffPlan> STAFF = List.of(
            new StaffPlan("manager", "MANAGER", "Sample manager", List.of("DEMOKGL", "DEMORMR")),
            new StaffPlan("cashier-1", "CASHIER", "Sample cashier 1", List.of("DEMOKGL")),
            new StaffPlan("cashier-2", "CASHIER", "Sample cashier 2", List.of("DEMORMR")));

    /** Sample carts. Made at the first sample branch the OWNER is already assigned to; the importer never changes anyone's branch assignments. */
    static final List<DraftPlan> DRAFTS = List.of(
            new DraftPlan("draft-grocery", "DEMO - sample cart: groceries",
                    List.of(new DraftLine("DEMO-RICE", "2", "kg"), new DraftLine("DEMO-OIL", "1", "l"), new DraftLine("DEMO-SODA", "6", "pc"))),
            new DraftPlan("draft-stationery", "DEMO - sample cart: stationery and soap",
                    List.of(new DraftLine("DEMO-NOTE", "5", "pc"), new DraftLine("DEMO-SOAP", "3", "pc"))));
}
