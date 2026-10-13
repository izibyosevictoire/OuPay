package rw.oupay.common;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Where the browser application lives: used to build the links that are e-mailed to people. */
@ConfigurationProperties("oupay.app")
public record AppProperties(@DefaultValue("http://localhost:5173") String baseUrl) {

    public String link(String path) {
        String base = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        return base + path;
    }
}
