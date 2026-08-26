FROM docker.io/library/rust:1.97-bookworm AS builder

ARG SERVICE_DIR
ARG SERVICE_BIN
WORKDIR /app

# The domain implementation is shared as source during the migration, while
# every service gets its own binary and container lifecycle.
COPY services/oracle-domain services/oracle-domain
COPY services/eposyandu-proto services/eposyandu-proto
# The shared proto build script imports nutrition.proto from this path.
# Keep the source available in every domain-service build context.
COPY services/nutrition-grpc/proto services/nutrition-grpc/proto
COPY services/oracle-api/src services/oracle-api/src
COPY services/${SERVICE_DIR} services/${SERVICE_DIR}
RUN cargo build --locked --release --manifest-path services/${SERVICE_DIR}/Cargo.toml --bin ${SERVICE_BIN}

FROM docker.io/library/debian:bookworm-slim

ARG SERVICE_DIR
ARG SERVICE_BIN
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin eposyandu \
    && install -d -o 10001 -g 10001 -m 0700 /run/e-posyandu

COPY --from=builder /app/services/${SERVICE_DIR}/target/release/${SERVICE_BIN} /usr/local/bin/eposyandu-service
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/eposyandu-service"]
