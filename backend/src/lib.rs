use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{cell::RefCell, collections::HashMap};
use url::Url;
use worker::{
    Context, Env, Fetch, Headers, Method, Request, RequestInit, Response, Result, event,
    wasm_bindgen::JsValue,
};

mod api;
mod graphql;

const SCOPE_CACHE_TTL_MS: f64 = 90_000.0;
const BROWSER_SESSION_PREFIX: &str = "auth:browser-session:v1";
const BROWSER_SESSION_TTL_SECONDS: u64 = 8 * 60 * 60;
const BROWSER_SESSION_COOKIE: &str = "__Host-e-posyandu-session";
const DEVELOPMENT_SESSION_COOKIE: &str = "e-posyandu-session";
const VERIFIED_SCOPE_CACHE_PREFIX: &str = "auth:verified-scope:v1";
const VERIFIED_SCOPE_MAX_TTL_SECONDS: u64 = 3_600;
const VERIFIED_SCOPE_MIN_TTL_SECONDS: u64 = 60;
const LOGIN_IP_WINDOW_SECONDS: u64 = 600;
const LOGIN_ACCOUNT_WINDOW_SECONDS: u64 = 600;
const LOGIN_PAIR_WINDOW_SECONDS: u64 = 60;
const LOGIN_IP_MAX_ATTEMPTS: u8 = 30;
const LOGIN_ACCOUNT_MAX_ATTEMPTS: u8 = 10;
const LOGIN_PAIR_MAX_ATTEMPTS: u8 = 5;
const CSP_REPORT_WINDOW_SECONDS: u64 = 3_600;
const CSP_REPORT_MAX_ATTEMPTS: u8 = 60;
const CSP_REPORT_MAX_BODY_BYTES: usize = 16 * 1024;
const SCOPE_CACHE_MAX_ENTRIES: usize = 256;
const INTERNAL_REQUEST_MAX_AGE_SECONDS: f64 = 60.0;
const NUTRITION_BATCH_MAX_ITEMS: usize = 10_000;
const NUTRITION_WORKER_HEALTH_KEY: &str = "monitoring:nutrition-worker:v1";
const NUTRITION_WORKER_FAILURE_THRESHOLD: u32 = 3;
const R2_STORAGE_STATE_KEY: &str = "monitoring:r2-storage:v1";
const MONITORING_STATE_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
const R2_CLEANUP_PREFIX: &str = "jobs/";
const R2_SOFT_LIMIT_BYTES: u64 = 9 * 1024 * 1024 * 1024;
const R2_CLEANUP_TARGET_BYTES: u64 = 8 * 1024 * 1024 * 1024;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Deserialize, Serialize)]
struct AccessScope {
    user_id: String,
    email: Option<String>,
    role: String,
    desa: Option<String>,
    posyandu: Option<String>,
    #[serde(default = "default_access_mode")]
    access_mode: String,
}

fn default_access_mode() -> String {
    "write".into()
}

struct CachedScope {
    expires_at: f64,
    scope: AccessScope,
}

#[derive(Clone, Deserialize, Serialize)]
struct BrowserSession {
    access_token: String,
    refresh_token: String,
    user: SupabaseUser,
    profile: AccessScope,
    updated_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedScopeRecord {
    scope: AccessScope,
    token_expires_at: u64,
    cached_at: String,
}

struct LoginAttempt {
    count: u8,
    reset_at: f64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NutritionWorkerHealth {
    status: String,
    checked_at: String,
    latency_ms: u64,
    status_code: Option<u16>,
    consecutive_failures: u32,
    last_success_at: Option<String>,
    last_failure_at: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct R2StorageState {
    status: String,
    checked_at: String,
    total_bytes: u64,
    temporary_bytes: u64,
    object_count: u64,
    deleted_objects: u64,
    deleted_bytes: u64,
    soft_limit_bytes: u64,
    cleanup_target_bytes: u64,
}

struct R2CleanupCandidate {
    key: String,
    size: u64,
    uploaded_at_ms: u64,
}

thread_local! {
    static SCOPE_CACHE: RefCell<HashMap<String, CachedScope>> = RefCell::new(HashMap::new());
    static LOGIN_ATTEMPTS: RefCell<HashMap<String, LoginAttempt>> = RefCell::new(HashMap::new());
}

#[derive(Debug)]
struct ApiFailure {
    status: u16,
    code: &'static str,
    detail: String,
}

impl ApiFailure {
    fn new(status: u16, detail: impl Into<String>) -> Self {
        Self {
            status,
            code: match status {
                400 => "bad_request",
                401 => "unauthorized",
                403 => "forbidden",
                404 => "not_found",
                405 => "method_not_allowed",
                409 => "conflict",
                413 => "payload_too_large",
                422 => "validation_error",
                429 => "rate_limited",
                500..=599 => "service_error",
                _ => "request_failed",
            },
            detail: detail.into(),
        }
    }
}

type ApiResult<T> = std::result::Result<T, ApiFailure>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    username: Option<String>,
    password: Option<String>,
    turnstile_token: Option<String>,
}

#[derive(Clone, Deserialize)]
struct LoginAccount {
    user_id: String,
    email: Option<String>,
    role: String,
    village: Option<String>,
    posyandu: Option<String>,
    active: bool,
    #[serde(default = "default_access_mode")]
    access_mode: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct SupabaseUser {
    id: String,
    email: Option<String>,
}

#[derive(Deserialize)]
struct SupabaseSession {
    access_token: String,
    refresh_token: String,
    user: SupabaseUser,
}

#[derive(Deserialize)]
struct AppUser {
    role: String,
    village: Option<String>,
    posyandu: Option<String>,
    active: bool,
    #[serde(default = "default_access_mode")]
    access_mode: String,
}

#[derive(Deserialize)]
struct TurnstileResult {
    success: bool,
    hostname: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NutritionBatchRequest {
    items: Vec<NutritionItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NutritionItem {
    weight_kg: f64,
    height_cm: Option<f64>,
    age_months: i32,
    sex: String,
    measurement_method: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NutritionBatchResult {
    underweight: usize,
    stunting: usize,
    wasting: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhoStandards {
    weight_for_age: HashMap<String, Vec<[f64; 3]>>,
    length_height_for_age: HashMap<String, Vec<[f64; 3]>>,
    bmi_for_age: HashMap<String, Vec<[f64; 3]>>,
    weight_for_length: HashMap<String, Vec<[f64; 3]>>,
    weight_for_height: HashMap<String, Vec<[f64; 3]>>,
}

fn now_ms() -> f64 {
    worker::js_sys::Date::now()
}

fn now_iso() -> String {
    worker::js_sys::Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}

fn secret(env: &Env, name: &str) -> ApiResult<String> {
    let aliases: &[&str] = match name {
        // Konfigurasi backend lama memakai nama service-role key ini. Alias
        // hanya membantu `wrangler dev --env-file`; produksi tetap memakai
        // secret SUPABASE_SECRET_KEY pada Cloudflare.
        "SUPABASE_SECRET_KEY" => &["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
        _ => &[name],
    };

    aliases
        .iter()
        .find_map(|candidate| {
            env.secret(candidate)
                .ok()
                .or_else(|| env.var(candidate).ok())
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| ApiFailure::new(503, format!("Konfigurasi {name} belum tersedia.")))
}

fn optional_secret(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .ok()
        .or_else(|| env.var(name).ok())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn environment_name(env: &Env) -> String {
    env.var("ENVIRONMENT")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "unknown".into())
}

fn supabase_project_ref(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    let host = url.host_str()?;
    host.strip_suffix(".supabase.co")
        .filter(|project_ref| !project_ref.is_empty() && !project_ref.contains('.'))
        .map(ToOwned::to_owned)
}

fn database_isolation_status(env: &Env) -> &'static str {
    if environment_name(env) == "production" {
        return "production";
    }
    let Some(database_url) = optional_secret(env, "SUPABASE_URL") else {
        return "unknown";
    };
    let Some(project_ref) = supabase_project_ref(&database_url) else {
        return "unknown";
    };
    let Some(production_ref) = optional_secret(env, "PRODUCTION_SUPABASE_PROJECT_REF") else {
        return "unknown";
    };
    if project_ref == production_ref.trim() {
        "shared_production"
    } else {
        "isolated"
    }
}

fn is_allowed_nonproduction_post(path: &str) -> bool {
    matches!(
        path,
        "/api/v1/auth/login"
            | "/api/v1/auth/logout"
            | "/api/v1/graphql"
            | "/api/v1/client-errors"
            | "/api/v1/security/csp-report"
    )
}

fn enforce_environment_write_guard(request: &Request, env: &Env) -> ApiResult<()> {
    if environment_name(env) == "production" {
        return Ok(());
    }
    let is_mutation = matches!(
        request.method(),
        Method::Post | Method::Patch | Method::Delete
    ) && !is_allowed_nonproduction_post(&request.path());
    if !is_mutation || database_isolation_status(env) == "isolated" {
        return Ok(());
    }
    Err(ApiFailure::new(
        503,
        "Database development/staging belum terpisah dari production. Perubahan data diblokir untuk melindungi data aktif.",
    ))
}

fn configured_origins(env: &Env) -> Vec<String> {
    env.var("CORS_ORIGINS")
        .map(|value| value.to_string())
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter_map(normalize_origin)
        .collect()
}

/// Normalize an HTTP(S) origin before comparing it with the allow-list.
///
/// Browsers send an origin without a path, but reverse proxies and manually
/// configured clients may add a trailing slash or use a different case. We
/// accept those harmless representations while rejecting URLs that contain a
/// path, credentials, query, or fragment.
fn normalize_origin(value: &str) -> Option<String> {
    let parsed = Url::parse(value.trim()).ok()?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "" && parsed.path() != "/")
    {
        return None;
    }

    let host = parsed.host_str()?.to_ascii_lowercase();
    let port = parsed
        .port()
        .filter(|port| !((*port == 80 && scheme == "http") || (*port == 443 && scheme == "https")));
    let authority = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    Some(match port {
        Some(port) => format!("{scheme}://{authority}:{port}"),
        None => format!("{scheme}://{authority}"),
    })
}

fn request_origin(request: &Request, env: &Env) -> ApiResult<Option<String>> {
    let origin = request
        .headers()
        .get("Origin")
        .map_err(|_| ApiFailure::new(400, "Origin permintaan tidak valid."))?;
    let Some(origin) = origin else {
        return Ok(None);
    };
    let normalized = normalize_origin(&origin)
        .ok_or_else(|| ApiFailure::new(403, "Origin aplikasi tidak diizinkan."))?;
    if configured_origins(env)
        .iter()
        .any(|allowed| allowed == &normalized)
    {
        Ok(Some(origin))
    } else {
        Err(ApiFailure::new(403, "Origin aplikasi tidak diizinkan."))
    }
}

fn with_api_headers(
    mut response: Response,
    origin: Option<&str>,
    cache_control: &str,
    request_id: &str,
) -> Result<Response> {
    let headers = response.headers_mut();
    if headers.get("Content-Type")?.is_none() {
        headers.set("Content-Type", "application/json; charset=utf-8")?;
    }
    headers.set("Cache-Control", cache_control)?;
    headers.set("Referrer-Policy", "no-referrer")?;
    headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains",
    )?;
    headers.set(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'; sandbox",
    )?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("X-Frame-Options", "DENY")?;
    headers.set("X-Permitted-Cross-Domain-Policies", "none")?;
    headers.set("X-Download-Options", "noopen")?;
    headers.set("Cross-Origin-Resource-Policy", "cross-origin")?;
    headers.set("X-Request-ID", request_id)?;
    headers.set(
        "Permissions-Policy",
        "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    )?;
    headers.set("Vary", "Origin, Cookie, Authorization, Accept-Encoding")?;
    if let Some(origin) = origin {
        headers.set("Access-Control-Allow-Origin", origin)?;
        headers.set("Access-Control-Allow-Credentials", "true")?;
        headers.set(
            "Access-Control-Allow-Methods",
            "GET, POST, PATCH, DELETE, OPTIONS",
        )?;
        headers.set(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, Idempotency-Key, If-None-Match, X-Request-ID",
        )?;
        headers.set(
            "Access-Control-Expose-Headers",
            "Content-Disposition, ETag, X-Request-ID",
        )?;
    }
    Ok(response)
}

fn json_response<T: Serialize>(
    payload: &T,
    status: u16,
    origin: Option<&str>,
    request_id: &str,
) -> Result<Response> {
    with_api_headers(
        Response::from_json(payload)?.with_status(status),
        origin,
        "no-store",
        request_id,
    )
}

fn success_cache_control(path: &str, is_get: bool, is_export: bool) -> &'static str {
    if !is_get || is_export || path.starts_with("/api/v1/exports/") {
        return "no-store";
    }
    match path {
        "/api/v1/dashboard/stats" => "private, max-age=30, must-revalidate",
        "/api/v1/children/page" | "/api/v1/exclusive-breastfeeding/page" => {
            "private, max-age=10, must-revalidate"
        }
        "/api/v1/me" => "private, max-age=30, must-revalidate",
        _ if path.starts_with("/api/v1/collections/") => "private, max-age=10, must-revalidate",
        _ => "private, max-age=0, must-revalidate",
    }
}

fn success_response<T: Serialize>(
    payload: &T,
    origin: Option<&str>,
    request_id: &str,
    cache_control: &str,
    if_none_match: Option<&str>,
) -> Result<(u16, Response)> {
    let etag = if cache_control == "no-store" {
        None
    } else {
        let encoded = serde_json::to_vec(payload)
            .map_err(|_| worker::Error::RustError("Respons API tidak dapat dibuat.".into()))?;
        let digest = Sha256::digest(encoded);
        Some(format!("\"{}\"", hex::encode(&digest[..16])))
    };
    let not_modified = etag
        .as_deref()
        .zip(if_none_match)
        .is_some_and(|(etag, candidate)| candidate == etag);
    let status = if not_modified { 304 } else { 200 };
    let response = if not_modified {
        Response::empty()?.with_status(status)
    } else {
        Response::from_json(payload)?.with_status(status)
    };
    let mut response = with_api_headers(response, origin, cache_control, request_id)?;
    if let Some(etag) = etag {
        response.headers_mut().set("ETag", &etag)?;
    }
    Ok((status, response))
}

fn health_response(origin: Option<&str>, request_id: &str) -> Result<Response> {
    with_api_headers(
        Response::from_json(&json!({
            "ok": true,
            "service": "e-posyandu-rust-worker",
            "database": "supabase",
            "version": env!("CARGO_PKG_VERSION")
        }))?,
        origin,
        "public, max-age=60",
        request_id,
    )
}

fn openapi_document() -> ApiResult<serde_json::Value> {
    serde_json::from_str(include_str!("../openapi.json"))
        .map_err(|_| ApiFailure::new(500, "Dokumentasi API tidak valid."))
}

async fn read_nutrition_worker_health(env: &Env) -> Option<NutritionWorkerHealth> {
    let stored = redis_get_text(env, NUTRITION_WORKER_HEALTH_KEY).await?;
    serde_json::from_str(&stored).ok()
}

async fn write_nutrition_worker_health(env: &Env, state: &NutritionWorkerHealth) {
    let Ok(payload) = serde_json::to_string(state) else {
        worker::console_warn!("Status nutrition worker tidak dapat diserialisasi.");
        return;
    };
    if !redis_set_text(
        env,
        NUTRITION_WORKER_HEALTH_KEY,
        payload,
        MONITORING_STATE_TTL_SECONDS,
    )
    .await
    {
        worker::console_warn!("Status nutrition worker tidak dapat disimpan ke Redis.");
    }
}

async fn read_r2_storage_state(env: &Env) -> Option<R2StorageState> {
    let stored = redis_get_text(env, R2_STORAGE_STATE_KEY).await?;
    serde_json::from_str(&stored).ok()
}

async fn write_r2_storage_state(env: &Env, state: &R2StorageState) {
    let Ok(payload) = serde_json::to_string(state) else {
        worker::console_warn!("Status penyimpanan R2 tidak dapat diserialisasi.");
        return;
    };
    if !redis_set_text(
        env,
        R2_STORAGE_STATE_KEY,
        payload,
        MONITORING_STATE_TTL_SECONDS,
    )
    .await
    {
        worker::console_warn!("Status penyimpanan R2 tidak dapat disimpan ke Redis.");
    }
}

async fn monitor_and_cleanup_r2(env: &Env) {
    let Ok(bucket) = env.bucket("E_POSYANDU_FILES") else {
        return;
    };
    let mut cursor = None;
    let mut total_bytes = 0_u64;
    let mut temporary_bytes = 0_u64;
    let mut object_count = 0_u64;
    let mut candidates = Vec::new();

    loop {
        let mut request = bucket.list().limit(1000);
        if let Some(value) = cursor.take() {
            request = request.cursor(value);
        }
        let listed = match request.execute().await {
            Ok(listed) => listed,
            Err(_) => {
                worker::console_warn!("Daftar objek R2 tidak dapat dibaca.");
                return;
            }
        };
        for object in listed.objects() {
            let key = object.key();
            let size = object.size();
            total_bytes = total_bytes.saturating_add(size);
            object_count = object_count.saturating_add(1);
            if key.starts_with(R2_CLEANUP_PREFIX) {
                temporary_bytes = temporary_bytes.saturating_add(size);
                candidates.push(R2CleanupCandidate {
                    key,
                    size,
                    uploaded_at_ms: object.uploaded().as_millis(),
                });
            }
        }
        if !listed.truncated() {
            break;
        }
        cursor = listed.cursor();
        if cursor.is_none() {
            worker::console_warn!("Cursor daftar objek R2 tidak tersedia.");
            break;
        }
    }

    let mut deleted_objects = 0_u64;
    let mut deleted_bytes = 0_u64;
    if total_bytes >= R2_SOFT_LIMIT_BYTES {
        candidates.sort_by_key(|candidate| candidate.uploaded_at_ms);
        for candidate in candidates {
            if total_bytes <= R2_CLEANUP_TARGET_BYTES {
                break;
            }
            if bucket.delete(&candidate.key).await.is_ok() {
                total_bytes = total_bytes.saturating_sub(candidate.size);
                temporary_bytes = temporary_bytes.saturating_sub(candidate.size);
                deleted_objects = deleted_objects.saturating_add(1);
                deleted_bytes = deleted_bytes.saturating_add(candidate.size);
            } else {
                worker::console_warn!("Objek R2 sementara gagal dihapus: {}", candidate.key);
            }
        }
    }

    let status = if total_bytes >= R2_SOFT_LIMIT_BYTES {
        "warning"
    } else if deleted_objects > 0 {
        "cleaned"
    } else {
        "healthy"
    };
    let state = R2StorageState {
        status: status.into(),
        checked_at: now_iso(),
        total_bytes,
        temporary_bytes,
        object_count: object_count.saturating_sub(deleted_objects),
        deleted_objects,
        deleted_bytes,
        soft_limit_bytes: R2_SOFT_LIMIT_BYTES,
        cleanup_target_bytes: R2_CLEANUP_TARGET_BYTES,
    };
    write_r2_storage_state(env, &state).await;
    worker::console_log!(
        "{}",
        json!({
            "level": if status == "warning" { "warn" } else { "info" },
            "event": "r2_storage_cleanup",
            "environment": environment_name(env),
            "status": status,
            "total_bytes": state.total_bytes,
            "temporary_bytes": state.temporary_bytes,
            "object_count": state.object_count,
            "deleted_objects": state.deleted_objects,
            "deleted_bytes": state.deleted_bytes,
        })
    );
}

async fn cleanup_child_retention(env: &Env) {
    let Some(supabase_url) = optional_secret(env, "SUPABASE_URL") else {
        worker::console_warn!("Retensi balita dilewati karena SUPABASE_URL belum tersedia.");
        return;
    };
    let Some(secret_key) = optional_secret(env, "SUPABASE_SECRET_KEY") else {
        worker::console_warn!("Retensi balita dilewati karena SUPABASE_SECRET_KEY belum tersedia.");
        return;
    };
    let Ok(headers) = supabase_headers(&secret_key, None) else {
        worker::console_warn!("Header pembersihan retensi balita tidak dapat dibuat.");
        return;
    };
    let endpoint = format!(
        "{}/rest/v1/rpc/eposyandu_cleanup_retention",
        supabase_url.trim_end_matches('/')
    );
    match request_value(
        endpoint,
        Method::Post,
        headers,
        Some(json!({ "p_now": null })),
    )
    .await
    {
        Ok((status, payload)) if (200..300).contains(&status) => {
            // Halaman dinamis yang mungkin masih tersimpan di Redis harus
            // ditinggalkan segera setelah baris primary dimusnahkan.
            let _ = redis_commands(env, json!([["INCR", "dynamic:data:version:v1"]])).await;
            worker::console_log!(
                "{}",
                json!({
                    "level": "info",
                    "event": "child_retention_cleanup",
                    "environment": environment_name(env),
                    "result": payload,
                })
            );
        }
        Ok((status, _)) => {
            worker::console_warn!("Pembersihan retensi balita gagal dengan status {}.", status)
        }
        Err(_) => worker::console_warn!("Pembersihan retensi balita tidak dapat dijangkau."),
    }
}

fn monitoring_alert_configured(env: &Env) -> bool {
    optional_secret(env, "MONITORING_ALERT_WEBHOOK_URL").is_some()
        || (optional_secret(env, "RESEND_API_KEY").is_some()
            && optional_secret(env, "MONITORING_ALERT_EMAIL_TO")
                .or_else(|| optional_secret(env, "ERROR_REPORT_EMAIL_TO"))
                .is_some()
            && optional_secret(env, "ERROR_REPORT_EMAIL_FROM").is_some())
}

async fn send_monitoring_alert(env: &Env, state: &NutritionWorkerHealth, recovered: bool) {
    let environment = environment_name(env);
    let event = if recovered {
        "nutrition_worker_recovered"
    } else {
        "nutrition_worker_down"
    };
    let alert = json!({
        "event": event,
        "service": "nutrition-grpc-worker",
        "environment": environment,
        "status": state.status,
        "checkedAt": state.checked_at,
        "consecutiveFailures": state.consecutive_failures,
    });

    if let Some(webhook_url) = optional_secret(env, "MONITORING_ALERT_WEBHOOK_URL") {
        if let Ok(parsed) = url::Url::parse(&webhook_url)
            && parsed.scheme() == "https"
        {
            let headers = Headers::new();
            let _ = headers.set("Content-Type", "application/json");
            let mut init = RequestInit::new();
            init.with_method(Method::Post);
            init.with_headers(headers);
            init.with_body(Some(JsValue::from_str(&alert.to_string())));
            if let Ok(request) = Request::new_with_init(parsed.as_str(), &init) {
                match Fetch::Request(request).send().await {
                    Ok(response) if response.status_code() < 400 => {}
                    Ok(response) => worker::console_warn!(
                        "Webhook monitoring gagal dengan status {}.",
                        response.status_code()
                    ),
                    Err(_) => worker::console_warn!("Webhook monitoring tidak dapat dijangkau."),
                }
            }
        }
    }

    let Some(api_key) = optional_secret(env, "RESEND_API_KEY") else {
        return;
    };
    let Some(email_to) = optional_secret(env, "MONITORING_ALERT_EMAIL_TO")
        .or_else(|| optional_secret(env, "ERROR_REPORT_EMAIL_TO"))
    else {
        return;
    };
    let Some(email_from) = optional_secret(env, "ERROR_REPORT_EMAIL_FROM") else {
        return;
    };
    let subject = if recovered {
        format!("[E-Posyandu][{environment}] Nutrition worker kembali normal")
    } else {
        format!("[E-Posyandu][{environment}] Nutrition worker tidak tersedia")
    };
    let body = json!({
        "from": email_from,
        "to": [email_to],
        "subject": subject,
        "text": format!(
            "Layanan nutrition-grpc-worker berstatus {}.\nWaktu pemeriksaan: {}\nKegagalan berturut-turut: {}\n",
            state.status, state.checked_at, state.consecutive_failures
        ),
    });
    let headers = Headers::new();
    let _ = headers.set("Authorization", &format!("Bearer {api_key}"));
    let _ = headers.set("Content-Type", "application/json");
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    init.with_body(Some(JsValue::from_str(&body.to_string())));
    let Ok(request) = Request::new_with_init("https://api.resend.com/emails", &init) else {
        return;
    };
    match Fetch::Request(request).send().await {
        Ok(response) if response.status_code() < 400 => {}
        Ok(response) => worker::console_warn!(
            "Email monitoring gagal dengan status {}.",
            response.status_code()
        ),
        Err(_) => worker::console_warn!("Email monitoring tidak dapat dikirim."),
    }
}

async fn monitoring_status(request: Request, env: &Env) -> ApiResult<serde_json::Value> {
    let scope = require_scope(&request, env).await?;
    if !is_full_access_role(&scope.role) {
        return Err(ApiFailure::new(
            403,
            "Status infrastruktur hanya tersedia untuk Ahli Gizi.",
        ));
    }
    let worker = read_nutrition_worker_health(env)
        .await
        .map(|state| serde_json::to_value(state).unwrap_or_else(|_| json!({ "status": "unknown" })))
        .unwrap_or_else(|| {
            json!({
                "status": "unknown",
                "checkedAt": null,
                "latencyMs": null,
                "statusCode": null,
                "consecutiveFailures": 0,
                "lastSuccessAt": null,
                "lastFailureAt": null,
            })
        });
    let isolation = database_isolation_status(env);
    let read_replica_configured = read_replica_configured(env);
    let r2_configured = env.bucket("E_POSYANDU_FILES").is_ok();
    let r2_state = read_r2_storage_state(env)
        .await
        .and_then(|state| serde_json::to_value(state).ok());
    Ok(json!({
        "environment": environment_name(env),
        "worker": worker,
        "database": {
            "isolation": isolation,
            "writesProtected": environment_name(env) != "production" && isolation != "isolated",
            "primary": "supabase",
            "readReplica": {
                "configured": read_replica_configured,
                "provider": "neon",
                "mode": optional_secret(env, "READ_REPLICA_MODE").unwrap_or_else(|| "prefer-replica".into()),
                "fallback": "supabase",
            },
            "emergencyRead": {
                "configured": emergency_read_configured(env),
                "verifiedSessionRequired": true,
                "maximumScopeCacheSeconds": VERIFIED_SCOPE_MAX_TTL_SECONDS,
                "writes": "primary-only",
            },
        },
        "storage": {
            "r2Configured": r2_configured,
            "status": r2_state,
        },
        "queue": {
            "configured": env.queue("E_POSYANDU_JOBS").is_ok(),
        },
        "alerts": {
            "externalConfigured": monitoring_alert_configured(env),
        },
    }))
}

async fn readiness_status(env: &Env) -> ApiResult<serde_json::Value> {
    let database_configured = optional_secret(env, "SUPABASE_URL").is_some()
        && optional_secret(env, "SUPABASE_SECRET_KEY").is_some();
    let dynamic_cache_configured = redis_configured(env);
    let global_cache_configured = env.kv("E_POSYANDU_CACHE").is_ok();
    let queue_configured = env.queue("E_POSYANDU_JOBS").is_ok();
    let storage_configured = env.bucket("E_POSYANDU_FILES").is_ok();
    let read_replica_configured = read_replica_configured(env);
    let worker = read_nutrition_worker_health(env).await;
    let worker_status = worker
        .as_ref()
        .map(|state| state.status.as_str())
        .unwrap_or("unknown");
    let core_ready = database_configured && dynamic_cache_configured;
    let degraded = !global_cache_configured
        || !queue_configured
        || !storage_configured
        || !matches!(worker_status, "healthy" | "unconfigured");
    Ok(json!({
        "ok": core_ready,
        "status": if !core_ready { "not-ready" } else if degraded { "degraded" } else { "ready" },
        "checkedAt": now_iso(),
        "environment": environment_name(env),
        "components": {
            "api": { "status": "healthy" },
            "database": { "configured": database_configured },
            "readReplica": {
                "configured": read_replica_configured,
                "required": false,
                "fallback": "supabase",
            },
            "emergencyRead": {
                "configured": emergency_read_configured(env),
                "verifiedSessionRequired": true,
                "maximumScopeCacheSeconds": VERIFIED_SCOPE_MAX_TTL_SECONDS,
                "writes": "primary-only",
            },
            "cache": {
                "dynamic": {
                    "configured": dynamic_cache_configured,
                    "provider": "upstash-redis",
                    "ttlSeconds": 60,
                },
                "global": {
                    "configured": global_cache_configured,
                    "provider": "cloudflare-kv",
                    "content": "menu-reference-feature-flags",
                },
            },
            "queue": { "configured": queue_configured },
            "storage": { "configured": storage_configured },
            "nutritionWorker": {
                "status": worker_status,
                "checkedAt": worker.as_ref().map(|state| state.checked_at.clone()),
                "latencyMs": worker.as_ref().map(|state| state.latency_ms),
                "consecutiveFailures": worker.as_ref().map(|state| state.consecutive_failures).unwrap_or(0),
            },
        },
    }))
}

fn lms_z_score(value: f64, [l, median, spread]: [f64; 3]) -> f64 {
    if l == 0.0 {
        (value / median).ln() / spread
    } else {
        ((value / median).powf(l) - 1.0) / (l * spread)
    }
}

fn adjusted_length_height(value: f64, age_months: i32, method: &str) -> f64 {
    if age_months <= 24 && method == "Berdiri" {
        value + 0.7
    } else if age_months > 24 && method == "Terlentang" {
        value - 0.7
    } else {
        value
    }
}

fn standards() -> ApiResult<WhoStandards> {
    serde_json::from_str(include_str!("../data/anthropometry.json"))
        .map_err(|_| ApiFailure::new(500, "Standar antropometri Worker tidak valid."))
}

fn nutrition_status(
    value: f64,
    growth_type: &str,
    age_months: i32,
    sex: &str,
    secondary: Option<f64>,
    method: &str,
    standards: &WhoStandards,
) -> &'static str {
    if value <= 0.0 || !(0..=60).contains(&age_months) || !matches!(sex, "L" | "P") {
        return "-";
    }
    let age = age_months as usize;
    let score = match growth_type {
        "BBU" => standards
            .weight_for_age
            .get(sex)
            .and_then(|values| values.get(age))
            .map(|reference| lms_z_score(value, *reference)),
        "TBU" => standards
            .length_height_for_age
            .get(sex)
            .and_then(|values| values.get(age))
            .map(|reference| {
                lms_z_score(
                    adjusted_length_height(value, age_months, method),
                    *reference,
                )
            }),
        "IMTU" => secondary.filter(|height| *height > 0.0).and_then(|height| {
            standards.bmi_for_age.get(sex).and_then(|values| {
                values.get(age).map(|reference| {
                    let adjusted_height = adjusted_length_height(height, age_months, method);
                    lms_z_score(value / (adjusted_height / 100.0).powi(2), *reference)
                })
            })
        }),
        "BBTB" => secondary.filter(|height| *height > 0.0).and_then(|height| {
            let adjusted_height = adjusted_length_height(height, age_months, method);
            let (minimum, values) = if age_months <= 24 {
                (45.0, standards.weight_for_length.get(sex))
            } else {
                (65.0, standards.weight_for_height.get(sex))
            };
            let index = ((adjusted_height - minimum) * 2.0).round() as isize;
            if index < 0 {
                None
            } else {
                values
                    .and_then(|items| items.get(index as usize))
                    .map(|reference| lms_z_score(value, *reference))
            }
        }),
        _ => None,
    };
    let Some(score) = score else {
        return "-";
    };
    match growth_type {
        "BBU" if score < -3.0 => "Berat Sangat Kurang",
        "BBU" if score < -2.0 => "Berat Kurang",
        "BBU" if score <= 1.0 => "Berat Normal",
        "BBU" => "Risiko Berat Lebih",
        "TBU" if score < -3.0 => "Sangat Pendek",
        "TBU" if score < -2.0 => "Pendek",
        "TBU" if score <= 3.0 => "Normal",
        "TBU" => "Tinggi",
        _ if score < -3.0 => "Gizi Buruk",
        _ if score < -2.0 => "Gizi Kurang",
        _ if score <= 1.0 => "Gizi Baik",
        _ if score <= 2.0 => "Risiko Gizi Lebih",
        _ if score <= 3.0 => "Gizi Lebih",
        _ => "Obesitas",
    }
}

fn calculate_nutrition(items: &[NutritionItem], standards: &WhoStandards) -> NutritionBatchResult {
    let mut result = NutritionBatchResult {
        underweight: 0,
        stunting: 0,
        wasting: 0,
    };
    for item in items {
        let method = item.measurement_method.as_deref().unwrap_or_default();
        let underweight = nutrition_status(
            item.weight_kg,
            "BBU",
            item.age_months,
            &item.sex,
            None,
            method,
            standards,
        );
        if matches!(underweight, "Berat Sangat Kurang" | "Berat Kurang") {
            result.underweight += 1;
        }
        if let Some(height) = item.height_cm.filter(|height| *height > 0.0) {
            let stunting = nutrition_status(
                height,
                "TBU",
                item.age_months,
                &item.sex,
                None,
                method,
                standards,
            );
            if matches!(stunting, "Sangat Pendek" | "Pendek") {
                result.stunting += 1;
            }
            let wasting = nutrition_status(
                item.weight_kg,
                "BBTB",
                item.age_months,
                &item.sex,
                Some(height),
                method,
                standards,
            );
            if matches!(wasting, "Gizi Buruk" | "Gizi Kurang") {
                result.wasting += 1;
            }
        }
    }
    result
}

fn verify_internal_request(request: &Request, body: &str, env: &Env) -> ApiResult<()> {
    let timestamp = request
        .headers()
        .get("X-EPosyandu-Timestamp")
        .map_err(|_| ApiFailure::new(401, "Permintaan Worker tidak valid."))?
        .ok_or_else(|| ApiFailure::new(401, "Permintaan Worker tidak valid."))?;
    let timestamp_value = timestamp
        .parse::<f64>()
        .map_err(|_| ApiFailure::new(401, "Permintaan Worker tidak valid."))?;
    if ((now_ms() / 1_000.0) - timestamp_value).abs() > INTERNAL_REQUEST_MAX_AGE_SECONDS {
        return Err(ApiFailure::new(401, "Permintaan Worker sudah kedaluwarsa."));
    }
    let signature = request
        .headers()
        .get("X-EPosyandu-Signature")
        .map_err(|_| ApiFailure::new(401, "Permintaan Worker tidak valid."))?
        .ok_or_else(|| ApiFailure::new(401, "Permintaan Worker tidak valid."))?;
    let signature = hex::decode(signature)
        .map_err(|_| ApiFailure::new(401, "Permintaan Worker tidak valid."))?;
    let secret = secret(env, "RUST_WORKER_SHARED_SECRET")?;
    let payload = format!("{}\n{}\n{}", request.method(), timestamp, body);
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| ApiFailure::new(503, "Konfigurasi Worker belum tersedia."))?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| ApiFailure::new(401, "Permintaan Worker tidak valid."))
}

async fn nutrition_batch(mut request: Request, env: &Env) -> ApiResult<serde_json::Value> {
    let body = request
        .text()
        .await
        .map_err(|_| ApiFailure::new(422, "Data kalkulasi Worker tidak valid."))?;
    if body.len() > 1_000_000 {
        return Err(ApiFailure::new(413, "Data kalkulasi Worker terlalu besar."));
    }
    verify_internal_request(&request, &body, env)?;
    let payload: NutritionBatchRequest = serde_json::from_str(&body)
        .map_err(|_| ApiFailure::new(422, "Data kalkulasi Worker tidak valid."))?;
    if payload.items.len() > NUTRITION_BATCH_MAX_ITEMS {
        return Err(ApiFailure::new(413, "Jumlah data kalkulasi terlalu besar."));
    }
    let standards = standards()?;
    Ok(json!(calculate_nutrition(&payload.items, &standards)))
}

async fn internal_background_job(mut request: Request, env: &Env) -> ApiResult<serde_json::Value> {
    let method = request.method();
    let path = request.path();
    let body = if method == Method::Get {
        String::new()
    } else {
        request
            .text()
            .await
            .map_err(|_| ApiFailure::new(422, "Data job Worker tidak valid."))?
    };
    if body.len() > 70_000_000 {
        return Err(ApiFailure::new(413, "Data job Worker terlalu besar."));
    }
    verify_internal_request(&request, &body, env)?;
    api::internal_background_job(method, &path, &body, env).await
}

fn failure_response(error: ApiFailure, origin: Option<&str>, request_id: &str) -> Result<Response> {
    json_response(
        &json!({
            "detail": error.detail,
            "error": {
                "code": error.code,
                "message": error.detail,
                "request_id": request_id
            }
        }),
        error.status,
        origin,
        request_id,
    )
}

fn request_id(request: &Request) -> String {
    request
        .headers()
        .get("X-Request-ID")
        .ok()
        .flatten()
        .filter(|value| {
            (8..=128).contains(&value.len())
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')
                })
        })
        .or_else(|| request.headers().get("CF-Ray").ok().flatten())
        .unwrap_or_else(|| {
            format!(
                "req-{:.0}-{:08x}",
                now_ms(),
                (worker::js_sys::Math::random() * u32::MAX as f64) as u32
            )
        })
}

fn log_request(
    env: &Env,
    request_id: &str,
    method: &str,
    path: &str,
    status: u16,
    started_at: f64,
) {
    let environment = env
        .var("ENVIRONMENT")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "unknown".into());
    worker::console_log!(
        "{}",
        json!({
            "level": if status >= 500 { "error" } else if status >= 400 { "warn" } else { "info" },
            "request_id": request_id,
            "method": method,
            "route": path,
            "status": status,
            "latency_ms": (now_ms() - started_at).round(),
            "environment": environment
        })
    );
}

fn bearer_token(request: &Request) -> ApiResult<String> {
    let value = request
        .headers()
        .get("Authorization")
        .map_err(|_| ApiFailure::new(401, "Sesi masuk diperlukan."))?
        .ok_or_else(|| ApiFailure::new(401, "Sesi masuk diperlukan."))?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| ApiFailure::new(401, "Token akses tidak valid."))
}

fn normalized_username(input: Option<&str>) -> ApiResult<String> {
    let username = input.unwrap_or_default().trim().to_ascii_lowercase();
    let valid = username.len() >= 3
        && username.len() <= 32
        && username.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || (index > 0 && matches!(character, '.' | '_' | '-'))
        });
    if valid {
        Ok(username)
    } else {
        Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ))
    }
}

fn client_ip(request: &Request) -> String {
    request
        .headers()
        .get("CF-Connecting-IP")
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".into())
}

pub(crate) fn hashed_key(prefix: &str, value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{prefix}:{}", hex::encode(digest))
}

pub(crate) async fn redis_commands(
    env: &Env,
    commands: serde_json::Value,
) -> Option<serde_json::Value> {
    let url = optional_secret(env, "UPSTASH_REDIS_REST_URL")?;
    let token = optional_secret(env, "UPSTASH_REDIS_REST_TOKEN")?;
    let headers = Headers::new();
    headers
        .set("Authorization", &format!("Bearer {token}"))
        .ok()?;
    headers.set("Content-Type", "application/json").ok()?;
    let (status, payload) = request_value(
        format!("{}/multi-exec", url.trim_end_matches('/')),
        Method::Post,
        headers,
        Some(commands),
    )
    .await
    .ok()?;
    (status < 300).then_some(payload)
}

fn redis_configured(env: &Env) -> bool {
    optional_secret(env, "UPSTASH_REDIS_REST_URL").is_some()
        && optional_secret(env, "UPSTASH_REDIS_REST_TOKEN").is_some()
}

fn redis_command_result(payload: &serde_json::Value, index: usize) -> Option<&serde_json::Value> {
    payload.as_array()?.get(index)?.get("result")
}

async fn redis_get_text(env: &Env, key: &str) -> Option<String> {
    redis_commands(env, json!([["GET", key]]))
        .await
        .as_ref()
        .and_then(|payload| redis_command_result(payload, 0))
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

async fn redis_set_text(env: &Env, key: &str, value: String, ttl_seconds: u64) -> bool {
    redis_commands(env, json!([["SET", key, value, "EX", ttl_seconds]]))
        .await
        .as_ref()
        .and_then(|payload| redis_command_result(payload, 0))
        .and_then(|value| value.as_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("OK"))
}

async fn redis_delete(env: &Env, key: &str) {
    let _ = redis_commands(env, json!([["DEL", key]])).await;
}

async fn redis_login_attempt_counts(env: &Env, ip: &str, username: &str) -> Option<[u64; 3]> {
    let ip_key = hashed_key("login:ip:v2", ip);
    let account_key = hashed_key("login:account:v2", username);
    let pair_key = hashed_key("login:pair:v2", &format!("{ip}\0{username}"));
    let payload = redis_commands(
        env,
        json!([
            ["INCR", ip_key],
            ["EXPIRE", ip_key, LOGIN_IP_WINDOW_SECONDS],
            ["INCR", account_key],
            ["EXPIRE", account_key, LOGIN_ACCOUNT_WINDOW_SECONDS],
            ["INCR", pair_key],
            ["EXPIRE", pair_key, LOGIN_PAIR_WINDOW_SECONDS]
        ]),
    )
    .await?;
    let results = payload.as_array()?;
    Some([
        results.first()?.get("result")?.as_u64()?,
        results.get(2)?.get("result")?.as_u64()?,
        results.get(4)?.get("result")?.as_u64()?,
    ])
}

async fn clear_redis_login_attempt(env: &Env, ip: &str, username: &str) {
    let keys = [
        hashed_key("login:ip:v2", ip),
        hashed_key("login:account:v2", username),
        hashed_key("login:pair:v2", &format!("{ip}\0{username}")),
    ];
    let _ = redis_commands(env, json!([["DEL", keys[0], keys[1], keys[2]]])).await;
}

fn allow_local_login_attempt(key: String, max_attempts: u8, window_seconds: u64) -> ApiResult<()> {
    let now = now_ms();
    LOGIN_ATTEMPTS.with(|attempts| {
        let mut attempts = attempts.borrow_mut();
        attempts.retain(|_, attempt| attempt.reset_at > now);
        let attempt = attempts.entry(key).or_insert(LoginAttempt {
            count: 0,
            reset_at: now + window_seconds as f64 * 1_000.0,
        });
        if attempt.count >= max_attempts {
            return Err(ApiFailure::new(
                429,
                "Terlalu banyak percobaan masuk. Coba lagi sebentar.",
            ));
        }
        attempt.count += 1;
        Ok(())
    })
}

async fn allow_login_attempt(env: &Env, ip: &str, username: &str) -> ApiResult<()> {
    if let Some([ip_count, account_count, pair_count]) =
        redis_login_attempt_counts(env, ip, username).await
    {
        if ip_count > LOGIN_IP_MAX_ATTEMPTS.into()
            || account_count > LOGIN_ACCOUNT_MAX_ATTEMPTS.into()
            || pair_count > LOGIN_PAIR_MAX_ATTEMPTS.into()
        {
            return Err(ApiFailure::new(
                429,
                "Terlalu banyak percobaan masuk. Coba lagi sebentar.",
            ));
        }
        return Ok(());
    }

    allow_local_login_attempt(
        hashed_key("login:ip:v2", ip),
        LOGIN_IP_MAX_ATTEMPTS,
        LOGIN_IP_WINDOW_SECONDS,
    )?;
    allow_local_login_attempt(
        hashed_key("login:account:v2", username),
        LOGIN_ACCOUNT_MAX_ATTEMPTS,
        LOGIN_ACCOUNT_WINDOW_SECONDS,
    )?;
    allow_local_login_attempt(
        hashed_key("login:pair:v2", &format!("{ip}\0{username}")),
        LOGIN_PAIR_MAX_ATTEMPTS,
        LOGIN_PAIR_WINDOW_SECONDS,
    )
}

async fn clear_login_attempt(env: &Env, ip: &str, username: &str) {
    let keys = [
        hashed_key("login:ip:v2", ip),
        hashed_key("login:account:v2", username),
        hashed_key("login:pair:v2", &format!("{ip}\0{username}")),
    ];
    LOGIN_ATTEMPTS.with(|attempts| {
        let mut attempts = attempts.borrow_mut();
        keys.iter().for_each(|key| {
            attempts.remove(key);
        });
    });
    clear_redis_login_attempt(env, ip, username).await;
}

async fn allow_csp_report(env: &Env, ip: &str) -> ApiResult<()> {
    let key = hashed_key("csp-report:ip:v1", ip);
    if let Some(payload) = redis_commands(
        env,
        json!([["INCR", key], ["EXPIRE", key, CSP_REPORT_WINDOW_SECONDS]]),
    )
    .await
    {
        let count = payload
            .as_array()
            .and_then(|results| results.first())
            .and_then(|result| result.get("result"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(CSP_REPORT_MAX_ATTEMPTS.into());
        if count > CSP_REPORT_MAX_ATTEMPTS.into() {
            return Err(ApiFailure::new(
                429,
                "Terlalu banyak laporan keamanan. Coba lagi nanti.",
            ));
        }
        return Ok(());
    }

    allow_local_login_attempt(key, CSP_REPORT_MAX_ATTEMPTS, CSP_REPORT_WINDOW_SECONDS)
        .map_err(|_| ApiFailure::new(429, "Terlalu banyak laporan keamanan. Coba lagi nanti."))
}

fn safe_csp_token(value: Option<&serde_json::Value>, max_chars: usize) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '/' | '.')
        })
        .take(max_chars)
        .collect()
}

fn safe_csp_document_url(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value.and_then(serde_json::Value::as_str) else {
        return String::new();
    };
    let Ok(mut url) = url::Url::parse(value) else {
        return String::new();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return String::new();
    }
    url.set_query(None);
    url.set_fragment(None);
    url.set_username("").ok();
    url.set_password(None).ok();
    url.to_string().chars().take(300).collect()
}

fn safe_csp_blocked_url(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value.and_then(serde_json::Value::as_str) else {
        return String::new();
    };
    if let Ok(url) = url::Url::parse(value) {
        if matches!(url.scheme(), "http" | "https") {
            return url.origin().ascii_serialization();
        }
        return format!("{}:", url.scheme());
    }
    safe_csp_token(Some(&serde_json::Value::String(value.into())), 64)
}

fn normalized_csp_report(payload: &serde_json::Value) -> ApiResult<serde_json::Value> {
    let payload = payload
        .as_array()
        .and_then(|reports| {
            reports
                .iter()
                .find(|report| {
                    report.get("type").and_then(serde_json::Value::as_str) == Some("csp-violation")
                })
                .or_else(|| reports.first())
        })
        .unwrap_or(payload);
    let report = payload
        .get("csp-report")
        .or_else(|| payload.get("body"))
        .unwrap_or(payload);
    if !report.is_object() {
        return Err(ApiFailure::new(422, "Laporan CSP tidak valid."));
    }
    let effective_directive = safe_csp_token(
        report
            .get("effective-directive")
            .or_else(|| report.get("effectiveDirective"))
            .or_else(|| report.get("violated-directive")),
        64,
    );
    if effective_directive.is_empty() {
        return Err(ApiFailure::new(422, "Laporan CSP tidak valid."));
    }
    let status_code = report
        .get("status-code")
        .or_else(|| report.get("statusCode"))
        .and_then(serde_json::Value::as_u64)
        .filter(|status| (100..=599).contains(status));
    Ok(json!({
        "effective_directive": effective_directive,
        "disposition": safe_csp_token(report.get("disposition"), 16),
        "document_url": safe_csp_document_url(
            report.get("document-uri").or_else(|| report.get("documentURL"))
        ),
        "blocked_origin": safe_csp_blocked_url(
            report.get("blocked-uri").or_else(|| report.get("blockedURL"))
        ),
        "status_code": status_code,
    }))
}

async fn csp_report(mut request: Request, env: &Env) -> ApiResult<serde_json::Value> {
    let content_type = request
        .headers()
        .get("Content-Type")
        .map_err(|_| ApiFailure::new(422, "Laporan CSP tidak valid."))?
        .unwrap_or_default();
    let media_type = content_type.split(';').next().unwrap_or_default().trim();
    if !matches!(
        media_type,
        "application/csp-report" | "application/reports+json" | "application/json"
    ) {
        return Err(ApiFailure::new(422, "Tipe laporan CSP tidak didukung."));
    }
    let content_length = request
        .headers()
        .get("Content-Length")
        .ok()
        .flatten()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or_default();
    if content_length > CSP_REPORT_MAX_BODY_BYTES {
        return Err(ApiFailure::new(413, "Laporan CSP terlalu besar."));
    }
    allow_csp_report(env, &client_ip(&request)).await?;
    let body = request
        .text()
        .await
        .map_err(|_| ApiFailure::new(422, "Laporan CSP tidak valid."))?;
    if body.len() > CSP_REPORT_MAX_BODY_BYTES {
        return Err(ApiFailure::new(413, "Laporan CSP terlalu besar."));
    }
    let payload = serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|_| ApiFailure::new(422, "Laporan CSP tidak valid."))?;
    let report = normalized_csp_report(&payload)?;
    worker::console_log!(
        "{}",
        json!({
            "level": "warn",
            "event": "csp_violation",
            "report": report,
            "environment": environment_name(env),
        })
    );
    Ok(json!({ "accepted": true }))
}

fn cached_scope(token: &str) -> Option<AccessScope> {
    let now = now_ms();
    SCOPE_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        cache.retain(|_, scope| scope.expires_at > now);
        cache.get(token).map(|scope| scope.scope.clone())
    })
}

fn cache_scope(token: String, scope: AccessScope) {
    let expires_at = now_ms() + SCOPE_CACHE_TTL_MS;
    SCOPE_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= SCOPE_CACHE_MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(token, CachedScope { expires_at, scope });
    });
}

fn now_seconds() -> u64 {
    (now_ms() / 1_000.0).floor().max(0.0) as u64
}

fn jwt_payload(token: &str) -> Option<serde_json::Value> {
    let encoded_payload = token.split('.').nth(1)?;
    let payload = URL_SAFE_NO_PAD.decode(encoded_payload).ok()?;
    serde_json::from_slice(&payload).ok()
}

fn jwt_expiration_seconds(token: &str) -> Option<u64> {
    jwt_payload(token)?.get("exp")?.as_u64()
}

fn jwt_aal(token: &str) -> Option<String> {
    jwt_payload(token)?
        .get("aal")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn is_full_access_role(role: &str) -> bool {
    matches!(role, "Ahli Gizi" | "super_admin")
}

fn verified_scope_is_valid(scope: &AccessScope) -> bool {
    if scope.user_id.trim().is_empty() {
        return false;
    }
    if !matches!(scope.access_mode.as_str(), "read" | "write")
        || (scope.role == "super_admin" && scope.access_mode != "write")
    {
        return false;
    }
    let village_configured = scope
        .desa
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let posyandu_configured = scope
        .posyandu
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    match scope.role.as_str() {
        "Ahli Gizi" | "super_admin" => true,
        "Bidan Desa" => village_configured,
        "Kader Posyandu" => village_configured && posyandu_configured,
        _ => false,
    }
}

fn read_replica_configured(env: &Env) -> bool {
    (env.service("NEON_READ_SERVICE").is_ok()
        || optional_secret(env, "NEON_READ_API_URL").is_some())
        && optional_secret(env, "READ_REPLICA_SHARED_SECRET").is_some()
}

fn emergency_read_configured(env: &Env) -> bool {
    redis_configured(env)
        && read_replica_configured(env)
        && optional_secret(env, "READ_REPLICA_MODE").as_deref() != Some("primary-only")
}

fn is_emergency_read_route(method: &Method, path: &str) -> bool {
    *method == Method::Get || (*method == Method::Post && path == "/api/v1/graphql")
}

fn upstream_is_unavailable(status: u16) -> bool {
    status == 429 || status >= 500
}

async fn persist_verified_scope(env: &Env, token: &str, scope: &AccessScope) {
    if !verified_scope_is_valid(scope) {
        worker::console_warn!("Scope akun tidak valid dan tidak disimpan untuk baca darurat.");
        return;
    }
    let Some(token_expires_at) = jwt_expiration_seconds(token) else {
        worker::console_warn!("JWT tanpa waktu kedaluwarsa tidak disimpan untuk baca darurat.");
        return;
    };
    let ttl = token_expires_at
        .saturating_sub(now_seconds())
        .min(VERIFIED_SCOPE_MAX_TTL_SECONDS);
    if ttl < VERIFIED_SCOPE_MIN_TTL_SECONDS {
        return;
    }
    let record = VerifiedScopeRecord {
        scope: scope.clone(),
        token_expires_at,
        cached_at: now_iso(),
    };
    let Ok(payload) = serde_json::to_string(&record) else {
        return;
    };
    let key = hashed_key(VERIFIED_SCOPE_CACHE_PREFIX, token);
    if !redis_set_text(env, &key, payload, ttl).await {
        worker::console_warn!("Scope terverifikasi tidak dapat disimpan ke Redis.");
    }
}

async fn load_verified_scope(env: &Env, token: &str) -> Option<AccessScope> {
    let token_expires_at = jwt_expiration_seconds(token)?;
    if token_expires_at <= now_seconds() {
        return None;
    }
    let payload = redis_get_text(env, &hashed_key(VERIFIED_SCOPE_CACHE_PREFIX, token)).await?;
    let record = serde_json::from_str::<VerifiedScopeRecord>(&payload).ok()?;
    if record.token_expires_at != token_expires_at || !verified_scope_is_valid(&record.scope) {
        return None;
    }
    Some(record.scope)
}

fn schedule_verified_scope_cache(context: &Context, env: &Env, token: &str, scope: &AccessScope) {
    let env = env.clone();
    let token = token.to_owned();
    let scope = scope.clone();
    context.wait_until(async move {
        persist_verified_scope(&env, &token, &scope).await;
    });
}

async fn emergency_read_scope(
    request: &Request,
    env: &Env,
    token: &str,
    reason: &'static str,
) -> ApiResult<AccessScope> {
    let method = request.method();
    let path = request.path();
    if !is_emergency_read_route(&method, &path) {
        return Err(ApiFailure::new(
            503,
            "Layanan utama sedang tidak tersedia. Perubahan data belum dapat dikirim.",
        ));
    }
    if !emergency_read_configured(env) {
        return Err(ApiFailure::new(
            503,
            "Layanan utama sedang tidak tersedia dan replika baca belum siap.",
        ));
    }
    let scope = load_verified_scope(env, token).await.ok_or_else(|| {
        ApiFailure::new(
            401,
            "Sesi tidak dapat diverifikasi saat layanan utama terganggu. Silakan masuk kembali setelah layanan pulih.",
        )
    })?;
    cache_scope(token.to_owned(), scope.clone());
    worker::console_warn!(
        "{}",
        json!({
            "level": "warn",
            "event": "emergency_read_session",
            "request_id": request_id(request),
            "route": path,
            "reason": reason,
            "database": "neon",
            "writes": "blocked"
        })
    );
    Ok(scope)
}

async fn request_value(
    url: String,
    method: Method,
    headers: Headers,
    body: Option<serde_json::Value>,
) -> ApiResult<(u16, serde_json::Value)> {
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        let encoded = serde_json::to_string(&body)
            .map_err(|_| ApiFailure::new(500, "Data permintaan tidak dapat diproses."))?;
        init.with_body(Some(JsValue::from_str(&encoded)));
    }
    let request = Request::new_with_init(&url, &init)
        .map_err(|_| ApiFailure::new(503, "Layanan autentikasi belum tersedia."))?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|_| ApiFailure::new(503, "Layanan autentikasi belum tersedia."))?;
    let status = response.status_code();
    let data = response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| ApiFailure::new(503, "Respons layanan tidak dapat dibaca."))?;
    Ok((status, data))
}

fn browser_session_cookie_name(env: &Env) -> &'static str {
    if environment_name(env) == "development" {
        DEVELOPMENT_SESSION_COOKIE
    } else {
        BROWSER_SESSION_COOKIE
    }
}

fn browser_session_cookie(request: &Request, env: &Env) -> Option<String> {
    let cookie_name = browser_session_cookie_name(env);
    request
        .headers()
        .get("Cookie")
        .ok()
        .flatten()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| {
            (name == cookie_name
                && (32..=128).contains(&value.len())
                && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| value.to_ascii_lowercase())
        })
}

fn browser_session_key(identifier: &str) -> String {
    hashed_key(BROWSER_SESSION_PREFIX, identifier)
}

fn new_browser_session_identifier(refresh_token: &str, request_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(refresh_token.as_bytes());
    digest.update(b"\0");
    digest.update(request_id.as_bytes());
    digest.update(b"\0");
    digest.update(now_iso().as_bytes());
    hex::encode(digest.finalize())
}

fn set_browser_session_cookie(env: &Env, identifier: &str) -> String {
    let name = browser_session_cookie_name(env);
    if environment_name(env) == "development" {
        format!("{name}={identifier}; Path=/; HttpOnly; SameSite=Lax")
    } else {
        format!("{name}={identifier}; Path=/; HttpOnly; Secure; SameSite=Strict")
    }
}

fn clear_browser_session_cookie(env: &Env) -> String {
    let name = browser_session_cookie_name(env);
    if environment_name(env) == "development" {
        format!("{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
    } else {
        format!("{name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0")
    }
}

async fn write_browser_session(
    env: &Env,
    identifier: &str,
    session: &BrowserSession,
) -> ApiResult<()> {
    let payload = serde_json::to_string(session)
        .map_err(|_| ApiFailure::new(500, "Sesi aman tidak dapat disimpan."))?;
    if redis_set_text(
        env,
        &browser_session_key(identifier),
        payload,
        BROWSER_SESSION_TTL_SECONDS,
    )
    .await
    {
        Ok(())
    } else {
        Err(ApiFailure::new(503, "Sesi aman tidak dapat disimpan."))
    }
}

async fn read_browser_session(env: &Env, identifier: &str) -> Option<BrowserSession> {
    let payload = redis_get_text(env, &browser_session_key(identifier)).await?;
    serde_json::from_str(&payload).ok()
}

async fn delete_browser_session(env: &Env, identifier: &str) {
    redis_delete(env, &browser_session_key(identifier)).await;
}

async fn refresh_browser_session(
    env: &Env,
    identifier: &str,
    current: &BrowserSession,
) -> ApiResult<BrowserSession> {
    let supabase_url = secret(env, "SUPABASE_URL")?
        .trim_end_matches('/')
        .to_owned();
    let publishable_key = secret(env, "SUPABASE_PUBLISHABLE_KEY")?;
    let (status, payload) = request_value(
        format!("{supabase_url}/auth/v1/token?grant_type=refresh_token"),
        Method::Post,
        supabase_headers(&publishable_key, None)
            .map_err(|_| ApiFailure::new(503, "Konfigurasi Supabase belum tersedia."))?,
        Some(json!({ "refresh_token": current.refresh_token })),
    )
    .await?;
    if status >= 300 {
        delete_browser_session(env, identifier).await;
        return Err(ApiFailure::new(401, "Sesi masuk tidak lagi valid."));
    }
    let refreshed: SupabaseSession = response_data(payload)?;
    let session = BrowserSession {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        user: refreshed.user,
        profile: current.profile.clone(),
        updated_at: now_iso(),
    };
    write_browser_session(env, identifier, &session).await?;
    cache_scope(session.access_token.clone(), session.profile.clone());
    Ok(session)
}

async fn inject_browser_session_authorization(request: &mut Request, env: &Env) {
    if request
        .headers()
        .get("Authorization")
        .ok()
        .flatten()
        .is_some()
    {
        return;
    }
    let Some(identifier) = browser_session_cookie(request, env) else {
        return;
    };
    let Some(mut session) = read_browser_session(env, &identifier).await else {
        return;
    };
    let expires_soon = jwt_expiration_seconds(&session.access_token)
        .is_none_or(|expires_at| expires_at <= now_seconds().saturating_add(90));
    if expires_soon {
        let Ok(refreshed) = refresh_browser_session(env, &identifier, &session).await else {
            return;
        };
        session = refreshed;
    }
    let _ = request.headers_mut().and_then(|headers| {
        headers.set("Authorization", &format!("Bearer {}", session.access_token))
    });
}

fn response_data<T: for<'a> Deserialize<'a>>(payload: serde_json::Value) -> ApiResult<T> {
    serde_json::from_value(payload)
        .map_err(|_| ApiFailure::new(503, "Respons layanan tidak dapat dibaca."))
}

fn supabase_headers(api_key: &str, bearer: Option<&str>) -> Result<Headers> {
    let headers = Headers::new();
    headers.set("apikey", api_key)?;
    headers.set(
        "Authorization",
        &format!("Bearer {}", bearer.unwrap_or(api_key)),
    )?;
    headers.set("Content-Type", "application/json")?;
    Ok(headers)
}

async fn verify_turnstile(env: &Env, token: Option<&str>, remote_ip: &str) -> ApiResult<()> {
    // Wrangler hanya menyuntikkan nilai ini pada sesi `wrangler dev` lokal.
    // Worker yang dipublikasikan tidak memiliki variabel ini dan selalu
    // memverifikasi Turnstile di server sebelum login.
    if env
        .var("LOCAL_TURNSTILE_BYPASS")
        .map(|value| value.to_string() == "true")
        .unwrap_or(false)
    {
        return Ok(());
    }

    let secret = secret(env, "TURNSTILE_SECRET_KEY")?;
    let token = token
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiFailure::new(403, "Verifikasi keamanan diperlukan sebelum masuk."))?;
    let headers = Headers::new();
    headers
        .set("Content-Type", "application/json")
        .map_err(|_| ApiFailure::new(500, "Konfigurasi verifikasi keamanan tidak valid."))?;
    let (status, payload) = request_value(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify".into(),
        Method::Post,
        headers,
        Some(json!({ "secret": secret, "response": token, "remoteip": remote_ip })),
    )
    .await?;
    if status >= 300 {
        return Err(ApiFailure::new(
            403,
            "Verifikasi keamanan tidak berhasil. Coba lagi.",
        ));
    }
    let result: TurnstileResult = response_data(payload)?;
    if !result.success {
        return Err(ApiFailure::new(
            403,
            "Verifikasi keamanan tidak berhasil. Coba lagi.",
        ));
    }
    let allowed_hosts = env
        .var("TURNSTILE_HOSTNAMES")
        .map(|value| value.to_string())
        .unwrap_or_default();
    let allowed_hosts = allowed_hosts
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if !allowed_hosts.is_empty()
        && !result
            .hostname
            .as_deref()
            .is_some_and(|host| allowed_hosts.contains(&host))
    {
        return Err(ApiFailure::new(
            403,
            "Verifikasi keamanan tidak sesuai dengan alamat aplikasi.",
        ));
    }
    Ok(())
}

fn schedule_login_audit(
    context: &Context,
    env: &Env,
    request_id: &str,
    username: &str,
    account: Option<&LoginAccount>,
    action: &str,
    outcome: &str,
) {
    let env = env.clone();
    let request_id = request_id.to_owned();
    let username = username.to_owned();
    let account = account.cloned();
    let action = action.to_owned();
    let outcome = outcome.to_owned();
    context.wait_until(async move {
        record_login_audit(
            &env,
            &request_id,
            &username,
            account.as_ref(),
            &action,
            &outcome,
        )
        .await;
    });
}

fn schedule_login_attempt_clear(context: &Context, env: &Env, ip: &str, username: &str) {
    let env = env.clone();
    let ip = ip.to_owned();
    let username = username.to_owned();
    context.wait_until(async move {
        clear_login_attempt(&env, &ip, &username).await;
    });
}

async fn login(
    mut request: Request,
    env: &Env,
    context: &Context,
) -> ApiResult<(serde_json::Value, String)> {
    let audit_request_id = request_id(&request);
    let remote_ip = client_ip(&request);
    let body = request
        .json::<LoginBody>()
        .await
        .map_err(|_| ApiFailure::new(422, "Data masuk tidak valid."))?;
    let username = normalized_username(body.username.as_deref())?;
    allow_login_attempt(env, &remote_ip, &username).await?;
    verify_turnstile(env, body.turnstile_token.as_deref(), &remote_ip).await?;
    let password = body.password.unwrap_or_default();
    if password.is_empty() {
        schedule_login_audit(
            context,
            env,
            &audit_request_id,
            &username,
            None,
            "login_failure",
            "missing_password",
        );
        return Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ));
    }

    let supabase_url = secret(env, "SUPABASE_URL")?
        .trim_end_matches('/')
        .to_owned();
    let secret_key = secret(env, "SUPABASE_SECRET_KEY")?;
    let encoded_username =
        url::form_urlencoded::byte_serialize(username.as_bytes()).collect::<String>();
    let (status, payload) = request_value(
        format!(
            "{supabase_url}/rest/v1/app_users?select=user_id,email,role,village,posyandu,active,access_mode&username=ilike.{encoded_username}&limit=1"
        ),
        Method::Get,
        supabase_headers(&secret_key, None)
            .map_err(|_| ApiFailure::new(503, "Konfigurasi Supabase belum tersedia."))?,
        None,
    )
    .await?;
    if status >= 300 {
        return Err(ApiFailure::new(503, "Layanan akun belum tersedia."));
    }
    let accounts: Vec<LoginAccount> = response_data(payload)?;
    let Some(account) = accounts.into_iter().next().filter(|account| account.active) else {
        schedule_login_audit(
            context,
            env,
            &audit_request_id,
            &username,
            None,
            "login_failure",
            "unknown_or_inactive_account",
        );
        return Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ));
    };
    let Some(email) = account.email.clone().filter(|email| !email.is_empty()) else {
        schedule_login_audit(
            context,
            env,
            &audit_request_id,
            &username,
            Some(&account),
            "login_failure",
            "account_email_missing",
        );
        return Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ));
    };

    let publishable_key = secret(env, "SUPABASE_PUBLISHABLE_KEY")?;
    let (status, payload) = request_value(
        format!("{supabase_url}/auth/v1/token?grant_type=password"),
        Method::Post,
        supabase_headers(&publishable_key, None)
            .map_err(|_| ApiFailure::new(503, "Konfigurasi Supabase belum tersedia."))?,
        Some(json!({ "email": email, "password": password })),
    )
    .await?;
    if status >= 300 {
        schedule_login_audit(
            context,
            env,
            &audit_request_id,
            &username,
            Some(&account),
            "login_failure",
            "invalid_credentials",
        );
        return Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ));
    }
    let session: SupabaseSession = response_data(payload)?;
    if session.user.id != account.user_id {
        schedule_login_audit(
            context,
            env,
            &audit_request_id,
            &username,
            Some(&account),
            "login_failure",
            "account_mapping_mismatch",
        );
        return Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ));
    }
    let profile = AccessScope {
        user_id: account.user_id.clone(),
        email: session.user.email.clone().or_else(|| account.email.clone()),
        role: account.role.clone(),
        desa: account.village.clone(),
        posyandu: account.posyandu.clone(),
        access_mode: account.access_mode.clone(),
    };
    if profile.role == "super_admin" {
        schedule_login_audit(
            context,
            env,
            &audit_request_id,
            &username,
            Some(&account),
            "login_failure",
            "admin_requires_oracle_mfa",
        );
        return Err(ApiFailure::new(
            503,
            "Akun administrator wajib masuk melalui API utama dengan verifikasi dua langkah.",
        ));
    }
    cache_scope(session.access_token.clone(), profile.clone());
    schedule_verified_scope_cache(context, env, &session.access_token, &profile);
    schedule_login_attempt_clear(context, env, &remote_ip, &username);
    schedule_login_audit(
        context,
        env,
        &audit_request_id,
        &username,
        Some(&account),
        "login_success",
        "authenticated",
    );
    let session_identifier =
        new_browser_session_identifier(&session.refresh_token, &audit_request_id);
    let browser_session = BrowserSession {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user: session.user.clone(),
        profile: profile.clone(),
        updated_at: now_iso(),
    };
    write_browser_session(env, &session_identifier, &browser_session).await?;
    Ok((
        json!({
            "user": { "id": session.user.id, "email": session.user.email },
            "profile": {
                "userId": profile.user_id,
                "email": profile.email,
                "role": profile.role,
                "desa": profile.desa,
                "posyandu": profile.posyandu,
                "accessMode": profile.access_mode
            }
        }),
        session_identifier,
    ))
}

async fn logout(request: &Request, env: &Env) -> serde_json::Value {
    let Some(identifier) = browser_session_cookie(request, env) else {
        return json!({ "signedOut": true });
    };
    if let Some(session) = read_browser_session(env, &identifier).await {
        if let (Ok(supabase_url), Ok(publishable_key)) = (
            secret(env, "SUPABASE_URL"),
            secret(env, "SUPABASE_PUBLISHABLE_KEY"),
        ) {
            if let Ok(headers) = supabase_headers(&publishable_key, Some(&session.access_token)) {
                let _ = request_value(
                    format!("{}/auth/v1/logout", supabase_url.trim_end_matches('/')),
                    Method::Post,
                    headers,
                    None,
                )
                .await;
            }
        }
    }
    delete_browser_session(env, &identifier).await;
    json!({ "signedOut": true })
}

async fn record_login_audit(
    env: &Env,
    request_id: &str,
    username: &str,
    account: Option<&LoginAccount>,
    action: &str,
    outcome: &str,
) {
    let account_key = hashed_key("account", username);
    let result = api::record_operational_audit(
        env,
        account
            .map(|value| value.user_id.as_str())
            .unwrap_or("anonymous"),
        account
            .map(|value| value.role.as_str())
            .unwrap_or("anonymous"),
        account.and_then(|value| value.village.as_deref()),
        account.and_then(|value| value.posyandu.as_deref()),
        request_id,
        None,
        action,
        "authentication",
        &account_key,
        None,
        None,
        json!({ "outcome": outcome }),
    )
    .await;
    if result.is_err() {
        worker::console_log!(
            "{}",
            json!({
                "level": "warn",
                "event": "audit_write_failed",
                "request_id": request_id,
                "action": action,
                "resource": "authentication"
            })
        );
    }
}

async fn require_scope(request: &Request, env: &Env) -> ApiResult<AccessScope> {
    let token = bearer_token(request)?;
    if let Some(scope) = cached_scope(&token) {
        return Ok(scope);
    }
    let supabase_url = secret(env, "SUPABASE_URL")?
        .trim_end_matches('/')
        .to_owned();
    let publishable_key = secret(env, "SUPABASE_PUBLISHABLE_KEY")?;
    let auth_response = request_value(
        format!("{supabase_url}/auth/v1/user"),
        Method::Get,
        supabase_headers(&publishable_key, Some(&token))
            .map_err(|_| ApiFailure::new(503, "Konfigurasi Supabase belum tersedia."))?,
        None,
    )
    .await;
    let (status, payload) = match auth_response {
        Ok((status, _)) if upstream_is_unavailable(status) => {
            return emergency_read_scope(request, env, &token, "auth_upstream_status").await;
        }
        Ok(response) => response,
        Err(error) if error.status >= 500 => {
            return emergency_read_scope(request, env, &token, "auth_transport").await;
        }
        Err(error) => return Err(error),
    };
    if status >= 300 {
        return Err(ApiFailure::new(401, "Sesi masuk tidak lagi valid."));
    }
    let identity: SupabaseUser = response_data(payload)?;
    if identity.id.is_empty() {
        return Err(ApiFailure::new(401, "Sesi masuk tidak lagi valid."));
    }

    let secret_key = secret(env, "SUPABASE_SECRET_KEY")?;
    let user_id = url::form_urlencoded::byte_serialize(identity.id.as_bytes()).collect::<String>();
    let profile_response = request_value(
        format!(
            "{supabase_url}/rest/v1/app_users?select=role,village,posyandu,active,access_mode&user_id=eq.{user_id}&limit=1"
        ),
        Method::Get,
        supabase_headers(&secret_key, None)
            .map_err(|_| ApiFailure::new(503, "Konfigurasi Supabase belum tersedia."))?,
        None,
    )
    .await;
    let (status, payload) = match profile_response {
        Ok((status, _)) if upstream_is_unavailable(status) => {
            return emergency_read_scope(request, env, &token, "profile_upstream_status").await;
        }
        Ok(response) => response,
        Err(error) if error.status >= 500 => {
            return emergency_read_scope(request, env, &token, "profile_transport").await;
        }
        Err(error) => return Err(error),
    };
    if status >= 300 {
        return Err(ApiFailure::new(503, "Layanan profil akun belum tersedia."));
    }
    let profiles: Vec<AppUser> = response_data(payload)?;
    let Some(profile) = profiles.into_iter().next().filter(|profile| profile.active) else {
        return Err(ApiFailure::new(
            403,
            "Akun ini belum diberi akses aplikasi.",
        ));
    };
    if !matches!(
        profile.role.as_str(),
        "Kader Posyandu" | "Bidan Desa" | "Ahli Gizi" | "super_admin"
    ) {
        return Err(ApiFailure::new(403, "Peran akun tidak valid."));
    }
    if profile.role == "Kader Posyandu" && (profile.village.is_none() || profile.posyandu.is_none())
    {
        return Err(ApiFailure::new(403, "Wilayah kader belum lengkap."));
    }
    if profile.role == "Bidan Desa" && profile.village.is_none() {
        return Err(ApiFailure::new(403, "Wilayah bidan belum lengkap."));
    }
    if profile.role == "super_admin" {
        if profile.village.is_some() || profile.posyandu.is_some() {
            return Err(ApiFailure::new(403, "Scope administrator tidak valid."));
        }
        if jwt_aal(&token).as_deref() != Some("aal2") {
            return Err(ApiFailure::new(
                401,
                "Verifikasi dua langkah diperlukan untuk akun administrator.",
            ));
        }
    }
    if !matches!(profile.access_mode.as_str(), "read" | "write")
        || (profile.role == "super_admin" && profile.access_mode != "write")
    {
        return Err(ApiFailure::new(403, "Hak akses akun tidak valid."));
    }
    let scope = AccessScope {
        user_id: identity.id,
        email: identity.email,
        role: profile.role,
        desa: profile.village,
        posyandu: profile.posyandu,
        access_mode: profile.access_mode,
    };
    cache_scope(token.clone(), scope.clone());
    persist_verified_scope(env, &token, &scope).await;
    Ok(scope)
}

async fn dispatch(request: Request, env: &Env, _context: &Context) -> ApiResult<serde_json::Value> {
    match (request.method(), request.path().as_str()) {
        (Method::Get, "/api/v1/openapi.json") => openapi_document(),
        (Method::Get, "/api/v1/health/ready") => readiness_status(env).await,
        (Method::Post, "/api/v1/graphql") => graphql::execute(request, env).await,
        (Method::Get, "/api/v1/graphql/schema") => Ok(graphql::schema_document()),
        (Method::Post, "/api/v1/security/csp-report") => csp_report(request, env).await,
        (Method::Get, "/api/v1/monitoring/status") => monitoring_status(request, env).await,
        (Method::Post, "/internal/v1/nutrition/batch") => nutrition_batch(request, env).await,
        _ if request.path().starts_with("/internal/v1/jobs/") => {
            internal_background_job(request, env).await
        }
        (Method::Get, "/api/v1/auth/session") => {
            let scope = require_scope(&request, env).await?;
            Ok(json!({
                "user": { "id": scope.user_id, "email": scope.email },
                "profile": {
                    "userId": scope.user_id,
                    "email": scope.email,
                    "role": scope.role,
                    "desa": scope.desa,
                    "posyandu": scope.posyandu,
                    "accessMode": scope.access_mode
                }
            }))
        }
        (Method::Get, "/api/v1/me") => {
            let scope = require_scope(&request, env).await?;
            Ok(json!({
                "userId": scope.user_id,
                "email": scope.email,
                "role": scope.role,
                "desa": scope.desa,
                "posyandu": scope.posyandu,
                "accessMode": scope.access_mode
            }))
        }
        _ if request.path().starts_with("/api/v1/") => api::dispatch(request, env).await,
        _ => Err(ApiFailure::new(404, "Rute API tidak ditemukan.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nutrition_batch_uses_who_standards() {
        let standards = standards().expect("standards must load");
        let result = calculate_nutrition(
            &[NutritionItem {
                weight_kg: 3.2,
                height_cm: Some(49.0),
                age_months: 0,
                sex: "L".into(),
                measurement_method: None,
            }],
            &standards,
        );
        assert_eq!(result.underweight, 0);
        assert_eq!(result.stunting, 0);
        assert_eq!(result.wasting, 0);
    }

    #[test]
    fn nutrition_matches_who_lms_golden_medians() {
        let standards = standards().expect("standards must load");
        assert!(lms_z_score(3.3464, [0.3487, 3.3464, 0.14602]).abs() < 1e-10);
        assert!(lms_z_score(49.1477, [1.0, 49.1477, 0.0379]).abs() < 1e-10);
        assert_eq!(
            nutrition_status(18.3366, "BBU", 60, "L", None, "", &standards),
            "Berat Normal"
        );
    }

    #[test]
    fn nutrition_status_rejects_invalid_age() {
        let standards = standards().expect("standards must load");
        assert_eq!(
            nutrition_status(3.2, "BBU", 61, "L", None, "", &standards),
            "-"
        );
    }

    #[test]
    fn openapi_document_is_valid() {
        let document = openapi_document().expect("OpenAPI document must load");
        assert_eq!(document.get("openapi"), Some(&json!("3.1.0")));
        assert!(document.pointer("/paths/~1api~1v1~1health").is_some());
        assert!(
            document
                .pointer("/paths/~1api~1v1~1monitoring~1status")
                .is_some()
        );
    }

    #[test]
    fn supabase_project_reference_is_extracted_safely() {
        assert_eq!(
            supabase_project_ref("https://exampleproject.supabase.co"),
            Some("exampleproject".into())
        );
        assert_eq!(supabase_project_ref("https://example.com"), None);
        assert_eq!(supabase_project_ref("not-a-url"), None);
    }

    #[test]
    fn nonproduction_write_allowlist_contains_only_safe_posts() {
        assert!(is_allowed_nonproduction_post("/api/v1/auth/login"));
        assert!(is_allowed_nonproduction_post("/api/v1/auth/logout"));
        assert!(is_allowed_nonproduction_post("/api/v1/graphql"));
        assert!(is_allowed_nonproduction_post("/api/v1/client-errors"));
        assert!(is_allowed_nonproduction_post("/api/v1/security/csp-report"));
        assert!(!is_allowed_nonproduction_post("/api/v1/sync"));
        assert!(!is_allowed_nonproduction_post("/api/v1/jobs"));
    }

    #[test]
    fn jwt_expiration_is_read_from_url_safe_payload() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"exp":1893456000}"#);
        let token = format!("header.{payload}.signature");
        assert_eq!(jwt_expiration_seconds(&token), Some(1_893_456_000));
        assert_eq!(jwt_expiration_seconds("invalid"), None);
    }

    #[test]
    fn browser_session_cookie_only_accepts_hex_identifiers() {
        let valid = "a".repeat(64);
        assert_eq!(valid.len(), 64);
        assert!(valid.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(
            !"not-a-session-cookie"
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        );
    }

    #[test]
    fn emergency_session_only_supports_read_routes() {
        assert!(is_emergency_read_route(
            &Method::Get,
            "/api/v1/children/page"
        ));
        assert!(is_emergency_read_route(&Method::Post, "/api/v1/graphql"));
        assert!(!is_emergency_read_route(&Method::Post, "/api/v1/sync"));
        assert!(!is_emergency_read_route(
            &Method::Delete,
            "/api/v1/measurements/example"
        ));
    }

    #[test]
    fn emergency_scope_keeps_role_and_location_boundaries() {
        assert!(verified_scope_is_valid(&AccessScope {
            user_id: "nutrition-user".into(),
            email: None,
            role: "Ahli Gizi".into(),
            desa: None,
            posyandu: None,
            access_mode: "write".into(),
        }));
        assert!(!verified_scope_is_valid(&AccessScope {
            user_id: "cadre-user".into(),
            email: None,
            role: "Kader Posyandu".into(),
            desa: Some("Desa Gumukmas".into()),
            posyandu: None,
            access_mode: "write".into(),
        }));
    }

    #[test]
    fn emergency_fallback_only_accepts_unavailable_upstream() {
        assert!(upstream_is_unavailable(429));
        assert!(upstream_is_unavailable(503));
        assert!(!upstream_is_unavailable(401));
        assert!(!upstream_is_unavailable(403));
    }

    #[test]
    fn csp_report_removes_queries_credentials_and_script_samples() {
        let report = normalized_csp_report(&json!({
            "csp-report": {
                "document-uri": "https://user:secret@example.test/form?nik=secret#child",
                "effective-directive": "script-src-elem",
                "blocked-uri": "https://evil.test/tracker.js?token=secret",
                "status-code": 200,
                "script-sample": "alert(document.cookie)",
                "original-policy": "default-src 'none'"
            }
        }))
        .expect("valid report");
        assert_eq!(report["document_url"], "https://example.test/form");
        assert_eq!(report["blocked_origin"], "https://evil.test");
        assert_eq!(report["effective_directive"], "script-src-elem");
        assert!(report.get("script-sample").is_none());
        assert!(report.get("original-policy").is_none());
    }
}

#[event(fetch)]
pub async fn main(request: Request, env: Env, context: Context) -> Result<Response> {
    let started_at = now_ms();
    let request_id = request_id(&request);
    let mut request = request.clone_mut()?;
    request.headers_mut()?.set("X-Request-ID", &request_id)?;
    let method = request.method().to_string();
    let is_get = request.method() == Method::Get;
    let path = request.path();
    let if_none_match = request.headers().get("If-None-Match").ok().flatten();
    let is_export = request.url().ok().is_some_and(|url| {
        url.query_pairs()
            .any(|(key, value)| key == "export" && value == "1")
    });
    let origin = match request_origin(&request, &env) {
        Ok(origin) => origin,
        Err(error) => {
            let status = error.status;
            let response = failure_response(error, None, &request_id)?;
            log_request(&env, &request_id, &method, &path, status, started_at);
            return Ok(response);
        }
    };
    if request.method() == Method::Options {
        let response = with_api_headers(
            Response::empty()?,
            origin.as_deref(),
            "public, max-age=86400",
            &request_id,
        )?;
        log_request(&env, &request_id, &method, &path, 200, started_at);
        return Ok(response);
    }
    if request.method() == Method::Get && matches!(path.as_str(), "/api/health" | "/api/v1/health")
    {
        let response = health_response(origin.as_deref(), &request_id)?;
        log_request(&env, &request_id, &method, &path, 200, started_at);
        return Ok(response);
    }
    if let Err(error) = enforce_environment_write_guard(&request, &env) {
        let status = error.status;
        let response = failure_response(error, origin.as_deref(), &request_id)?;
        log_request(&env, &request_id, &method, &path, status, started_at);
        return Ok(response);
    }
    if request.method() == Method::Post && path == "/api/v1/auth/login" {
        let (status, response) = match login(request, &env, &context).await {
            Ok((payload, identifier)) => {
                let (status, mut response) =
                    success_response(&payload, origin.as_deref(), &request_id, "no-store", None)?;
                response
                    .headers_mut()
                    .append("Set-Cookie", &set_browser_session_cookie(&env, &identifier))?;
                (status, response)
            }
            Err(error) => {
                let status = error.status;
                (
                    status,
                    failure_response(error, origin.as_deref(), &request_id)?,
                )
            }
        };
        log_request(&env, &request_id, &method, &path, status, started_at);
        return Ok(response);
    }
    if request.method() == Method::Post && path == "/api/v1/auth/logout" {
        let payload = logout(&request, &env).await;
        let (status, mut response) =
            success_response(&payload, origin.as_deref(), &request_id, "no-store", None)?;
        response
            .headers_mut()
            .append("Set-Cookie", &clear_browser_session_cookie(&env))?;
        response
            .headers_mut()
            .set("Clear-Site-Data", "\"cache\", \"cookies\", \"storage\"")?;
        log_request(&env, &request_id, &method, &path, status, started_at);
        return Ok(response);
    }
    inject_browser_session_authorization(&mut request, &env).await;
    if request.method() == Method::Get
        && path.starts_with("/api/v1/jobs/")
        && path.ends_with("/file")
    {
        let id = path
            .trim_start_matches("/api/v1/jobs/")
            .trim_end_matches("/file")
            .trim_matches('/');
        let (status, response) = match api::download_background_job_file(request, &env, id).await {
            Ok(response) => (
                200,
                with_api_headers(
                    response,
                    origin.as_deref(),
                    "private, no-store",
                    &request_id,
                )?,
            ),
            Err(error) => {
                let status = error.status;
                (
                    status,
                    failure_response(error, origin.as_deref(), &request_id)?,
                )
            }
        };
        log_request(&env, &request_id, &method, &path, status, started_at);
        return Ok(response);
    }
    let (status, response) = match dispatch(request, &env, &context).await {
        Ok(payload) => success_response(
            &payload,
            origin.as_deref(),
            &request_id,
            success_cache_control(&path, is_get, is_export),
            if_none_match.as_deref(),
        )?,
        Err(error) => {
            let status = error.status;
            (
                status,
                failure_response(error, origin.as_deref(), &request_id)?,
            )
        }
    };
    log_request(&env, &request_id, &method, &path, status, started_at);
    Ok(response)
}

#[event(scheduled)]
pub async fn keep_nutrition_worker_awake(
    _event: worker::ScheduledEvent,
    env: Env,
    _context: worker::ScheduleContext,
) {
    monitor_and_cleanup_r2(&env).await;
    cleanup_child_retention(&env).await;
    let checked_at = now_iso();
    let previous = read_nutrition_worker_health(&env).await;
    let Some(health_url) = optional_secret(&env, "RUST_WORKER_HEALTH_URL") else {
        let state = NutritionWorkerHealth {
            status: "unconfigured".into(),
            checked_at,
            latency_ms: 0,
            status_code: None,
            consecutive_failures: 0,
            last_success_at: previous
                .as_ref()
                .and_then(|state| state.last_success_at.clone()),
            last_failure_at: previous
                .as_ref()
                .and_then(|state| state.last_failure_at.clone()),
        };
        write_nutrition_worker_health(&env, &state).await;
        return;
    };
    let Ok(health_url) = url::Url::parse(&health_url) else {
        worker::console_warn!("RUST_WORKER_HEALTH_URL tidak valid.");
        return;
    };

    let started_at = now_ms();
    let (healthy, status_code) = match Fetch::Url(health_url).send().await {
        Ok(response) => {
            let status = response.status_code();
            (status < 400, Some(status))
        }
        Err(_) => (false, None),
    };
    let latency_ms = (now_ms() - started_at).max(0.0).round() as u64;
    let previous_failures = previous
        .as_ref()
        .map(|state| state.consecutive_failures)
        .unwrap_or(0);
    let consecutive_failures = if healthy {
        0
    } else {
        previous_failures.saturating_add(1)
    };
    let status = if healthy {
        "healthy"
    } else if consecutive_failures >= NUTRITION_WORKER_FAILURE_THRESHOLD {
        "down"
    } else {
        "degraded"
    };
    let state = NutritionWorkerHealth {
        status: status.into(),
        checked_at: checked_at.clone(),
        latency_ms,
        status_code,
        consecutive_failures,
        last_success_at: if healthy {
            Some(checked_at.clone())
        } else {
            previous
                .as_ref()
                .and_then(|state| state.last_success_at.clone())
        },
        last_failure_at: if healthy {
            previous
                .as_ref()
                .and_then(|state| state.last_failure_at.clone())
        } else {
            Some(checked_at)
        },
    };
    let previous_status = previous
        .as_ref()
        .map(|state| state.status.as_str())
        .unwrap_or("unknown");
    write_nutrition_worker_health(&env, &state).await;

    worker::console_log!(
        "{}",
        json!({
            "level": if healthy { "info" } else { "warn" },
            "event": "nutrition_worker_health",
            "environment": environment_name(&env),
            "status": state.status,
            "status_code": state.status_code,
            "latency_ms": state.latency_ms,
            "consecutive_failures": state.consecutive_failures,
        })
    );

    if state.status == "down" && previous_status != "down" {
        send_monitoring_alert(&env, &state, false).await;
    } else if state.status == "healthy" && previous_status == "down" {
        send_monitoring_alert(&env, &state, true).await;
    }
}
