package rw.oupay.demo;

import java.util.List;

/**
 * WHAT the demonstration business contains. Plain data: the seeder turns each line into a call of the normal services, creating it only when it is
 * missing. Everything is obviously synthetic, and nothing here is money, an approval or a tax decision.
 */
final class DemoSeedPlan {

    private DemoSeedPlan() {}

    record BranchPlan(String code, String name, String district, String sector, String address) {}

    record ItemPlan(String code, String name, String description, boolean goods, String dimension, String unit, long priceRwf) {}

    record PackagePlan(String itemCode, String label, String amount, String unit) {}

    record StockPlan(String branchCode, String itemCode, String amount, String unit) {}

    record DevicePlan(String key, String type, String name, String branchCode, boolean cashier) {}

    static final List<BranchPlan> BRANCHES = List.of(
            new BranchPlan("KGL1", "Kigali Central (demo)", "Nyarugenge", "Nyarugenge", "KN 4 Ave (demonstration data)"),
            new BranchPlan("RMR2", "Remera (demo)", "Gasabo", "Remera", "KG 11 Ave (demonstration data)"),
            new BranchPlan("NYM3", "Nyamirambo (demo)", "Nyarugenge", "Nyamirambo", "KN 5 Rd (demonstration data)"));

    /** Staff branches: the manager works at two branches, the cashier at the central one. */
    static final List<String> MANAGER_BRANCHES = List.of("KGL1", "RMR2");
    static final List<String> CASHIER_BRANCHES = List.of("KGL1");

    /** Twelve catalog entries: eight goods, four services. Tax treatment is deliberately NOT set: it is a business decision with its own approval gate. */
    static final List<ItemPlan> ITEMS = List.of(
            new ItemPlan("DEMO-RICE", "Rice", "Long grain rice, sold by the kilogram.", true, "MASS", "kg", 1_200),
            new ItemPlan("DEMO-SUGAR", "Sugar", "White sugar, sold by the kilogram.", true, "MASS", "kg", 1_500),
            new ItemPlan("DEMO-FLOUR", "Maize flour", "Maize flour, sold by the kilogram.", true, "MASS", "kg", 1_100),
            new ItemPlan("DEMO-OIL", "Cooking oil", "Sunflower cooking oil, sold by the litre.", true, "VOLUME", "l", 3_200),
            new ItemPlan("DEMO-SODA", "Soda 500 ml", "Soft drink bottle, 500 ml.", true, "COUNT", "pc", 600),
            new ItemPlan("DEMO-WATER", "Bottled water 1.5 l", "Drinking water bottle, 1.5 litres.", true, "COUNT", "pc", 900),
            new ItemPlan("DEMO-NOTE", "Notebook A5", "Ruled A5 school notebook.", true, "COUNT", "pc", 800),
            new ItemPlan("DEMO-SOAP", "Laundry soap bar", "Laundry soap bar.", true, "COUNT", "pc", 500),
            new ItemPlan("DEMO-CHARGE", "Phone charging", "Phone charging service.", false, null, null, 200),
            new ItemPlan("DEMO-COPY", "Photocopy", "Photocopy, per page.", false, null, null, 50),
            new ItemPlan("DEMO-DELIVER", "Delivery within Kigali", "Delivery of an order within Kigali.", false, null, null, 2_000),
            new ItemPlan("DEMO-REPAIR", "Tailoring repair", "Small clothing repair.", false, null, null, 3_000));

    static final List<PackagePlan> PACKAGES = List.of(
            new PackagePlan("DEMO-RICE", "Sack", "25", "kg"),
            new PackagePlan("DEMO-SODA", "Crate", "24", "pc"));

    /** Opening stock, recorded as ordinary opening movements. The third branch starts with none: a person receives stock there. */
    static final List<StockPlan> STOCK = List.of(
            new StockPlan("KGL1", "DEMO-RICE", "120", "kg"),
            new StockPlan("KGL1", "DEMO-SUGAR", "80", "kg"),
            new StockPlan("KGL1", "DEMO-FLOUR", "90", "kg"),
            new StockPlan("KGL1", "DEMO-OIL", "60", "l"),
            new StockPlan("KGL1", "DEMO-SODA", "240", "pc"),
            new StockPlan("KGL1", "DEMO-WATER", "120", "pc"),
            new StockPlan("KGL1", "DEMO-NOTE", "200", "pc"),
            new StockPlan("KGL1", "DEMO-SOAP", "150", "pc"),
            new StockPlan("RMR2", "DEMO-RICE", "60", "kg"),
            new StockPlan("RMR2", "DEMO-SODA", "120", "pc"),
            new StockPlan("RMR2", "DEMO-WATER", "60", "pc"),
            new StockPlan("RMR2", "DEMO-SOAP", "80", "pc"));

    /** Three payment points of the three kinds. None is given a bill: that needs a code sale, which needs an approved collection code. */
    static final List<DevicePlan> DEVICES = List.of(
            new DevicePlan("counter-qr", "STATIC_QR", "Kigali Central counter", "KGL1", false),
            new DevicePlan("remera-tag", "NFC_TAG", "Remera door tag", "RMR2", false),
            new DevicePlan("cashier-bracelet", "NFC_BRACELET", "Cashier bracelet", "KGL1", true));
}
