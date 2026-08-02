use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{cell::RefCell, collections::HashMap};
use worker::{
    Context, Env, Fetch, Headers, Method, Request, RequestInit, Response, Result, event,
    wasm_bindgen::JsValue,
};

mod api;

const SCOPE_CACHE_TTL_MS: f64 = 90_000.0;
const LOGIN_IP_WINDOW_SECONDS: u64 = 600;
const LOGIN_ACCOUNT_WINDOW_SECONDS: u64 = 600;
const LOGIN_PAIR_WINDOW_SECONDS: u64 = 60;
const LOGIN_IP_MAX_ATTEMPTS: u8 = 30;
const LOGIN_ACCOUNT_MAX_ATTEMPTS: u8 = 10;
const LOGIN_PAIR_MAX_ATTEMPTS: u8 = 5;
const SCOPE_CACHE_MAX_ENTRIES: usize = 256;
const INTERNAL_REQUEST_MAX_AGE_SECONDS: f64 = 60.0;
const NUTRITION_BATCH_MAX_ITEMS: usize = 10_000;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Deserialize, Serialize)]
struct AccessScope {
    user_id: String,
    email: Option<String>,
    role: String,
    desa: Option<String>,
    posyandu: Option<String>,
}

struct CachedScope {
    expires_at: f64,
    scope: AccessScope,
}

struct LoginAttempt {
    count: u8,
    reset_at: f64,
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

#[derive(Deserialize)]
struct LoginAccount {
    user_id: String,
    email: Option<String>,
    role: String,
    village: Option<String>,
    posyandu: Option<String>,
    active: bool,
}

#[derive(Deserialize)]
struct SupabaseUser {
    id: String,
    email: Option<String>,
}

#[derive(Deserialize)]
struct SupabaseSession {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    user: SupabaseUser,
}

#[derive(Deserialize)]
struct AppUser {
    role: String,
    village: Option<String>,
    posyandu: Option<String>,
    active: bool,
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

fn configured_origins(env: &Env) -> Vec<String> {
    env.var("CORS_ORIGINS")
        .map(|value| value.to_string())
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn request_origin(request: &Request, env: &Env) -> ApiResult<Option<String>> {
    let origin = request
        .headers()
        .get("Origin")
        .map_err(|_| ApiFailure::new(400, "Origin permintaan tidak valid."))?;
    let Some(origin) = origin else {
        return Ok(None);
    };
    if configured_origins(env)
        .iter()
        .any(|allowed| allowed == &origin)
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
    headers.set("Content-Type", "application/json; charset=utf-8")?;
    headers.set("Cache-Control", cache_control)?;
    headers.set("Referrer-Policy", "no-referrer")?;
    headers.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
    )?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("X-Frame-Options", "DENY")?;
    headers.set("X-Request-ID", request_id)?;
    headers.set(
        "Permissions-Policy",
        "camera=(), geolocation=(), microphone=()",
    )?;
    headers.set("Vary", "Origin, Authorization, Accept-Encoding")?;
    if let Some(origin) = origin {
        headers.set("Access-Control-Allow-Origin", origin)?;
        headers.set(
            "Access-Control-Allow-Methods",
            "GET, POST, PATCH, DELETE, OPTIONS",
        )?;
        headers.set(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, Idempotency-Key, If-None-Match, X-Request-ID",
        )?;
        headers.set("Access-Control-Expose-Headers", "ETag, X-Request-ID")?;
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

async fn redis_commands(env: &Env, commands: serde_json::Value) -> Option<serde_json::Value> {
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

async fn login(mut request: Request, env: &Env) -> ApiResult<serde_json::Value> {
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
        record_login_audit(
            env,
            &audit_request_id,
            &username,
            None,
            "login_failure",
            "missing_password",
        )
        .await;
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
            "{supabase_url}/rest/v1/app_users?select=user_id,email,role,village,posyandu,active&username=ilike.{encoded_username}&limit=1"
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
        record_login_audit(
            env,
            &audit_request_id,
            &username,
            None,
            "login_failure",
            "unknown_or_inactive_account",
        )
        .await;
        return Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ));
    };
    let Some(email) = account.email.as_deref().filter(|email| !email.is_empty()) else {
        record_login_audit(
            env,
            &audit_request_id,
            &username,
            Some(&account),
            "login_failure",
            "account_email_missing",
        )
        .await;
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
        record_login_audit(
            env,
            &audit_request_id,
            &username,
            Some(&account),
            "login_failure",
            "invalid_credentials",
        )
        .await;
        return Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ));
    }
    let session: SupabaseSession = response_data(payload)?;
    if session.user.id != account.user_id {
        record_login_audit(
            env,
            &audit_request_id,
            &username,
            Some(&account),
            "login_failure",
            "account_mapping_mismatch",
        )
        .await;
        return Err(ApiFailure::new(
            401,
            "Username atau kata sandi tidak benar.",
        ));
    }
    clear_login_attempt(env, &remote_ip, &username).await;
    record_login_audit(
        env,
        &audit_request_id,
        &username,
        Some(&account),
        "login_success",
        "authenticated",
    )
    .await;
    Ok(json!({
        "access_token": session.access_token,
        "refresh_token": session.refresh_token,
        "expires_in": session.expires_in,
        "user": { "id": session.user.id, "email": session.user.email }
    }))
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
    let (status, payload) = request_value(
        format!("{supabase_url}/auth/v1/user"),
        Method::Get,
        supabase_headers(&publishable_key, Some(&token))
            .map_err(|_| ApiFailure::new(503, "Konfigurasi Supabase belum tersedia."))?,
        None,
    )
    .await?;
    if status >= 300 {
        return Err(ApiFailure::new(401, "Sesi masuk tidak lagi valid."));
    }
    let identity: SupabaseUser = response_data(payload)?;
    if identity.id.is_empty() {
        return Err(ApiFailure::new(401, "Sesi masuk tidak lagi valid."));
    }

    let secret_key = secret(env, "SUPABASE_SECRET_KEY")?;
    let user_id = url::form_urlencoded::byte_serialize(identity.id.as_bytes()).collect::<String>();
    let (status, payload) = request_value(
        format!(
            "{supabase_url}/rest/v1/app_users?select=role,village,posyandu,active&user_id=eq.{user_id}&limit=1"
        ),
        Method::Get,
        supabase_headers(&secret_key, None)
            .map_err(|_| ApiFailure::new(503, "Konfigurasi Supabase belum tersedia."))?,
        None,
    )
    .await?;
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
        "Kader Posyandu" | "Bidan Desa" | "Ahli Gizi"
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
    let scope = AccessScope {
        user_id: identity.id,
        email: identity.email,
        role: profile.role,
        desa: profile.village,
        posyandu: profile.posyandu,
    };
    cache_scope(token, scope.clone());
    Ok(scope)
}

async fn dispatch(request: Request, env: &Env) -> ApiResult<serde_json::Value> {
    match (request.method(), request.path().as_str()) {
        (Method::Get, "/api/v1/openapi.json") => openapi_document(),
        (Method::Post, "/internal/v1/nutrition/batch") => nutrition_batch(request, env).await,
        (Method::Post, "/api/v1/auth/login") => login(request, env).await,
        (Method::Get, "/api/v1/me") => {
            let scope = require_scope(&request, env).await?;
            Ok(json!({
                "userId": scope.user_id,
                "email": scope.email,
                "role": scope.role,
                "desa": scope.desa,
                "posyandu": scope.posyandu
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
    }
}

#[event(fetch)]
pub async fn main(request: Request, env: Env, _ctx: Context) -> Result<Response> {
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
    let (status, response) = match dispatch(request, &env).await {
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
