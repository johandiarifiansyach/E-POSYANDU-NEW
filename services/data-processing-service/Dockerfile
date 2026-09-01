FROM docker.io/library/rust:1.97-slim-bookworm AS builder

WORKDIR /app
COPY services/data-processing-service services/data-processing-service
COPY services/eposyandu-proto services/eposyandu-proto
COPY services/analysis-service/proto services/analysis-service/proto
RUN cargo build --locked --release --bin data-processing-cloud --manifest-path services/data-processing-service/Cargo.toml

FROM docker.io/library/debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 eposyandu \
    && install -d -o 10001 -g 10001 -m 0700 /run/e-posyandu

COPY --from=builder /app/services/data-processing-service/target/release/data-processing-cloud /usr/local/bin/data-processing-worker

USER eposyandu
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/data-processing-worker"]
