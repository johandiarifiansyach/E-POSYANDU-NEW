import { writeFile } from 'node:fs/promises';

const frontendUrl = process.env.MONITOR_FRONTEND_URL || 'https://e-posyandu.pages.dev';
const apiUrl = process.env.MONITOR_API_URL || 'https://e-posyandu-api.eposyandu-puskesmas-gumukmas.workers.dev';
const workerHealthUrl = process.env.MONITOR_GRPC_HEALTH_URL || 'https://e-posyandu-nutrition-worker.onrender.com/health';
const timeoutMs = Math.min(60_000, Math.max(2_000, Number(process.env.MONITOR_TIMEOUT_MS) || 45_000));
const outputPath = process.env.MONITOR_OUTPUT_PATH;

async function check(name, url, validate) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'e-posyandu-monitor/1.0' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.text();
    const validation = await validate(response, body);
    return {
      name,
      ok: response.ok && validation.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      detail: validation.detail
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: null,
      latencyMs: Math.round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function jsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const checks = await Promise.all([
  check('frontend', frontendUrl, async (_response, body) => ({
    ok: /<html[\s>]/i.test(body) && /e-posyandu/i.test(body),
    detail: 'shell HTML'
  })),
  check('api-health', `${apiUrl}/api/v1/health`, async (_response, body) => {
    const payload = jsonBody(body);
    return { ok: payload?.ok === true, detail: payload?.service || 'respons health tidak valid' };
  }),
  check('api-readiness', `${apiUrl}/api/v1/health/ready`, async (_response, body) => {
    const payload = jsonBody(body);
    return {
      ok: payload?.ok === true,
      detail: payload?.status || 'respons readiness tidak valid'
    };
  }),
  check('nutrition-worker', workerHealthUrl, async (_response, body) => ({
    ok: /nutrition worker aktif/i.test(body),
    detail: 'health worker gRPC'
  }))
]);

const report = {
  event: 'system_monitor',
  ok: checks.every((item) => item.ok),
  checkedAt: new Date().toISOString(),
  checks
};
const encoded = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, encoded, { mode: 0o600 });
process.stdout.write(encoded);
if (!report.ok) process.exitCode = 1;
