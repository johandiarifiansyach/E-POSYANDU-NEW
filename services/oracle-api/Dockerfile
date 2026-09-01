FROM docker.io/library/rust:1.97-bookworm AS builder

WORKDIR /app
COPY services/oracle-api services/oracle-api
COPY services/eposyandu-proto services/eposyandu-proto
COPY services/data-processing-service/proto services/data-processing-service/proto
COPY services/analysis-service/proto services/analysis-service/proto
COPY backend/openapi.json backend/openapi.json
COPY backend/graphql-schema.graphql backend/graphql-schema.graphql
RUN cargo build --locked --release --manifest-path services/oracle-api/Cargo.toml

FROM docker.io/library/debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin eposyandu \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/e-posyandu-api /run/e-posyandu

COPY --from=builder /app/services/oracle-api/target/release/e-posyandu-oracle-api /usr/local/bin/e-posyandu-oracle-api

USER 10001:10001
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/e-posyandu-oracle-api", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/e-posyandu-oracle-api"]
