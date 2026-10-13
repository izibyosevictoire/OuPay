package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import rw.oupay.auth.ClientIpResolver;
import rw.oupay.auth.SecurityProperties;

class ClientIpResolverTest {

    private static ClientIpResolver resolver(String... trusted) {
        return new ClientIpResolver(new SecurityProperties(
                new SecurityProperties.Session("c", true, "Lax", Duration.ofMinutes(30), Duration.ofHours(12), Duration.ofDays(7), Duration.ofDays(30)),
                new SecurityProperties.Login(5, Duration.ofMinutes(15)),
                new SecurityProperties.Recovery(Duration.ofHours(1), Duration.ofHours(48), Duration.ofDays(7), 3),
                new SecurityProperties.Proxy(List.of(trusted)), new SecurityProperties.Origins(List.of())));
    }

    private static MockHttpServletRequest from(String peer, String forwarded) {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr(peer);
        if (forwarded != null) {
            request.addHeader("X-Forwarded-For", forwarded);
        }
        return request;
    }

    @Test
    void withoutTrustedProxiesTheForwardedHeaderIsIgnoredEntirely() {
        assertThat(resolver().resolve(from("203.0.113.9", "1.2.3.4"))).isEqualTo("203.0.113.9");
        assertThat(resolver().resolve(from("203.0.113.9", "1.2.3.4, 5.6.7.8"))).isEqualTo("203.0.113.9");
    }

    @Test
    void aCallerThatIsNotATrustedProxyCannotChooseItsAddress() {
        assertThat(resolver("10.0.0.0/8").resolve(from("203.0.113.9", "1.2.3.4"))).isEqualTo("203.0.113.9");
    }

    @Test
    void aTrustedProxyVouchesForTheClosestUntrustedHop() {
        var resolver = resolver("10.0.0.0/8", "192.168.1.5");
        assertThat(resolver.resolve(from("10.1.2.3", "198.51.100.7"))).isEqualTo("198.51.100.7");
        // The client sent its own header first; the proxy appended the real address. The right-most untrusted hop wins.
        assertThat(resolver.resolve(from("10.1.2.3", "9.9.9.9, 198.51.100.7"))).isEqualTo("198.51.100.7");
        assertThat(resolver.resolve(from("10.1.2.3", "9.9.9.9, 198.51.100.7, 10.9.9.9, 192.168.1.5"))).isEqualTo("198.51.100.7");
        // Every hop trusted: the left-most.
        assertThat(resolver.resolve(from("10.1.2.3", "10.0.0.1, 10.0.0.2"))).isEqualTo("10.0.0.1");
    }

    @Test
    void missingOrGarbledHeadersFallBackToThePeer() {
        var resolver = resolver("10.0.0.0/8");
        assertThat(resolver.resolve(from("10.1.2.3", null))).isEqualTo("10.1.2.3");
        assertThat(resolver.resolve(from("10.1.2.3", ""))).isEqualTo("10.1.2.3");
        assertThat(resolver.resolve(from("10.1.2.3", "not-an-ip"))).isEqualTo("10.1.2.3");
        assertThat(resolver.resolve(from("10.1.2.3", "1.2.3.4, evil.example.com"))).isEqualTo("10.1.2.3");
    }

    @Test
    void ipv6AndPartialPrefixesWork() {
        var resolver = resolver("fd00::/8", "172.16.0.0/12");
        assertThat(resolver.resolve(from("fd00::1", "2001:db8::7"))).isEqualTo("2001:db8::7");
        assertThat(resolver.resolve(from("172.31.255.255", "198.51.100.1"))).isEqualTo("198.51.100.1");
        assertThat(resolver.resolve(from("172.32.0.1", "198.51.100.1"))).isEqualTo("172.32.0.1");   // just outside /12
    }

    @Test
    void invalidConfigurationFailsAtStartup() {
        assertThatThrownBy(() -> resolver("10.0.0.0/99")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> resolver("proxy.example.com")).isInstanceOf(IllegalStateException.class);
    }
}
