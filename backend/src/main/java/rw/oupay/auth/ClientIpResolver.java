package rw.oupay.auth;

import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Works out the real client address for rate limiting and audit.
 *
 * <p>{@code X-Forwarded-For} is attacker-controlled unless it was written by a proxy we run. So it is
 * only read when the TCP peer is one of the configured trusted proxies, and even then it is read from
 * the RIGHT: the closest hop that is not itself a trusted proxy is the client. A client that sends its
 * own header ({@code X-Forwarded-For: 1.2.3.4}) therefore cannot choose its address, and without
 * trusted proxies configured the header is ignored completely.
 */
@Component
public class ClientIpResolver {

    private static final Pattern IP_LITERAL = Pattern.compile("^[0-9a-fA-F:.]{2,45}$");

    private record Cidr(byte[] network, int prefixBits) {
        boolean contains(byte[] address) {
            if (address.length != network.length) {
                return false;
            }
            int fullBytes = prefixBits / 8;
            for (int i = 0; i < fullBytes; i++) {
                if (address[i] != network[i]) {
                    return false;
                }
            }
            int remainder = prefixBits % 8;
            if (remainder == 0) {
                return true;
            }
            int mask = 0xFF << (8 - remainder);
            return (address[fullBytes] & mask) == (network[fullBytes] & mask);
        }
    }

    private final List<Cidr> trusted = new ArrayList<>();

    public ClientIpResolver(SecurityProperties properties) {
        for (String entry : properties.proxy().trusted()) {
            Cidr parsed = parse(entry.trim());
            if (parsed == null) {
                throw new IllegalStateException("oupay.security.proxy.trusted contains an invalid entry: " + entry);
            }
            trusted.add(parsed);
        }
    }

    public String resolve(HttpServletRequest request) {
        String peer = request.getRemoteAddr();
        if (trusted.isEmpty() || !isTrusted(peer)) {
            return peer;
        }
        String header = request.getHeader("X-Forwarded-For");
        if (header == null || header.isBlank()) {
            return peer;
        }
        String[] hops = header.split(",");
        String candidate = peer;
        for (int i = hops.length - 1; i >= 0; i--) {
            String hop = hops[i].trim();
            if (!IP_LITERAL.matcher(hop).matches()) {
                return peer; // garbage in the chain: believe nothing
            }
            candidate = hop;
            if (!isTrusted(hop)) {
                return hop;
            }
        }
        return candidate;
    }

    private boolean isTrusted(String address) {
        byte[] bytes = literalBytes(address);
        return bytes != null && trusted.stream().anyMatch(c -> c.contains(bytes));
    }

    private static Cidr parse(String entry) {
        String[] parts = entry.split("/");
        byte[] bytes = literalBytes(parts[0]);
        if (bytes == null || parts.length > 2) {
            return null;
        }
        int bits = bytes.length * 8;
        if (parts.length == 2) {
            try {
                bits = Integer.parseInt(parts[1]);
            } catch (NumberFormatException e) {
                return null;
            }
            if (bits < 0 || bits > bytes.length * 8) {
                return null;
            }
        }
        return new Cidr(bytes, bits);
    }

    /** Only IP literals are ever resolved, so this can never trigger a DNS lookup. */
    private static byte[] literalBytes(String address) {
        if (address == null || !IP_LITERAL.matcher(address).matches()) {
            return null;
        }
        try {
            return InetAddress.getByName(address).getAddress();
        } catch (UnknownHostException e) {
            return null;
        }
    }
}
