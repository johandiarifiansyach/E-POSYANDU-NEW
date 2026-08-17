import { neon } from "@neondatabase/serverless";

interface Env {
  ENVIRONMENT: string;
  NEON_DATABASE_URL: string;
  NEON_SYNC_DATABASE_URL: string;
  READ_REPLICA_SHARED_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
}

type Payload = Record<string, unknown>;

const READ_OPERATIONS = new Set([
  "eposyandu_replica_children_page",
  "eposyandu_problem_children_page",
  "eposyandu_exclusive_breastfeeding_page",
  "eposyandu_dashboard_stats",
  "eposyandu_sigizi_measurement_export",
]);

const SYNC_TABLES = ["children", "measurements", "mpasi_logs"] as const;
const SYNC_PAGE_SIZE = 200;
const SYNC_PAGE_LIMIT = 100;
const SYNC_OVERLAP_MS = 5_000;

type SyncResource = (typeof SYNC_TABLES)[number] | "sync_tombstones";

interface SyncResult {
  resource: SyncResource;
  rows: number;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Permitted-Cross-Domain-Policies": "none",
    },
  });
}

async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const encode = (value: string) => new TextEncoder().encode(value);
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(provided)),
    crypto.subtle.digest("SHA-256", encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function optionalText(payload: Payload, key: string, maximum = 120): string | null {
  const value = payload[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) throw new Error(`Parameter ${key} tidak valid.`);
  return value;
}

function requiredText(payload: Payload, key: string, maximum = 120): string {
  const value = optionalText(payload, key, maximum);
  if (value === null) throw new Error(`Parameter ${key} wajib diisi.`);
  return value;
}

function requiredDate(payload: Payload, key: string): string {
  const value = requiredText(payload, key, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Parameter ${key} tidak valid.`);
  return value;
}

function integer(payload: Payload, key: string, minimum: number, maximum: number): number {
  const value = payload[key];
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Parameter ${key} tidak valid.`);
  }
  return Number(value);
}

async function executeOperation(databaseUrl: string, operation: string, payload: Payload): Promise<unknown> {
  const sql = neon(databaseUrl);
  const scope = {
    role: requiredText(payload, "p_role", 40),
    village: optionalText(payload, "p_scope_village", 120),
    posyandu: optionalText(payload, "p_scope_posyandu", 120),
  };

  if (operation === "eposyandu_replica_children_page") {
    const rows = await sql`select public.eposyandu_replica_children_page(
      ${requiredDate(payload, "p_as_of")}::date,
      ${requiredDate(payload, "p_measurement_start")}::date,
      ${requiredDate(payload, "p_measurement_end")}::date,
      ${integer(payload, "p_page", 1, 1_000_000)}::integer,
      ${integer(payload, "p_size", 1, 50)}::integer,
      ${requiredText(payload, "p_sort", 30)}::text,
      ${requiredText(payload, "p_view", 30)}::text,
      ${optionalText(payload, "p_search", 80)}::text,
      ${optionalText(payload, "p_village", 120)}::text,
      ${optionalText(payload, "p_posyandu", 120)}::text,
      ${scope.role}::text,
      ${scope.village}::text,
      ${scope.posyandu}::text
    ) as result`;
    return rows[0]?.result ?? null;
  }

  if (operation === "eposyandu_problem_children_page") {
    const rows = await sql`select public.eposyandu_problem_children_page(
      ${requiredDate(payload, "p_month_start")}::date,
      ${requiredDate(payload, "p_month_end")}::date,
      ${requiredText(payload, "p_problem", 40)}::text,
      ${integer(payload, "p_page", 1, 1_000_000)}::integer,
      ${integer(payload, "p_size", 1, 50)}::integer,
      ${optionalText(payload, "p_search", 80)}::text,
      ${requiredText(payload, "p_sort", 30)}::text,
      ${optionalText(payload, "p_village", 120)}::text,
      ${optionalText(payload, "p_posyandu", 120)}::text,
      ${scope.role}::text,
      ${scope.village}::text,
      ${scope.posyandu}::text
    ) as result`;
    return rows[0]?.result ?? null;
  }

  if (operation === "eposyandu_exclusive_breastfeeding_page") {
    const rows = await sql`select public.eposyandu_exclusive_breastfeeding_page(
      ${requiredDate(payload, "p_measurement_start")}::date,
      ${requiredDate(payload, "p_measurement_end")}::date,
      ${requiredText(payload, "p_age_group", 8)}::text,
      ${integer(payload, "p_page", 1, 1_000_000)}::integer,
      ${integer(payload, "p_size", 1, 50)}::integer,
      ${optionalText(payload, "p_village", 120)}::text,
      ${optionalText(payload, "p_posyandu", 120)}::text,
      ${scope.role}::text,
      ${scope.village}::text,
      ${scope.posyandu}::text
    ) as result`;
    return rows[0]?.result ?? null;
  }

  if (operation === "eposyandu_dashboard_stats") {
    const rows = await sql`select public.eposyandu_dashboard_stats(
      ${requiredDate(payload, "p_month_start")}::date,
      ${requiredDate(payload, "p_month_end")}::date,
      ${requiredDate(payload, "p_previous_month_start")}::date,
      ${requiredDate(payload, "p_previous_month_end")}::date,
      ${optionalText(payload, "p_village", 120)}::text,
      ${optionalText(payload, "p_posyandu", 120)}::text,
      ${scope.role}::text,
      ${scope.village}::text,
      ${scope.posyandu}::text
    ) as result`;
    return rows[0]?.result ?? null;
  }

  if (operation === "eposyandu_sigizi_measurement_export") {
    const rows = await sql`select public.eposyandu_sigizi_measurement_export(
      ${requiredDate(payload, "p_month_start")}::date,
      ${requiredDate(payload, "p_month_end")}::date,
      ${optionalText(payload, "p_village", 120)}::text,
      ${optionalText(payload, "p_posyandu", 120)}::text,
      ${scope.role}::text,
      ${scope.village}::text,
      ${scope.posyandu}::text
    ) as result`;
    return rows[0]?.result ?? null;
  }

  throw new Error("Operasi baca tidak diizinkan.");
}

function sourceHeaders(secretKey: string): Headers {
  const headers = new Headers({
    Accept: "application/json",
    apikey: secretKey,
  });
  if (secretKey.startsWith("eyJ")) headers.set("Authorization", `Bearer ${secretKey}`);
  return headers;
}

function sourceUrl(env: Env, resource: SyncResource, cursor: string, until: string, offset: number): URL {
  const table = resource === "sync_tombstones" ? "sync_tombstones" : resource;
  const timestampColumn = resource === "sync_tombstones" ? "deleted_at" : "updated_at";
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  url.searchParams.set("select", resource === "sync_tombstones" ? "resource,document_id,deleted_at" : "*");
  url.searchParams.append(timestampColumn, `gte.${cursor}`);
  url.searchParams.append(timestampColumn, `lt.${until}`);
  if (resource === "sync_tombstones") {
    url.searchParams.set("resource", "in.(children,measurements,mpasi_logs)");
    url.searchParams.set("order", "deleted_at.asc,resource.asc,document_id.asc");
  } else {
    url.searchParams.set("order", "updated_at.asc,id.asc");
  }
  url.searchParams.set("limit", String(SYNC_PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  return url;
}

async function fetchSourceRows(
  env: Env,
  resource: SyncResource,
  cursor: string,
  until: string,
  offset: number,
): Promise<Payload[]> {
  const response = await fetch(sourceUrl(env, resource, cursor, until, offset), {
    headers: sourceHeaders(env.SUPABASE_SECRET_KEY),
  });
  if (!response.ok) throw new Error(`source_${resource}_${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error(`source_${resource}_invalid_payload`);
  return rows.filter((row): row is Payload => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

async function syncResource(env: Env, resource: SyncResource, until: string): Promise<SyncResult> {
  const writer = neon(env.NEON_SYNC_DATABASE_URL);
  const stateRows = await writer`select cursor_at::text
    from public.eposyandu_replica_sync_state
    where resource = ${resource}
    limit 1`;
  const cursor = stateRows[0]?.cursor_at;
  if (typeof cursor !== "string" || cursor.length === 0) throw new Error(`state_${resource}_missing`);

  let rowCount = 0;
  for (let page = 0; page < SYNC_PAGE_LIMIT; page += 1) {
    const rows = await fetchSourceRows(env, resource, cursor, until, page * SYNC_PAGE_SIZE);
    if (rows.length > 0) {
      const encodedRows = JSON.stringify(rows);
      if (resource === "sync_tombstones") {
        await writer`select public.eposyandu_replica_apply_tombstones(${encodedRows}::jsonb)`;
      } else {
        await writer`select public.eposyandu_replica_apply_batch(${resource}, ${encodedRows}::jsonb)`;
      }
      rowCount += rows.length;
    }
    if (rows.length < SYNC_PAGE_SIZE) break;
    if (page === SYNC_PAGE_LIMIT - 1) throw new Error(`source_${resource}_page_limit`);
  }

  const nextCursor = new Date(new Date(until).getTime() - SYNC_OVERLAP_MS).toISOString();
  await writer`update public.eposyandu_replica_sync_state
    set cursor_at = ${nextCursor}::timestamptz,
        last_success_at = clock_timestamp(),
        last_row_count = ${rowCount},
        last_error = null,
        updated_at = clock_timestamp()
    where resource = ${resource}`;
  return { resource, rows: rowCount };
}

async function recordSyncFailure(env: Env, resource: SyncResource): Promise<void> {
  try {
    const writer = neon(env.NEON_SYNC_DATABASE_URL);
    await writer`update public.eposyandu_replica_sync_state
      set last_error = 'scheduled sync failed', updated_at = clock_timestamp()
      where resource = ${resource}`;
  } catch {
    console.error(JSON.stringify({ level: "error", event: "replica_sync_state_failed", resource }));
  }
}

async function runIncrementalSync(env: Env): Promise<SyncResult[]> {
  const until = new Date().toISOString();
  const results: SyncResult[] = [];
  const resources: SyncResource[] = [...SYNC_TABLES, "sync_tombstones"];
  for (const resource of resources) {
    try {
      results.push(await syncResource(env, resource, until));
    } catch (error) {
      await recordSyncFailure(env, resource);
      console.error(JSON.stringify({
        level: "error",
        event: "replica_sync_failed",
        resource,
        errorType: error instanceof Error ? error.name : "UnknownError",
      }));
      throw error;
    }
  }
  console.log(JSON.stringify({ level: "info", event: "replica_sync_completed", until, results }));
  return results;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const sql = neon(env.NEON_DATABASE_URL);
        const rows = await sql`select min(last_success_at)::text as last_success_at,
          greatest(0, extract(epoch from (clock_timestamp() - min(last_success_at)))::bigint) as lag_seconds
          from public.eposyandu_replica_sync_state`;
        return jsonResponse({
          ok: true,
          service: "e-posyandu-neon-read",
          environment: env.ENVIRONMENT,
          lastSuccessAt: rows[0]?.last_success_at ?? null,
          lagSeconds: Number(rows[0]?.lag_seconds ?? 0),
        });
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "replica_health_failed", detail: String(error) }));
        return jsonResponse({ ok: false, service: "e-posyandu-neon-read" }, 503);
      }
    }

    if (request.method !== "POST" || url.pathname !== "/v1/read") {
      return jsonResponse({ detail: "Endpoint tidak ditemukan." }, 404);
    }

    const contentLength = Number(request.headers.get("Content-Length") ?? 0);
    if (contentLength > 32_768) return jsonResponse({ detail: "Permintaan terlalu besar." }, 413);
    const providedSecret = request.headers.get("X-EPosyandu-Replica-Secret") ?? "";
    if (!(await secretMatches(providedSecret, env.READ_REPLICA_SHARED_SECRET))) {
      return jsonResponse({ detail: "Permintaan internal tidak sah." }, 401);
    }

    try {
      const body = await request.json<{ operation?: unknown; payload?: unknown }>();
      if (typeof body.operation !== "string" || !READ_OPERATIONS.has(body.operation)) {
        return jsonResponse({ detail: "Operasi baca tidak diizinkan." }, 422);
      }
      if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
        return jsonResponse({ detail: "Parameter baca tidak valid." }, 422);
      }
      const data = await executeOperation(env.NEON_DATABASE_URL, body.operation, body.payload as Payload);
      return jsonResponse({ data, source: "neon-read-replica" });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "replica_query_failed", detail: String(error) }));
      return jsonResponse({ detail: "Read replica belum dapat melayani permintaan." }, 503);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIncrementalSync(env));
  },
} satisfies ExportedHandler<Env>;
