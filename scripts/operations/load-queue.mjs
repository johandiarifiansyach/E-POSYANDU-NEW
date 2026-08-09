const apiUrl = process.env.LOAD_API_URL || 'https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev';
const accessToken = process.env.LOAD_ACCESS_TOKEN;
if (!accessToken) throw new Error('LOAD_ACCESS_TOKEN wajib diisi untuk load test Queue.');

const jobCount = Math.min(50, Math.max(1, Number(process.env.LOAD_QUEUE_JOBS) || 5));
const concurrency = Math.min(10, Math.max(1, Number(process.env.LOAD_QUEUE_CONCURRENCY) || 2));
const itemsPerJob = Math.min(1_000, Math.max(1, Number(process.env.LOAD_QUEUE_ITEMS) || 100));
const timeoutMs = Math.min(15 * 60_000, Math.max(30_000, Number(process.env.LOAD_QUEUE_TIMEOUT_MS) || 5 * 60_000));
const p95LimitMs = Math.max(1_000, Number(process.env.LOAD_QUEUE_P95_LIMIT_MS) || 180_000);

function syntheticItems(jobIndex) {
  return Array.from({ length: itemsPerJob }, (_, itemIndex) => ({
    weightKg: 7 + ((jobIndex + itemIndex) % 80) / 10,
    heightCm: 65 + ((jobIndex + itemIndex) % 45),
    ageMonths: (jobIndex + itemIndex) % 60,
    sex: itemIndex % 2 === 0 ? 'L' : 'P',
    measurementMethod: itemIndex % 3 === 0 ? 'Terlentang' : 'Berdiri',
    rowNumber: itemIndex + 1,
    recordId: `load-${jobIndex}-${itemIndex}`,
    nik: ''
  }));
}

async function apiRequest(path, init = {}) {
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Request-ID': crypto.randomUUID(),
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `API mengembalikan status ${response.status}.`);
  return payload;
}

async function mapLimit(values, limit, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function runner() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, runner));
  return results;
}

async function createJob(_value, index) {
  const startedAt = performance.now();
  const idempotencyKey = `load:${Date.now()}:${index}:${crypto.randomUUID()}`;
  const job = await apiRequest('/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ kind: 'nutrition_report', payload: { items: syntheticItems(index) } })
  });
  if (job.queueConfigured === false) throw new Error('Cloudflare Queue tidak terhubung ke API.');
  return { id: job.id, startedAt, createdLatencyMs: Math.round(performance.now() - startedAt) };
}

async function waitForJob(created) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await apiRequest(`/jobs/${encodeURIComponent(created.id)}`);
    if (job.status === 'completed') {
      return { id: created.id, latencyMs: Math.round(performance.now() - created.startedAt) };
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error || `Job ${created.id} berstatus ${job.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Job ${created.id} melewati batas waktu ${timeoutMs} ms.`);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] || 0;
}

const startedAt = performance.now();
const created = await mapLimit(Array.from({ length: jobCount }), concurrency, createJob);
const completed = await mapLimit(created, concurrency, waitForJob);
const latencies = completed.map((item) => item.latencyMs);
const report = {
  event: 'queue_grpc_load_test',
  ok: completed.length === jobCount && percentile(latencies, 0.95) <= p95LimitMs,
  jobs: jobCount,
  concurrency,
  itemsPerJob,
  durationMs: Math.round(performance.now() - startedAt),
  latencyMs: {
    minimum: Math.min(...latencies),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    maximum: Math.max(...latencies),
    limitP95: p95LimitMs
  }
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
