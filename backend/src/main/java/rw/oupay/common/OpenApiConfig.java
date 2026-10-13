package rw.oupay.common;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** OpenAPI description. Browser sessions use an HttpOnly cookie; there are no bearer tokens to copy around. */
@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI oupayOpenApi() {
        return new OpenAPI()
                .info(new Info().title("OuPay backend API").version("v1").description(
                        "Merchant invoicing, payment verification and reconciliation. "
                                + "Authenticated endpoints use the HttpOnly `oupay_session` cookie plus an `X-XSRF-TOKEN` header. "
                                + "`/api/v1/public/**` is the anonymous customer API; `/api/v1/integrations/**` is the provider-authenticated "
                                + "event boundary (signature required). Endpoints answering 501 are contracts for work that is not built yet. "
                                + "The simulated provider is for local development only; nothing here is a real Equity Bank API."))
                .components(new Components().addSecuritySchemes("session", new SecurityScheme()
                        .type(SecurityScheme.Type.APIKEY).in(SecurityScheme.In.COOKIE).name("oupay_session")))
                .addSecurityItem(new SecurityRequirement().addList("session"));
    }
}
