# Build against the same CPython minor version used at runtime.  PyO3 embeds
# this interpreter; using a matching builder avoids ABI surprises while still
# keeping the public service binary Rust.
FROM docker.io/library/python:3.12-slim AS builder

ENV PYO3_PYTHON=/usr/local/bin/python
WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
       build-essential ca-certificates curl pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/* \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
       | sh -s -- -y --profile minimal --default-toolchain 1.97.0
ENV PATH=/root/.cargo/bin:$PATH

COPY services/analysis-worker services/analysis-worker
COPY services/eposyandu-proto services/eposyandu-proto
COPY services/data-processing-service/proto services/data-processing-service/proto
COPY services/analysis-service/proto services/analysis-service/proto
RUN cargo build --locked --release --manifest-path services/analysis-worker/Cargo.toml

FROM docker.io/library/python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/services/analysis-service

WORKDIR /app
COPY services/analysis-worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
  && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin eposyandu \
  && install -d -o 10001 -g 10001 -m 0700 /run/e-posyandu

COPY services/analysis-service/analysis_service /app/services/analysis-service/analysis_service
COPY services/analysis-service/data /app/services/analysis-service/data
COPY frontend/src/data/whoGrowthLms.ts /app/frontend/src/data/whoGrowthLms.ts
COPY --from=builder /app/services/analysis-worker/target/release/e-posyandu-analysis-worker /usr/local/bin/e-posyandu-analysis-worker

USER 10001:10001
EXPOSE 8082
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8082/health', timeout=2)"]
ENTRYPOINT ["/usr/local/bin/e-posyandu-analysis-worker"]
