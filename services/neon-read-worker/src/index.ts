import { neon } from "@neondatabase/serverless";

interface Env {
  ENVIRONMENT: string;
  NEON_DATABASE_URL: string;
  READ_REPLICA_SHARED_SECRET: string;
}

type Payload = Record<string, unknown>;

const READ_OPERATIONS = new Set([
  "eposyandu_replica_children_page",
  "eposyandu_problem_children_page",
  "eposyandu_exclusive_breastfeeding_page",
  "eposyandu_dashboard_stats",
  "eposyandu_sigizi_measurement_export",
]);

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const sql = neon(env.NEON_DATABASE_URL);
        await sql`select 1 as healthy`;
        return jsonResponse({ ok: true, service: "e-posyandu-neon-read", environment: env.ENVIRONMENT });
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
} satisfies ExportedHandler<Env>;
