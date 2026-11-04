package rw.oupay.demo;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** What one seed run did, by kind of record: created now, or already there and left exactly as it was. Never contains a secret. */
public final class SeedReport {

    private final Map<String, int[]> counts = new LinkedHashMap<>();
    private final List<String> attention = new ArrayList<>();

    void addCreated(String kind) {
        counts.computeIfAbsent(kind, k -> new int[2])[0]++;
    }

    void addKept(String kind) {
        counts.computeIfAbsent(kind, k -> new int[2])[1]++;
    }

    /** Something the seeder found but deliberately did not touch, for a person to look at. */
    void attention(String message) {
        attention.add(message);
    }

    public int created() {
        return counts.values().stream().mapToInt(c -> c[0]).sum();
    }

    public int created(String kind) {
        return counts.getOrDefault(kind, new int[2])[0];
    }

    public int kept(String kind) {
        return counts.getOrDefault(kind, new int[2])[1];
    }

    public List<String> attention() {
        return List.copyOf(attention);
    }

    @Override
    public String toString() {
        StringBuilder text = new StringBuilder();
        counts.forEach((kind, c) -> text.append(String.format("  %-14s created %d, kept %d%n", kind, c[0], c[1])));
        attention.forEach(a -> text.append("  ATTENTION: ").append(a).append(System.lineSeparator()));
        return text.toString();
    }
}
