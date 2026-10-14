# syntax=docker/dockerfile:1
# OuPay backend image for Render (or any container host). Build context: the backend/ directory.
#
#   Render: Language "Docker", Root Directory "backend", Dockerfile Path "./Dockerfile".
#
# Nothing secret is baked in: every credential arrives as an environment variable at run time.

# ---- build ---------------------------------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build

# Dependencies first, so they are cached until pom.xml changes.
COPY pom.xml ./
RUN mvn -B -q dependency:go-offline

COPY spotbugs-exclude.xml ./
COPY src ./src
# The development profile carries a publicly known simulator secret. It must not exist in a deployable artefact.
# (Tests are not run here: they need PostgreSQL. Run `mvn verify` in CI before building the image.)
RUN rm -f src/main/resources/application-dev.yml \
 && mvn -B -q -DskipTests package \
 && mkdir -p /extracted \
 && java -Djarmode=tools -jar target/oupay-backend-*.jar extract --layers --launcher --destination /extracted

# ---- run -----------------------------------------------------------------------------------------------------
FROM eclipse-temurin:21-jre-alpine AS runtime

# A fixed, unprivileged user; the application writes nothing to disk.
RUN addgroup -S -g 10001 oupay && adduser -S -u 10001 -G oupay -h /app -s /sbin/nologin oupay
WORKDIR /app

COPY --from=build --chown=oupay:oupay /extracted/dependencies/ ./
COPY --from=build --chown=oupay:oupay /extracted/spring-boot-loader/ ./
COPY --from=build --chown=oupay:oupay /extracted/snapshot-dependencies/ ./
COPY --from=build --chown=oupay:oupay /extracted/application/ ./

USER 10001:10001

# The production profile enforces the startup safeguards (secure cookie, no simulator, TLS to the database, ...).
# Do not override it with dev. Render injects PORT; the application binds 0.0.0.0:${PORT} (see application.yml).
ENV SPRING_PROFILES_ACTIVE=prod \
    TZ=UTC \
    JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+UseSerialGC -XX:+ExitOnOutOfMemoryError -Xss512k -Djava.security.egd=file:/dev/./urandom"
EXPOSE 8080

# Liveness only (the process answers); Render's own health check should use /actuator/health/readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/actuator/health/liveness" || exit 1

# exec: the JVM is PID 1 and receives SIGTERM directly, so Spring's graceful shutdown (30s) runs on every deploy.
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]
