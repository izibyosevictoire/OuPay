package rw.oupay.support;

import jakarta.servlet.http.Cookie;
import java.util.Map;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * A tiny browser stand-in: it keeps cookies between calls and does the CSRF double-submit
 * (echoing the readable XSRF-TOKEN cookie in X-XSRF-TOKEN), exactly like the real frontend.
 * Each instance is one "browser", so two instances are two different people.
 */
public class TestApi {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final MockMvc mvc;
    private final Map<String, String> cookies = new java.util.concurrent.ConcurrentHashMap<>();
    private volatile String remoteAddr;

    public TestApi(MockMvc mvc) {
        this.mvc = mvc;
    }

    /** Makes this "browser" connect from a specific address (rate limits are per address). */
    public TestApi from(String address) {
        this.remoteAddr = address;
        return this;
    }

    public record Response(int status, String body, MockHttpServletResponse raw) {
        public JsonNode json() {
            return body == null || body.isBlank() ? JSON.nullNode() : JSON.readTree(body);
        }

        public String code() {
            return json().path("code").asString("");
        }
    }

    public Response get(String url) {
        return send(HttpMethod.GET, url, null, Map.of());
    }

    public Response post(String url, Object body) {
        return send(HttpMethod.POST, url, body, Map.of());
    }

    public Response put(String url, Object body) {
        return send(HttpMethod.PUT, url, body, Map.of());
    }

    public Response delete(String url) {
        return send(HttpMethod.DELETE, url, null, Map.of());
    }

    public Response send(HttpMethod method, String url, Object body, Map<String, String> headers) {
        try {
            if (!cookies.containsKey("XSRF-TOKEN") && !"/api/v1/auth/session".equals(url)) {
                collect(mvc.perform(MockMvcRequestBuilders.get("/api/v1/auth/session")).andReturn());
            }
            MockHttpServletRequestBuilder request = MockMvcRequestBuilders.request(method, url);
            if (body != null) {
                request.contentType(MediaType.APPLICATION_JSON).content(body instanceof String s ? s : JSON.writeValueAsString(body));
            }
            cookies.forEach((name, value) -> request.cookie(new Cookie(name, value)));
            if (cookies.containsKey("XSRF-TOKEN")) {
                request.header("X-XSRF-TOKEN", cookies.get("XSRF-TOKEN"));
            }
            if (remoteAddr != null) {
                request.with(r -> {
                    r.setRemoteAddr(remoteAddr);
                    return r;
                });
            }
            headers.forEach(request::header);
            MvcResult result = mvc.perform(request).andReturn();
            collect(result);
            MockHttpServletResponse raw = result.getResponse();
            return new Response(raw.getStatus(), raw.getContentAsString(), raw);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Sends a request with NO cookies at all (an anonymous caller, such as a customer or a bot). */
    public static Response anonymous(MockMvc mvc, HttpMethod method, String url, Object body, Map<String, String> headers) {
        try {
            MockHttpServletRequestBuilder request = MockMvcRequestBuilders.request(method, url);
            if (body != null) {
                request.contentType(MediaType.APPLICATION_JSON).content(body instanceof String s ? s : JSON.writeValueAsString(body));
            }
            headers.forEach(request::header);
            MvcResult result = mvc.perform(request).andReturn();
            MockHttpServletResponse raw = result.getResponse();
            return new Response(raw.getStatus(), raw.getContentAsString(), raw);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public String cookie(String name) {
        return cookies.get(name);
    }

    public void setCookie(String name, String value) {
        cookies.put(name, value);
    }

    public void clearSession(String cookieName) {
        cookies.remove(cookieName);
    }

    private void collect(MvcResult result) {
        for (Cookie cookie : result.getResponse().getCookies()) {
            if (cookie.getMaxAge() == 0 || cookie.getValue() == null || cookie.getValue().isEmpty()) {
                cookies.remove(cookie.getName());
            } else {
                cookies.put(cookie.getName(), cookie.getValue());
            }
        }
    }

    public static JsonMapper json() {
        return JSON;
    }
}
