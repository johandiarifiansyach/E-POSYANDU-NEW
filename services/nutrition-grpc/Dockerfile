FROM rust:1.97-slim-bookworm AS builder

WORKDIR /app
COPY services/nutrition-grpc services/nutrition-grpc
RUN cargo build --locked --release --bin nutrition-grpc-cloud --manifest-path services/nutrition-grpc/Cargo.toml

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 eposyandu

COPY --from=builder /app/services/nutrition-grpc/target/release/nutrition-grpc-cloud /usr/local/bin/nutrition-grpc

USER eposyandu
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/nutrition-grpc"]
