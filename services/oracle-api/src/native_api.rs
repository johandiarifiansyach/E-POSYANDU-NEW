use std::{collections::BTreeMap, env, sync::Arc};

use axum::{
    body::to_bytes,
    extract::Request,
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use rand::{Rng, thread_rng};
use reqwest::{Client, Url};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    native_auth::{AccessScope, NativeAuth},
    native_cache::{DASHBOARD_CACHE_TTL_SECONDS, DYNAMIC_CACHE_TTL_SECONDS, NativeCache},
    native_db::{DatabaseError, NativeDatabase},
    realtime::{RealtimeEvent, RealtimeHub},
};

const ORACLE_ORIGIN_HEADER: &str = "x-e-posyandu-origin";
const COLLECTION_MUTATION_MAX_BODY_BYTES: usize = 256 * 1024;
const SYNC_MUTATION_MAX_BODY_BYTES: usize = 1024 * 1024;
const BACKGROUND_JOB_MAX_BODY_BYTES: usize = 64 * 1024;
type CollectionParameters = (Vec<(String, String)>, bool, bool, usize);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Resource {
    Children,
    Measurements,
    MpasiLogs,
    PmtPrograms,
    ChangeLogs,
}

impl Resource {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "children" => Some(Self::Children),
            "measurements" => Some(Self::Measurements),
            "mpasi_logs" => Some(Self::MpasiLogs),
            "pmt_programs" => Some(Self::PmtPrograms),
            "change_logs" => Some(Self::ChangeLogs),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Children => "children",
            Self::Measurements => "measurements",
            Self::MpasiLogs => "mpasi_logs",
            Self::PmtPrograms => "pmt_programs",
            Self::ChangeLogs => "change_logs",
        }
    }

    fn select(self) -> &'static str {
        match self {
            Self::Children => "*",
            Self::Measurements => "*,children(name,village,posyandu)",
            Self::MpasiLogs | Self::PmtPrograms | Self::ChangeLogs => {
                "*,children!inner(name,village,posyandu)"
            }
        }
    }

    fn sync_column(self) -> &'static str {
        if self == Self::ChangeLogs {
            "changed_at"
        } else {
            "updated_at"
        }
    }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            message,
        )
    }

    fn into_response(self) -> Response {
        api_response(
            self.status,
            json!({ "error": { "code": self.code, "message": self.message } }),
            "no-store",
        )
    }
}

pub(crate) struct NativeApi {
    http: Client,
    database: Arc<NativeDatabase>,
    auth: Arc<NativeAuth>,
    cache: Option<NativeCache>,
    queue: Option<CloudflareQueueConfig>,
    realtime: RealtimeHub,
    reads_enabled: bool,
    writes_enabled: bool,
}

#[derive(Clone)]
struct CloudflareQueueConfig {
    account_id: String,
    queue_id: String,
    api_token: String,
}

#[derive(Clone)]
struct MutationContext {
    scope: AccessScope,
    request_id: String,
    idempotency_key: Option<String>,
}

fn native_database_error(error: DatabaseError) -> ApiError {
    match error {
        DatabaseError::Conflict => ApiError::new(
            StatusCode::CONFLICT,
            "database_error",
            "Data bertentangan dengan perubahan lain.",
        ),
        DatabaseError::Invalid => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "database_error",
            "Data tidak dapat diproses oleh PostgreSQL.",
        ),
        DatabaseError::Unavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "database_unavailable",
            "Database utama sementara tidak dapat dijangkau.",
        ),
    }
}

fn optional_queue_config() -> Result<Option<CloudflareQueueConfig>, String> {
    let values = [
        (
            "CLOUDFLARE_ACCOUNT_ID",
            env::var("CLOUDFLARE_ACCOUNT_ID").ok(),
        ),
        ("CLOUDFLARE_QUEUE_ID", env::var("CLOUDFLARE_QUEUE_ID").ok()),
        (
            "CLOUDFLARE_QUEUES_API_TOKEN",
            env::var("CLOUDFLARE_QUEUES_API_TOKEN").ok(),
        ),
    ]
    .map(|(name, value)| {
        (
            name,
            value
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
        )
    });
    let configured = values.iter().filter(|(_, value)| value.is_some()).count();
    if configured == 0 {
        return Ok(None);
    }
    if configured != values.len() {
        let missing = values
            .iter()
            .filter_map(|(name, value)| value.is_none().then_some(*name))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Konfigurasi Cloudflare Queue belum lengkap: {missing}"
        ));
    }
    let account_id = values[0].1.clone().unwrap_or_default();
    let queue_id = values[1].1.clone().unwrap_or_default();
    if !valid_cloudflare_id(&account_id) || !valid_cloudflare_id(&queue_id) {
        return Err("Account ID atau Queue ID Cloudflare tidak valid.".into());
    }
    Ok(Some(CloudflareQueueConfig {
        account_id,
        queue_id,
        api_token: values[2].1.clone().unwrap_or_default(),
    }))
}

fn valid_cloudflare_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn api_response(status: StatusCode, payload: Value, cache_control: &'static str) -> Response {
    let mut response = (
        status,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, cache_control),
        ],
        axum::Json(payload),
    )
        .into_response();
    response.headers_mut().insert(
        HeaderName::from_static(ORACLE_ORIGIN_HEADER),
        HeaderValue::from_static("oracle-native"),
    );
    response
}

fn query_values(request: &Request) -> BTreeMap<String, String> {
    request
        .uri()
        .query()
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn query_pairs(request: &Request) -> Vec<(String, String)> {
    request
        .uri()
        .query()
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn dynamic_cacheable_request(path: &str, query: &BTreeMap<String, String>) -> bool {
    query.get("export").is_none_or(|value| value != "1")
        && (matches!(
            path,
            "/api/v1/dashboard/stats"
                | "/api/v1/children/page"
                | "/api/v1/exclusive-breastfeeding/page"
        ) || path.starts_with("/api/v1/collections/"))
}

fn dynamic_cache_ttl_seconds(path: &str) -> u64 {
    if path == "/api/v1/dashboard/stats" {
        DASHBOARD_CACHE_TTL_SECONDS
    } else {
        DYNAMIC_CACHE_TTL_SECONDS
    }
}

fn dynamic_cache_table(table: &str) -> bool {
    matches!(
        table,
        "children"
            | "measurements"
            | "mpasi_logs"
            | "pmt_programs"
            | "pmt_monitorings"
            | "change_logs"
            | "change_log_entries"
            | "sync_tombstones"
    )
}

fn value<'a>(query: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    query
        .get(name)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn required_value<'a>(
    query: &'a BTreeMap<String, String>,
    name: &str,
    message: &'static str,
) -> Result<&'a str, ApiError> {
    value(query, name).ok_or_else(|| ApiError::validation(message))
}

fn is_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn date_value<'a>(
    query: &'a BTreeMap<String, String>,
    name: &str,
    message: &'static str,
) -> Result<&'a str, ApiError> {
    let date = required_value(query, name, message)?;
    if is_date(date) {
        Ok(date)
    } else {
        Err(ApiError::validation(message))
    }
}

fn positive_integer(
    query: &BTreeMap<String, String>,
    name: &str,
    fallback: usize,
    maximum: usize,
) -> Result<usize, ApiError> {
    let Some(raw) = value(query, name) else {
        return Ok(fallback);
    };
    let parsed = raw
        .parse::<usize>()
        .map_err(|_| ApiError::validation("Parameter halaman tidak valid."))?;
    if parsed == 0 || parsed > maximum {
        return Err(ApiError::validation("Parameter halaman tidak valid."));
    }
    Ok(parsed)
}

fn is_full_access_role(role: &str) -> bool {
    matches!(role, "Ahli Gizi" | "super_admin")
}

// RPC lama mengenali cakupan penuh melalui Ahli Gizi. Audit dan otorisasi
// tetap mempertahankan role super_admin yang sebenarnya.
fn database_scope_role(role: &str) -> &str {
    if is_full_access_role(role) {
        "Ahli Gizi"
    } else {
        role
    }
}

fn scoped_value(scope: &AccessScope, selected: Option<&str>, village: bool) -> Option<String> {
    if is_full_access_role(&scope.role) {
        return selected.map(ToOwned::to_owned);
    }
    if village {
        scope.desa.clone()
    } else if scope.role == "Kader Posyandu" {
        scope.posyandu.clone()
    } else {
        selected.map(ToOwned::to_owned)
    }
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn nullable(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

fn bool_value(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().unwrap_or_default() != 0.0,
        Some(Value::String(value)) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "ya" | "yes"
        ),
        Some(Value::Array(value)) => !value.is_empty(),
        _ => false,
    }
}

fn number_or_null(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Number(value)) => Value::Number(value.clone()),
        Some(Value::String(value)) => value
            .trim()
            .replace(',', ".")
            .parse::<f64>()
            .ok()
            .map_or(Value::Null, |number| json!(number)),
        _ => Value::Null,
    }
}

fn date_or_null(value: Option<&Value>) -> Value {
    let value = text(value);
    if value.len() >= 10 && is_date(&value[..10]) {
        Value::String(value[..10].into())
    } else {
        Value::Null
    }
}

fn timestamp_or_null(value: Option<&Value>) -> Value {
    let value = text(value);
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value)
    }
}

fn yes_no(value: Option<&Value>) -> Value {
    Value::String(if bool_value(value) { "Ya" } else { "Tidak" }.into())
}

fn yes_array(value: Option<&Value>) -> Value {
    if bool_value(value) {
        json!(["Ya"])
    } else {
        json!([])
    }
}

fn row(value: &Value) -> Result<&serde_json::Map<String, Value>, ApiError> {
    value.as_object().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_database_response",
            "Respons database tidak dapat dibaca.",
        )
    })
}

fn child_value<'a>(row: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a Value> {
    row.get("children")
        .and_then(Value::as_object)
        .and_then(|child| child.get(key))
}

fn preferred_child(row: &serde_json::Map<String, Value>, primary: &str, fallback: &str) -> String {
    let direct = text(row.get(primary));
    if direct.is_empty() {
        text(child_value(row, fallback))
    } else {
        direct
    }
}

fn api_document(
    resource: Resource,
    value: &Value,
    extras: Option<Value>,
) -> Result<Value, ApiError> {
    let row = row(value)?;
    let data = match resource {
        Resource::Children => json!({
            "nama": text(row.get("name")),
            "nik": text(row.get("national_id")),
            "anakKe": number_or_null(row.get("child_order")),
            "tglLahir": date_or_null(row.get("birth_date")),
            "jk": text(row.get("sex")),
            "noKK": text(row.get("family_card_number")),
            "hasKK": bool_value(row.get("has_family_card")),
            "hasNIK": bool_value(row.get("has_national_id")),
            "usiaKehamilan": number_or_null(row.get("gestational_age_weeks")),
            "bbLahir": number_or_null(row.get("birth_weight_kg")),
            "pbLahir": number_or_null(row.get("birth_length_cm")),
            "lkLahir": number_or_null(row.get("birth_head_circumference_cm")),
            "bukuKIA": yes_no(row.get("has_maternal_child_book")),
            "bukuKIAKecil": yes_no(row.get("has_small_baby_book")),
            "imd": yes_no(row.get("early_breastfeeding_initiation")),
            "namaOrtu": text(row.get("parent_name")),
            "nikOrtu": text(row.get("parent_national_id")),
            "noHpOrtu": text(row.get("parent_phone")),
            "alamat": text(row.get("address")),
            "rt": text(row.get("rt")),
            "rw": text(row.get("rw")),
            "desa": text(row.get("village")),
            "posyandu": text(row.get("posyandu")),
            "currentBB": number_or_null(row.get("current_weight_kg")),
            "currentTB": number_or_null(row.get("current_height_cm")),
            "currentLILA": number_or_null(row.get("current_mid_upper_arm_circumference_cm")),
            "currentLK": number_or_null(row.get("current_head_circumference_cm")),
            "lastMeasurementDate": date_or_null(row.get("last_measurement_date")),
            "createdAt": timestamp_or_null(row.get("created_at")),
            "createdBy": nullable(row.get("created_by")),
            "updatedAt": timestamp_or_null(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1)),
            "deletedAt": timestamp_or_null(row.get("deleted_at")),
            "deleteReason": nullable(row.get("delete_reason")),
            "deathDate": date_or_null(row.get("death_date")),
            "deathCause": nullable(row.get("death_cause")),
            "deathLocation": nullable(row.get("death_location"))
        }),
        Resource::Measurements => json!({
            "childId": text(row.get("legacy_child_id")),
            "childName": preferred_child(row, "legacy_child_name", "name"),
            "desa": preferred_child(row, "legacy_village", "village"),
            "posyandu": preferred_child(row, "legacy_posyandu", "posyandu"),
            "tglUkur": date_or_null(row.get("measurement_date")),
            "bb": number_or_null(row.get("weight_kg")),
            "tb": number_or_null(row.get("height_cm")),
            "lk": number_or_null(row.get("head_circumference_cm")),
            "lila": number_or_null(row.get("mid_upper_arm_circumference_cm")),
            "edema": text(row.get("edema")),
            "kelasIbu": text(row.get("mother_class_attendance")),
            "mbg": text(row.get("mbg")),
            "vitA": text(row.get("vitamin_a")),
            "asi": text(row.get("exclusive_breastfeeding")),
            "caraUkur": text(row.get("measurement_method")),
            "statusNaik": text(row.get("weight_gain_status")),
            "ageInMonths": number_or_null(row.get("age_in_months")),
            "createdAt": timestamp_or_null(row.get("created_at")),
            "updatedAt": timestamp_or_null(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1))
        }),
        Resource::MpasiLogs => json!({
            "childId": text(row.get("legacy_child_id")),
            "childName": preferred_child(row, "legacy_child_name", "name"),
            "tglMonitoring": date_or_null(row.get("monitoring_date")),
            "asi": text(row.get("breastfeeding")),
            "makananPokok": yes_array(row.get("staple_food")),
            "kacang": yes_array(row.get("legumes")),
            "susu": yes_array(row.get("dairy")),
            "daging": yes_array(row.get("meat")),
            "telur": yes_array(row.get("eggs")),
            "sayurVitA": yes_array(row.get("vitamin_a_fruit_vegetable")),
            "sayurLain": yes_array(row.get("other_fruit_vegetable")),
            "intervensiGizi": text(row.get("nutrition_intervention")),
            "createdAt": timestamp_or_null(row.get("created_at")),
            "updatedAt": timestamp_or_null(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1))
        }),
        Resource::PmtPrograms => json!({
            "childId": text(row.get("legacy_child_id")),
            "childName": preferred_child(row, "legacy_child_name", "name"),
            "category": text(row.get("category")),
            "jenisPmt": text(row.get("pmt_type")),
            "sumberAnggaran": text(row.get("funding_source")),
            "mitra": text(row.get("partner")),
            "mitraLain": text(row.get("other_partner")),
            "siklusKe": number_or_null(row.get("cycle_number")),
            "pmtSesuaiJuknis": text(row.get("follows_guidelines")),
            "tglPemberian": date_or_null(row.get("distribution_date")),
            "initialMeasurementDate": date_or_null(row.get("initial_measurement_date")),
            "initialBB": number_or_null(row.get("initial_weight_kg")),
            "initialTB": number_or_null(row.get("initial_height_cm")),
            "status": text(row.get("status")),
            "monitorings": extras.unwrap_or_else(|| json!({})),
            "createdAt": timestamp_or_null(row.get("created_at")),
            "updatedAt": timestamp_or_null(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1))
        }),
        Resource::ChangeLogs => json!({
            "childId": if text(row.get("legacy_child_id")).is_empty() { text(row.get("child_id")) } else { text(row.get("legacy_child_id")) },
            "childName": preferred_child(row, "child_name", "name"),
            "changes": extras.unwrap_or_else(|| json!([])),
            "changedBy": text(row.get("changed_by")),
            "timestamp": timestamp_or_null(row.get("changed_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1))
        }),
    };
    Ok(json!({ "id": text(row.get("id")), "data": data }))
}

fn filter_column(resource: Resource, field: &str) -> Option<&'static str> {
    match resource {
        Resource::Children => match field {
            "desa" => Some("village"),
            "posyandu" => Some("posyandu"),
            "tglLahir" => Some("birth_date"),
            "createdAt" => Some("created_at"),
            "deletedAt" => Some("deleted_at"),
            "nama" => Some("name"),
            _ => None,
        },
        Resource::Measurements => match field {
            "childId" => Some("legacy_child_id"),
            "tglUkur" => Some("measurement_date"),
            "desa" => Some("legacy_village"),
            "posyandu" => Some("legacy_posyandu"),
            "createdAt" => Some("created_at"),
            _ => None,
        },
        Resource::MpasiLogs => match field {
            "childId" => Some("legacy_child_id"),
            "tglMonitoring" => Some("monitoring_date"),
            "createdAt" => Some("created_at"),
            "desa" => Some("children.village"),
            "posyandu" => Some("children.posyandu"),
            _ => None,
        },
        Resource::PmtPrograms => match field {
            "childId" => Some("legacy_child_id"),
            "status" => Some("status"),
            "createdAt" => Some("created_at"),
            "desa" => Some("children.village"),
            "posyandu" => Some("children.posyandu"),
            _ => None,
        },
        Resource::ChangeLogs => match field {
            "childId" => Some("child_id"),
            "timestamp" => Some("changed_at"),
            "desa" => Some("children.village"),
            "posyandu" => Some("children.posyandu"),
            _ => None,
        },
    }
}

fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_owned(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn input_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(value)) => value.as_f64(),
        Some(Value::String(value)) => value.trim().replace(',', ".").parse().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

fn normalized_weight(value: Option<&Value>) -> Option<f64> {
    input_number(value).map(|value| {
        if value.abs() >= 1000.0 {
            value / 1000.0
        } else {
            value
        }
    })
}

fn timestamp_value(value: Option<&Value>) -> Value {
    let value = string_value(value);
    if value.contains('T') {
        Value::String(value)
    } else {
        Value::Null
    }
}

fn input_date_value(value: Option<&Value>) -> Value {
    let value = string_value(value);
    if is_date(&value) {
        Value::String(value)
    } else {
        Value::Null
    }
}

fn is_forbidden_text_character(character: char) -> bool {
    (character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
        || matches!(
            character,
            '\u{202a}'
                | '\u{202b}'
                | '\u{202c}'
                | '\u{202d}'
                | '\u{202e}'
                | '\u{2066}'
                | '\u{2067}'
                | '\u{2068}'
                | '\u{2069}'
        )
}

fn sanitize_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !is_forbidden_text_character(*character))
        .collect()
}

fn valid_document_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | '?' | '#'))
}

fn valid_idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

fn mutation_metadata(headers: &HeaderMap) -> Result<(String, Option<String>), ApiError> {
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if idempotency_key
        .as_deref()
        .is_some_and(|value| !valid_idempotency_key(value))
    {
        return Err(ApiError::validation("Kunci idempotensi tidak valid."));
    }
    let request_id = headers
        .get("x-request-id")
        .or_else(|| headers.get("cf-ray"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(ToOwned::to_owned)
        .or_else(|| idempotency_key.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    Ok((request_id, idempotency_key))
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn optional_location(value: Option<&Value>) -> Option<String> {
    let value = string_value(value);
    (!value.is_empty()).then_some(value)
}

fn raw_location(resource: Resource, raw: &Value) -> (Option<String>, Option<String>) {
    let Ok(row) = row(raw) else {
        return (None, None);
    };
    match resource {
        Resource::Children => (
            optional_location(row.get("village")),
            optional_location(row.get("posyandu")),
        ),
        Resource::Measurements => (
            optional_location(row.get("legacy_village").or_else(|| row.get("village"))),
            optional_location(row.get("legacy_posyandu").or_else(|| row.get("posyandu"))),
        ),
        Resource::MpasiLogs | Resource::PmtPrograms | Resource::ChangeLogs => (
            optional_location(child_value(row, "village")),
            optional_location(child_value(row, "posyandu")),
        ),
    }
}

fn set_value(target: &mut Map<String, Value>, column: &str, value: Option<Value>) {
    if let Some(value) = value {
        target.insert(column.into(), value);
    }
}

fn mapped_text(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key)
        .map(|value| Value::String(sanitize_text(&string_value(Some(value)))))
}

fn mapped_nullable_text(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).map(|value| {
        let value = sanitize_text(&string_value(Some(value)));
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    })
}

fn mapped_bool(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key)
        .map(|value| Value::Bool(bool_value(Some(value))))
}

fn mapped_number(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key)
        .map(|value| input_number(Some(value)).map_or(Value::Null, |value| json!(value)))
}

fn mapped_weight(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key)
        .map(|value| normalized_weight(Some(value)).map_or(Value::Null, |value| json!(value)))
}

fn mapped_integer(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).map(|value| {
        input_number(Some(value))
            .filter(|value| value.fract() == 0.0 && *value >= 0.0 && *value <= i16::MAX as f64)
            .map_or(Value::Null, |value| json!(value as i64))
    })
}

fn mapped_date(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).map(|value| input_date_value(Some(value)))
}

fn map_payload(resource: Resource, data: &Map<String, Value>) -> Map<String, Value> {
    let mut output = Map::new();
    match resource {
        Resource::Children => {
            for (key, column) in [
                ("nama", "name"),
                ("nik", "national_id"),
                ("jk", "sex"),
                ("noKK", "family_card_number"),
                ("namaOrtu", "parent_name"),
                ("nikOrtu", "parent_national_id"),
                ("noHpOrtu", "parent_phone"),
                ("alamat", "address"),
                ("rt", "rt"),
                ("rw", "rw"),
                ("desa", "village"),
                ("posyandu", "posyandu"),
                ("createdBy", "created_by"),
                ("deleteReason", "delete_reason"),
                ("deathCause", "death_cause"),
                ("deathLocation", "death_location"),
            ] {
                set_value(&mut output, column, mapped_text(data, key));
            }
            for (key, column) in [
                ("hasKK", "has_family_card"),
                ("hasNIK", "has_national_id"),
                ("bukuKIA", "has_maternal_child_book"),
                ("bukuKIAKecil", "has_small_baby_book"),
                ("imd", "early_breastfeeding_initiation"),
            ] {
                set_value(&mut output, column, mapped_bool(data, key));
            }
            for (key, column) in [
                ("anakKe", "child_order"),
                ("usiaKehamilan", "gestational_age_weeks"),
            ] {
                set_value(&mut output, column, mapped_integer(data, key));
            }
            for (key, column) in [
                ("pbLahir", "birth_length_cm"),
                ("lkLahir", "birth_head_circumference_cm"),
                ("currentTB", "current_height_cm"),
                ("currentLILA", "current_mid_upper_arm_circumference_cm"),
                ("currentLK", "current_head_circumference_cm"),
            ] {
                set_value(&mut output, column, mapped_number(data, key));
            }
            for (key, column) in [
                ("bbLahir", "birth_weight_kg"),
                ("currentBB", "current_weight_kg"),
            ] {
                set_value(&mut output, column, mapped_weight(data, key));
            }
            for (key, column) in [
                ("lastMeasurementDate", "last_measurement_date"),
                ("deathDate", "death_date"),
            ] {
                set_value(&mut output, column, mapped_date(data, key));
            }
            if let Some(value) = data.get("tglLahir") {
                output.insert(
                    "birth_date_raw".into(),
                    Value::String(sanitize_text(&string_value(Some(value)))),
                );
                output.insert("birth_date".into(), input_date_value(Some(value)));
            }
            set_value(
                &mut output,
                "deleted_at",
                data.get("deletedAt")
                    .map(|value| timestamp_value(Some(value))),
            );
            set_value(
                &mut output,
                "created_at",
                data.get("createdAt")
                    .map(|value| timestamp_value(Some(value))),
            );
        }
        Resource::Measurements => {
            for (key, column) in [
                ("childId", "legacy_child_id"),
                ("childName", "legacy_child_name"),
                ("desa", "legacy_village"),
                ("posyandu", "legacy_posyandu"),
                ("edema", "edema"),
                ("kelasIbu", "mother_class_attendance"),
                ("mbg", "mbg"),
                ("vitA", "vitamin_a"),
                ("asi", "exclusive_breastfeeding"),
                ("caraUkur", "measurement_method"),
                ("statusNaik", "weight_gain_status"),
            ] {
                set_value(&mut output, column, mapped_text(data, key));
            }
            set_value(&mut output, "weight_kg", mapped_weight(data, "bb"));
            for (key, column) in [
                ("tb", "height_cm"),
                ("lk", "head_circumference_cm"),
                ("lila", "mid_upper_arm_circumference_cm"),
            ] {
                set_value(&mut output, column, mapped_number(data, key));
            }
            set_value(
                &mut output,
                "age_in_months",
                mapped_integer(data, "ageInMonths"),
            );
            if let Some(value) = data.get("tglUkur") {
                output.insert(
                    "measurement_date_raw".into(),
                    Value::String(sanitize_text(&string_value(Some(value)))),
                );
                output.insert("measurement_date".into(), input_date_value(Some(value)));
            }
            set_value(
                &mut output,
                "created_at",
                data.get("createdAt")
                    .map(|value| timestamp_value(Some(value))),
            );
        }
        Resource::MpasiLogs => {
            for (key, column) in [
                ("childId", "legacy_child_id"),
                ("childName", "legacy_child_name"),
                ("asi", "breastfeeding"),
                ("intervensiGizi", "nutrition_intervention"),
            ] {
                set_value(&mut output, column, mapped_text(data, key));
            }
            for (key, column) in [
                ("makananPokok", "staple_food"),
                ("kacang", "legumes"),
                ("susu", "dairy"),
                ("daging", "meat"),
                ("telur", "eggs"),
                ("sayurVitA", "vitamin_a_fruit_vegetable"),
                ("sayurLain", "other_fruit_vegetable"),
            ] {
                set_value(&mut output, column, mapped_bool(data, key));
            }
            set_value(
                &mut output,
                "monitoring_date",
                mapped_date(data, "tglMonitoring"),
            );
            set_value(
                &mut output,
                "created_at",
                data.get("createdAt")
                    .map(|value| timestamp_value(Some(value))),
            );
        }
        Resource::PmtPrograms => {
            for (key, column) in [
                ("childId", "legacy_child_id"),
                ("childName", "legacy_child_name"),
                ("category", "category"),
                ("jenisPmt", "pmt_type"),
                ("sumberAnggaran", "funding_source"),
                ("pmtSesuaiJuknis", "follows_guidelines"),
                ("status", "status"),
            ] {
                set_value(&mut output, column, mapped_text(data, key));
            }
            for (key, column) in [("mitra", "partner"), ("mitraLain", "other_partner")] {
                set_value(&mut output, column, mapped_nullable_text(data, key));
            }
            set_value(
                &mut output,
                "cycle_number",
                mapped_integer(data, "siklusKe"),
            );
            set_value(
                &mut output,
                "distribution_date",
                mapped_date(data, "tglPemberian"),
            );
            set_value(
                &mut output,
                "initial_measurement_date",
                mapped_date(data, "initialMeasurementDate"),
            );
            set_value(
                &mut output,
                "initial_weight_kg",
                mapped_weight(data, "initialBB"),
            );
            set_value(
                &mut output,
                "initial_height_cm",
                mapped_number(data, "initialTB"),
            );
            set_value(
                &mut output,
                "created_at",
                data.get("createdAt")
                    .map(|value| timestamp_value(Some(value))),
            );
        }
        Resource::ChangeLogs => {
            for (key, column) in [
                ("childId", "legacy_child_id"),
                ("childName", "child_name"),
                ("changedBy", "changed_by"),
            ] {
                set_value(&mut output, column, mapped_text(data, key));
            }
            set_value(
                &mut output,
                "changed_at",
                data.get("timestamp")
                    .map(|value| timestamp_value(Some(value))),
            );
        }
    }
    output
}

fn validate_required(data: &Map<String, Value>, keys: &[&str]) -> Result<(), ApiError> {
    for key in keys {
        if string_value(data.get(*key)).is_empty() {
            return Err(ApiError::validation(format!("Kolom {key} wajib diisi.")));
        }
    }
    Ok(())
}

fn validate_weight(data: &Map<String, Value>, key: &str, maximum: f64) -> Result<(), ApiError> {
    let Some(value) = data.get(key) else {
        return Ok(());
    };
    if value.is_null() || string_value(Some(value)).is_empty() {
        return Ok(());
    }
    let valid =
        normalized_weight(Some(value)).is_some_and(|value| (0.1..=maximum).contains(&value));
    if valid {
        Ok(())
    } else {
        Err(ApiError::validation(format!(
            "{key} harus antara 0,1 sampai {maximum} kg."
        )))
    }
}

fn validate_integer(
    data: &Map<String, Value>,
    key: &str,
    minimum: i16,
    maximum: i16,
) -> Result<(), ApiError> {
    let Some(value) = data.get(key) else {
        return Ok(());
    };
    if value.is_null() || string_value(Some(value)).is_empty() {
        return Ok(());
    }
    let valid = input_number(Some(value)).is_some_and(|value| {
        value.fract() == 0.0 && value >= minimum as f64 && value <= maximum as f64
    });
    if valid {
        Ok(())
    } else {
        Err(ApiError::validation(format!(
            "{key} harus berupa angka bulat antara {minimum} sampai {maximum}."
        )))
    }
}

fn validate_common_data(resource: Resource, data: &Map<String, Value>) -> Result<(), ApiError> {
    let allowed: &[&str] = match resource {
        Resource::Children => &[
            "nama",
            "nik",
            "anakKe",
            "tglLahir",
            "jk",
            "noKK",
            "hasKK",
            "hasNIK",
            "usiaKehamilan",
            "bbLahir",
            "pbLahir",
            "lkLahir",
            "bukuKIA",
            "bukuKIAKecil",
            "imd",
            "namaOrtu",
            "nikOrtu",
            "noHpOrtu",
            "alamat",
            "rt",
            "rw",
            "desa",
            "posyandu",
            "currentBB",
            "currentTB",
            "currentLILA",
            "currentLK",
            "lastMeasurementDate",
            "createdAt",
            "createdBy",
            "updatedAt",
            "version",
            "deletedAt",
            "deleteReason",
            "deathDate",
            "deathCause",
            "deathLocation",
        ],
        Resource::Measurements => &[
            "childId",
            "childName",
            "desa",
            "posyandu",
            "tglUkur",
            "bb",
            "tb",
            "lk",
            "lila",
            "edema",
            "kelasIbu",
            "mbg",
            "vitA",
            "asi",
            "caraUkur",
            "statusNaik",
            "ageInMonths",
            "createdAt",
            "updatedAt",
            "version",
        ],
        Resource::MpasiLogs => &[
            "childId",
            "childName",
            "tglMonitoring",
            "asi",
            "makananPokok",
            "kacang",
            "susu",
            "daging",
            "telur",
            "sayurVitA",
            "sayurLain",
            "intervensiGizi",
            "createdAt",
            "updatedAt",
            "version",
        ],
        Resource::PmtPrograms => &[
            "childId",
            "childName",
            "category",
            "jenisPmt",
            "sumberAnggaran",
            "mitra",
            "mitraLain",
            "siklusKe",
            "pmtSesuaiJuknis",
            "tglPemberian",
            "initialMeasurementDate",
            "initialBB",
            "initialTB",
            "status",
            "monitorings",
            "createdAt",
            "updatedAt",
            "version",
        ],
        Resource::ChangeLogs => &[
            "childId",
            "childName",
            "changes",
            "changedBy",
            "timestamp",
            "version",
        ],
    };
    if let Some(field) = data.keys().find(|field| !allowed.contains(&field.as_str())) {
        return Err(ApiError::validation(format!(
            "Kolom {field} tidak diizinkan."
        )));
    }
    for (key, value) in data {
        if matches!(value, Value::String(value) if value.chars().any(is_forbidden_text_character)) {
            return Err(ApiError::validation(format!(
                "Kolom {key} mengandung karakter terlarang."
            )));
        }
        if matches!(value, Value::String(value) if value.chars().count() > 500) {
            return Err(ApiError::validation(format!(
                "Kolom {key} terlalu panjang."
            )));
        }
    }
    Ok(())
}

fn assert_location(scope: &AccessScope, village: &str, posyandu: &str) -> Result<(), ApiError> {
    if is_full_access_role(&scope.role) {
        return Ok(());
    }
    if scope.desa.as_deref() != Some(village) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Data berada di luar wilayah akun.",
        ));
    }
    if scope.role == "Kader Posyandu" && scope.posyandu.as_deref() != Some(posyandu) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Data berada di luar Posyandu akun.",
        ));
    }
    Ok(())
}

fn is_sixteen_digits(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn deterministic_digits(seed: &str, length: usize) -> String {
    let hash = hex::encode(Sha256::digest(seed.as_bytes()));
    hash.chars()
        .filter_map(|character| character.to_digit(16))
        .map(|value| char::from(b'0' + (value % 10) as u8))
        .take(length)
        .collect()
}

fn temporary_birth_segment(data: &Map<String, Value>, seed: &str) -> String {
    let birth_date = string_value(data.get("tglLahir"));
    let parts = birth_date.split('-').collect::<Vec<_>>();
    if parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts
            .iter()
            .all(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        format!("{}{}{}", parts[2], parts[1], &parts[0][2..])
    } else {
        deterministic_digits(&format!("birth:{seed}"), 6)
    }
}

fn temporary_posyandu_segment(data: &Map<String, Value>) -> String {
    let posyandu = string_value(data.get("posyandu"));
    let numeric_suffix = posyandu
        .split_whitespace()
        .last()
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .map(str::to_owned)
        .or_else(|| {
            let suffix = posyandu
                .chars()
                .rev()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>();
            (!suffix.is_empty()).then(|| suffix.chars().rev().collect::<String>())
        })
        .unwrap_or_default();
    let value = numeric_suffix.parse::<u16>().unwrap_or(0) % 100;
    format!("{value:02}")
}

fn random_temporary_posyandu_segment() -> String {
    let value = thread_rng().gen_range(10..=60);
    format!("{value:02}")
}

fn temporary_nik_prefix(data: &Map<String, Value>, id: &str) -> String {
    format!("350904{}00", temporary_birth_segment(data, id))
}

fn temporary_suffix_is_usable(data: &Map<String, Value>, id: &str, nik: &str) -> bool {
    if !is_sixteen_digits(nik) {
        return false;
    }
    let prefix = temporary_nik_prefix(data, id);
    if !nik.starts_with(&prefix) {
        return false;
    }
    let suffix = &nik[14..];
    let value = suffix.parse::<u16>().unwrap_or_default();
    let posyandu_code = temporary_posyandu_segment(data);
    value == posyandu_code.parse::<u16>().unwrap_or_default() || (10..=60).contains(&value)
}

fn normalize_child_identity(data: &mut Map<String, Value>, id: &str) -> Result<(), ApiError> {
    let has_kk = bool_value(data.get("hasKK"));
    let no_kk = string_value(data.get("noKK"));
    if has_kk && !is_sixteen_digits(&no_kk) {
        return Err(ApiError::validation("No. KK harus berisi 16 digit."));
    }
    if !has_kk && !is_sixteen_digits(&no_kk) {
        data.insert(
            "noKK".into(),
            Value::String(format!(
                "350904{}",
                deterministic_digits(&format!("family-card:{id}"), 10)
            )),
        );
    }
    let has_nik = bool_value(data.get("hasNIK"));
    let nik = string_value(data.get("nik"));
    if has_nik {
        if !is_sixteen_digits(&nik) {
            return Err(ApiError::validation("NIK balita harus berisi 16 digit."));
        }
    } else {
        let posyandu_code = temporary_posyandu_segment(data);
        let is_random_posyandu = matches!(posyandu_code.as_str(), "61" | "98" | "99");
        let suffix = if temporary_suffix_is_usable(data, id, &nik) {
            nik[14..].to_owned()
        } else if is_random_posyandu {
            random_temporary_posyandu_segment()
        } else {
            posyandu_code
        };
        data.insert(
            "nik".into(),
            Value::String(format!("{}{}", temporary_nik_prefix(data, id), suffix)),
        );
    }
    Ok(())
}

impl NativeApi {
    pub(crate) fn native_core_enabled(&self) -> bool {
        self.reads_enabled && self.writes_enabled
    }

    pub(crate) fn reads_enabled(&self) -> bool {
        self.reads_enabled
    }

    pub(crate) fn writes_enabled(&self) -> bool {
        self.writes_enabled
    }

    pub(crate) fn queue_configured(&self) -> bool {
        self.queue.is_some()
    }

    pub(crate) fn cache_configured(&self) -> bool {
        self.cache.is_some()
    }

    pub(crate) async fn cache_ready(&self) -> bool {
        match self.cache.as_ref() {
            Some(cache) => cache.ready().await,
            None => false,
        }
    }

    pub(crate) async fn invalidate_dynamic_cache(&self) {
        if let Some(cache) = self.cache.as_ref() {
            cache.invalidate().await;
        }
    }

    pub(crate) async fn from_env(
        http: Client,
        auth: Arc<NativeAuth>,
        database: Arc<NativeDatabase>,
        realtime: RealtimeHub,
        reads_enabled: bool,
        writes_enabled: bool,
    ) -> Result<Self, String> {
        Ok(Self {
            http,
            database,
            auth,
            cache: NativeCache::from_env().await?,
            queue: optional_queue_config()?,
            realtime,
            reads_enabled,
            writes_enabled,
        })
    }

    async fn publish_realtime(&self, event: RealtimeEvent) {
        // Publish locally first so a temporary LISTEN reconnect never delays
        // clients on this instance. PostgreSQL NOTIFY fans the same event out
        // to other API instances; RealtimeHub de-duplicates by event ID.
        self.realtime.publish(event.clone());
        let _ = self.database.notify_realtime(&event).await;
    }

    pub(crate) fn handles(&self, request: &Request) -> bool {
        let path = request.uri().path();
        let read = self.reads_enabled
            && request.method() == Method::GET
            && (matches!(
                request.uri().path(),
                "/api/v1/features"
                    | "/api/v1/dashboard/stats"
                    | "/api/v1/exports/sigizi-measurements"
                    | "/api/v1/children/page"
                    | "/api/v1/exclusive-breastfeeding/page"
            ) || path.starts_with("/api/v1/collections/"));
        let write = self.writes_enabled
            && ((path == "/api/v1/sync" && request.method() == Method::POST)
                || (path.starts_with("/api/v1/collections/")
                    && matches!(
                        *request.method(),
                        Method::POST | Method::PATCH | Method::DELETE
                    )));
        read || write
    }

    pub(crate) async fn handle(&self, request: Request) -> Response {
        let result = if request.method() == Method::GET {
            self.read_result(request).await
        } else {
            self.write_result(request).await
        };
        match result {
            Ok((status, value)) => api_response(status, value, "no-store"),
            Err(error) => error.into_response(),
        }
    }

    async fn read_result(&self, request: Request) -> Result<(StatusCode, Value), ApiError> {
        let path = request.uri().path().to_owned();
        let request_target = request
            .uri()
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or(path.as_str())
            .to_owned();
        let query = query_values(&request);
        let pairs = query_pairs(&request);
        let session = self
            .auth
            .authorize(request.headers().clone())
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "Sesi masuk diperlukan.",
                )
            })?;
        let _access_token = session.access_token;
        let scope = session.scope;
        let cache_scope = (
            scope.role.clone(),
            scope.desa.clone(),
            scope.posyandu.clone(),
        );
        let cacheable = dynamic_cacheable_request(&path, &query);
        let cache_key = if cacheable {
            match self.cache.as_ref() {
                Some(cache) => {
                    cache
                        .request_key(
                            &cache_scope.0,
                            cache_scope.1.as_deref(),
                            cache_scope.2.as_deref(),
                            &request_target,
                        )
                        .await
                }
                None => None,
            }
        } else {
            None
        };
        if let (Some(cache), Some(key)) = (self.cache.as_ref(), cache_key.as_deref())
            && let Some(value) = cache.get(key).await
        {
            return Ok((StatusCode::OK, value));
        }

        let value = match path.as_str() {
            "/api/v1/features" => Ok(json!({
                "csvExport": false,
                "largeExports": false,
                "notifications": false,
                "webhooks": false,
                "fileUploads": false
            })),
            "/api/v1/children/page" => self.children_page(&scope, &query).await,
            "/api/v1/exclusive-breastfeeding/page" => {
                self.exclusive_breastfeeding_page(&scope, &query).await
            }
            "/api/v1/dashboard/stats" => self.dashboard(&scope, &query).await,
            "/api/v1/exports/sigizi-measurements" => self.sigizi_export(&scope, &query).await,
            _ if path.starts_with("/api/v1/jobs/") && !path.ends_with("/file") => {
                self.background_job(&scope, &path).await
            }
            _ if path.starts_with("/api/v1/collections/") => {
                self.collection_read(&scope, &query, &pairs, &path).await
            }
            _ => Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Rute API tidak ditemukan.",
            )),
        }?;
        if let (Some(cache), Some(key)) = (self.cache.as_ref(), cache_key.as_deref()) {
            cache
                .put(key, &value, dynamic_cache_ttl_seconds(&path))
                .await;
        }
        Ok((StatusCode::OK, value))
    }

    async fn write_result(&self, request: Request) -> Result<(StatusCode, Value), ApiError> {
        let method = request.method().clone();
        let path = request.uri().path().to_owned();
        let headers = request.headers().clone();
        if !self.auth.valid_mutation_origin(&headers) {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "invalid_origin",
                "Asal permintaan tidak diizinkan.",
            ));
        }
        let (request_id, idempotency_key) = mutation_metadata(&headers)?;
        let session = self.auth.authorize(headers.clone()).await.map_err(|_| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Sesi masuk diperlukan.",
            )
        })?;
        if session.scope.access_mode != "write" {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "read_only",
                "Akun ini hanya memiliki hak baca.",
            ));
        }
        let context = MutationContext {
            scope: session.scope,
            request_id,
            idempotency_key,
        };
        let limit = if path == "/api/v1/sync" {
            SYNC_MUTATION_MAX_BODY_BYTES
        } else if path == "/api/v1/jobs" {
            BACKGROUND_JOB_MAX_BODY_BYTES
        } else {
            COLLECTION_MUTATION_MAX_BODY_BYTES
        };
        let bytes = to_bytes(request.into_body(), limit).await.map_err(|_| {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "Data melebihi batas yang diizinkan.",
            )
        })?;
        let payload = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes)
                .map_err(|_| ApiError::validation("Data dokumen tidak valid."))?
        };

        if path == "/api/v1/sync" && method == Method::POST {
            return self
                .sync_batch(&context, payload)
                .await
                .map(|value| (StatusCode::OK, value));
        }
        if path == "/api/v1/jobs" && method == Method::POST {
            return self
                .create_background_job(&context, payload)
                .await
                .map(|value| (StatusCode::CREATED, value));
        }
        let suffix = path
            .trim_start_matches("/api/v1/collections/")
            .trim_matches('/');
        let parts = suffix.split('/').collect::<Vec<_>>();
        if parts.is_empty() || parts.len() > 2 || parts[0].is_empty() {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Koleksi data tidak ditemukan.",
            ));
        }
        let resource = Resource::parse(parts[0]).ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Koleksi data tidak ditemukan.",
            )
        })?;
        match (method, parts.as_slice()) {
            (Method::POST, [_]) => self
                .collection_create(&context, resource, payload)
                .await
                .map(|value| (StatusCode::CREATED, value)),
            (Method::PATCH, [_, id]) => self
                .collection_update(&context, resource, id, payload)
                .await
                .map(|value| (StatusCode::OK, value)),
            (Method::DELETE, [_, id]) => self
                .collection_delete(&context, resource, id, payload)
                .await
                .map(|value| (StatusCode::OK, value)),
            _ => Err(ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "Metode tidak didukung.",
            )),
        }
    }

    async fn enqueue_background_job(&self, job_id: &str) -> Result<(), ApiError> {
        let queue = self.queue.as_ref().ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "queue_unavailable",
                "Antrean pekerjaan belum dikonfigurasi pada Oracle.",
            )
        })?;
        let endpoint = Url::parse(&format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/queues/{}/messages",
            queue.account_id, queue.queue_id
        ))
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "queue_unavailable",
                "Konfigurasi antrean pekerjaan tidak valid.",
            )
        })?;
        let response = self
            .http
            .post(endpoint)
            .bearer_auth(&queue.api_token)
            .json(&json!({
                "body": { "job_id": job_id },
                "content_type": "json"
            }))
            .send()
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "queue_unavailable",
                    "Antrean pekerjaan sementara tidak dapat dijangkau.",
                )
            })?;
        let status = response.status();
        let payload = response.json::<Value>().await.unwrap_or(Value::Null);
        if !status.is_success() || payload.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "queue_unavailable",
                "Pekerjaan belum dapat dimasukkan ke antrean.",
            ));
        }
        Ok(())
    }

    fn public_background_job(
        job: &Value,
        queue_configured: Option<bool>,
    ) -> Result<Value, ApiError> {
        let row = row(job)?;
        let id = text(row.get("id"));
        Ok(json!({
            "id": id,
            "kind": text(row.get("kind")),
            "status": text(row.get("status")),
            "progress": number_or_null(row.get("progress")),
            "result": row.get("result").cloned().unwrap_or(Value::Null),
            "error": row.get("error").cloned().unwrap_or(Value::Null),
            "fileName": row.get("file_name").cloned().unwrap_or(Value::Null),
            "contentType": row.get("content_type").cloned().unwrap_or(Value::Null),
            "sizeBytes": number_or_null(row.get("size_bytes")),
            "downloadUrl": if row.get("object_key").is_some_and(|value| !value.is_null()) {
                Value::String(format!("/api/v1/jobs/{id}/file"))
            } else {
                Value::Null
            },
            "createdAt": timestamp_value(row.get("created_at")),
            "updatedAt": timestamp_value(row.get("updated_at")),
            "startedAt": timestamp_value(row.get("started_at")),
            "completedAt": timestamp_value(row.get("completed_at")),
            "expiresAt": timestamp_value(row.get("expires_at")),
            "queueConfigured": queue_configured,
        }))
    }

    async fn fetch_background_job(&self, scope: &AccessScope, id: &str) -> Result<Value, ApiError> {
        let parameters = vec![
            (
                "select".into(),
                "id,kind,status,progress,owner_user_id,result,error,object_key,file_name,content_type,size_bytes,created_at,updated_at,started_at,completed_at,expires_at".into(),
            ),
            ("id".into(), format!("eq.{id}")),
            ("limit".into(), "1".into()),
        ];
        let (payload, _) = self.rest_get("background_jobs", &parameters, false).await?;
        let job = payload
            .as_array()
            .and_then(|rows| rows.first())
            .cloned()
            .ok_or_else(|| {
                ApiError::new(StatusCode::NOT_FOUND, "not_found", "Job tidak ditemukan.")
            })?;
        let owner = text(row(&job)?.get("owner_user_id"));
        if owner != scope.user_id && !is_full_access_role(&scope.role) {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Job tidak ditemukan.",
            ));
        }
        Ok(job)
    }

    async fn background_job(&self, scope: &AccessScope, path: &str) -> Result<Value, ApiError> {
        let id = path
            .strip_prefix("/api/v1/jobs/")
            .and_then(|id| Uuid::parse_str(id).ok())
            .map(|id| id.to_string())
            .ok_or_else(|| {
                ApiError::new(StatusCode::NOT_FOUND, "not_found", "Job tidak ditemukan.")
            })?;
        let job = self.fetch_background_job(scope, &id).await?;
        Self::public_background_job(&job, None)
    }

    async fn record_job_audit(
        &self,
        context: &MutationContext,
        id: &str,
        kind: &str,
    ) -> Result<(), ApiError> {
        let body = json!({
            "request_id": context.request_id,
            "idempotency_key": context.idempotency_key,
            "actor_user_id": context.scope.user_id,
            "actor_role": context.scope.role,
            "action": "job_create",
            "resource": "background_jobs",
            "document_id": id,
            "village": context.scope.desa,
            "posyandu": context.scope.posyandu,
            "metadata": { "origin": "oracle-native", "kind": kind }
        });
        self.rest_write(
            Method::POST,
            "audit_events",
            &[(
                "on_conflict".into(),
                "idempotency_key,action,resource,document_id".into(),
            )],
            Some(&body),
            Some("resolution=ignore-duplicates,return=minimal"),
        )
        .await?;
        Ok(())
    }

    async fn create_background_job(
        &self,
        context: &MutationContext,
        payload: Value,
    ) -> Result<Value, ApiError> {
        if self.queue.is_none() {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "queue_unavailable",
                "Antrean pekerjaan belum dikonfigurasi pada Oracle.",
            ));
        }
        let payload = payload
            .as_object()
            .ok_or_else(|| ApiError::validation("Data job tidak valid."))?;
        let kind = string_value(payload.get("kind")).to_ascii_lowercase();
        if !matches!(
            kind.as_str(),
            "import_validation" | "nutrition_report" | "export_file" | "system_sync"
        ) {
            return Err(ApiError::validation("Jenis job tidak valid."));
        }
        let job_payload = payload
            .get("payload")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| ApiError::validation("Payload job tidak valid."))?;
        let idempotency_key = context
            .idempotency_key
            .clone()
            .unwrap_or_else(|| context.request_id.clone());
        let job_row = json!({
            "kind": kind,
            "status": "queued",
            "progress": 0,
            "owner_user_id": context.scope.user_id,
            "actor_role": context.scope.role,
            "village": context.scope.desa,
            "posyandu": context.scope.posyandu,
            "idempotency_key": idempotency_key,
            "request_id": context.request_id,
            "payload": job_payload,
        });
        let inserted = self
            .rest_write(
                Method::POST,
                "background_jobs",
                &[("on_conflict".into(), "owner_user_id,idempotency_key".into())],
                Some(&job_row),
                Some("resolution=ignore-duplicates,return=representation"),
            )
            .await?;
        let mut created_new = true;
        let stored = match inserted.as_array().and_then(|rows| rows.first()).cloned() {
            Some(row) => row,
            None => {
                created_new = false;
                let parameters = vec![
                    ("select".into(), "*".into()),
                    (
                        "owner_user_id".into(),
                        format!("eq.{}", context.scope.user_id),
                    ),
                    ("idempotency_key".into(), format!("eq.{idempotency_key}")),
                    ("limit".into(), "1".into()),
                ];
                let (existing, _) = self.rest_get("background_jobs", &parameters, false).await?;
                existing
                    .as_array()
                    .and_then(|rows| rows.first())
                    .cloned()
                    .ok_or_else(|| {
                        ApiError::new(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "database_unavailable",
                            "Job belum dapat dibuat.",
                        )
                    })?
            }
        };
        let stored_row = row(&stored)?;
        let id = text(stored_row.get("id"));
        if !created_new {
            return Self::public_background_job(&stored, Some(true));
        }
        if let Err(error) = self.enqueue_background_job(&id).await {
            let _ = self
                .rest_write(
                    Method::PATCH,
                    "background_jobs",
                    &[("id".into(), format!("eq.{id}"))],
                    Some(&json!({
                        "status": "failed",
                        "progress": 0,
                        "error": "Antrean pekerjaan sementara tidak tersedia."
                    })),
                    Some("return=minimal"),
                )
                .await;
            return Err(error);
        }
        self.record_job_audit(context, &id, &kind).await?;
        Self::public_background_job(&stored, Some(true))
    }

    async fn rest_write(
        &self,
        method: Method,
        table: &str,
        parameters: &[(String, String)],
        payload: Option<&Value>,
        prefer: Option<&str>,
    ) -> Result<Value, ApiError> {
        let result = self
            .database
            .write(&method, table, parameters, payload, prefer)
            .await
            .map_err(native_database_error)?;
        if dynamic_cache_table(table)
            && let Some(cache) = self.cache.as_ref()
        {
            cache.invalidate().await;
        }
        Ok(result)
    }

    async fn raw_document(
        &self,
        scope: &AccessScope,
        resource: Resource,
        id: &str,
    ) -> Result<Option<Value>, ApiError> {
        if !valid_document_id(id) {
            return Err(ApiError::validation("ID data tidak valid."));
        }
        let mut parameters = vec![
            ("select".into(), resource.select().into()),
            ("id".into(), format!("eq.{id}")),
            ("limit".into(), "1".into()),
        ];
        Self::location_parameters(resource, scope, &mut parameters)?;
        let (payload, _) = self.rest_get(resource.name(), &parameters, false).await?;
        Ok(payload.as_array().and_then(|rows| rows.first()).cloned())
    }

    async fn child_for_write(
        &self,
        scope: &AccessScope,
        id: &str,
    ) -> Result<(String, String, String, String), ApiError> {
        let source = self
            .raw_document(scope, Resource::Children, id)
            .await?
            .ok_or_else(|| ApiError::validation("Data balita tidak ditemukan."))?;
        let source = row(&source)?;
        let id = text(source.get("id"));
        let name = text(source.get("name"));
        let village = text(source.get("village"));
        let posyandu = text(source.get("posyandu"));
        assert_location(scope, &village, &posyandu)?;
        Ok((id, name, village, posyandu))
    }

    async fn prepare_data(
        &self,
        scope: &AccessScope,
        resource: Resource,
        data: &mut Map<String, Value>,
        create: bool,
        id: &str,
    ) -> Result<(), ApiError> {
        validate_common_data(resource, data)?;
        match resource {
            Resource::Children => {
                if create {
                    validate_required(data, &["nama", "tglLahir", "jk", "desa", "posyandu"])?;
                }
                let village = string_value(data.get("desa"));
                let posyandu = string_value(data.get("posyandu"));
                if create {
                    assert_location(scope, &village, &posyandu)?;
                }
                if create {
                    normalize_child_identity(data, id)?;
                }
                validate_integer(data, "anakKe", 1, i16::MAX)?;
                validate_integer(data, "usiaKehamilan", 1, 50)?;
                validate_weight(data, "bbLahir", 10.0)?;
                validate_weight(data, "currentBB", 60.0)?;
                if create {
                    data.insert("createdBy".into(), Value::String(scope.role.clone()));
                }
            }
            Resource::Measurements => {
                if create {
                    validate_required(data, &["childId", "tglUkur"])?;
                }
                validate_integer(data, "ageInMonths", 0, i16::MAX)?;
                validate_weight(data, "bb", 60.0)?;
                if let Some(status) = data
                    .get("statusNaik")
                    .map(|value| string_value(Some(value)))
                    && !status.is_empty()
                    && !matches!(status.as_str(), "N" | "T" | "B" | "O")
                {
                    return Err(ApiError::validation(
                        "Status kenaikan berat badan tidak valid.",
                    ));
                }
                if let Some(child_id) = data
                    .get("childId")
                    .map(|value| string_value(Some(value)))
                    .filter(|value| !value.is_empty())
                {
                    let (child_id, child_name, village, posyandu) =
                        self.child_for_write(scope, &child_id).await?;
                    data.insert("childId".into(), Value::String(child_id));
                    data.insert("childName".into(), Value::String(child_name));
                    data.insert("desa".into(), Value::String(village));
                    data.insert("posyandu".into(), Value::String(posyandu));
                }
            }
            Resource::MpasiLogs => {
                if create {
                    validate_required(data, &["childId", "tglMonitoring"])?;
                }
                self.attach_child(scope, data).await?;
            }
            Resource::PmtPrograms => {
                if create {
                    validate_required(
                        data,
                        &[
                            "childId",
                            "category",
                            "jenisPmt",
                            "sumberAnggaran",
                            "tglPemberian",
                        ],
                    )?;
                }
                validate_integer(data, "siklusKe", 1, i16::MAX)?;
                self.attach_child(scope, data).await?;
            }
            Resource::ChangeLogs => {
                let changes = data
                    .get("changes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if create && changes.is_empty() {
                    return Err(ApiError::validation(
                        "Rincian perubahan identitas wajib diisi.",
                    ));
                }
                self.attach_child(scope, data).await?;
                data.insert("changedBy".into(), Value::String(scope.role.clone()));
                data.insert("timestamp".into(), Value::String(now_iso()));
            }
        }
        Ok(())
    }

    async fn attach_child(
        &self,
        scope: &AccessScope,
        data: &mut Map<String, Value>,
    ) -> Result<(), ApiError> {
        let Some(child_id) = data
            .get("childId")
            .map(|value| string_value(Some(value)))
            .filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        let (child_id, child_name, _, _) = self.child_for_write(scope, &child_id).await?;
        data.insert("childId".into(), Value::String(child_id));
        data.insert("childName".into(), Value::String(child_name));
        Ok(())
    }

    async fn clear_tombstone(&self, resource: Resource, id: &str) -> Result<(), ApiError> {
        self.rest_write(
            Method::DELETE,
            "sync_tombstones",
            &[
                ("resource".into(), format!("eq.{}", resource.name())),
                ("document_id".into(), format!("eq.{id}")),
            ],
            None,
            Some("return=minimal"),
        )
        .await?;
        Ok(())
    }

    async fn write_monitorings(
        &self,
        program_id: &str,
        data: &Map<String, Value>,
    ) -> Result<(), ApiError> {
        let Some(monitorings) = data.get("monitorings").and_then(Value::as_object) else {
            return Ok(());
        };
        let mut rows = Vec::new();
        for (week, source) in monitorings {
            let Ok(week_number) = week.parse::<i32>() else {
                continue;
            };
            let Some(source) = source.as_object() else {
                continue;
            };
            if !(1..=52).contains(&week_number) {
                continue;
            }
            let mut days = source
                .get("days")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|value| Value::Bool(bool_value(Some(&value))))
                .collect::<Vec<_>>();
            days.resize(7, Value::Bool(false));
            days.truncate(7);
            let health = string_value(source.get("pemantauanKesehatan"));
            let follow_up = string_value(source.get("tindakLanjut"));
            rows.push(json!({
                "program_id": program_id, "week_number": week_number,
                "monitoring_date": mapped_date(source, "tgl").unwrap_or(Value::Null),
                "weight_kg": mapped_weight(source, "bb").unwrap_or(Value::Null),
                "height_cm": mapped_number(source, "tb").unwrap_or(Value::Null),
                "measurement_method": sanitize_text(&string_value(source.get("caraUkur"))),
                "consumed_days": days,
                "health_monitoring": if health.is_empty() { "Ada" } else { health.as_str() },
                "follow_up": if follow_up.is_empty() { "Dilanjutkan" } else { follow_up.as_str() },
                "updated_at": now_iso(),
            }));
        }
        if rows.is_empty() {
            return Ok(());
        }
        self.rest_write(
            Method::POST,
            "pmt_monitorings",
            &[("on_conflict".into(), "program_id,week_number".into())],
            Some(&Value::Array(rows)),
            Some("resolution=merge-duplicates,return=minimal"),
        )
        .await?;
        Ok(())
    }

    async fn write_change_entries(
        &self,
        log_id: &str,
        data: &Map<String, Value>,
        replace: bool,
    ) -> Result<(), ApiError> {
        let changes = data
            .get("changes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if changes.is_empty() {
            return Ok(());
        }
        let entries = changes
            .into_iter()
            .filter_map(|change| change.as_object().cloned())
            .map(|change| {
                json!({
                    "change_log_id": log_id,
                    "field_name": sanitize_text(&string_value(change.get("field"))),
                    "old_value": change.get("oldValue").cloned().unwrap_or(Value::Null),
                    "new_value": change.get("newValue").cloned().unwrap_or(Value::Null),
                })
            })
            .collect::<Vec<_>>();
        if entries.iter().any(|entry| {
            entry
                .get("field_name")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        }) {
            return Err(ApiError::validation(
                "Rincian perubahan identitas tidak valid.",
            ));
        }
        if replace {
            self.rest_write(
                Method::DELETE,
                "change_log_entries",
                &[("change_log_id".into(), format!("eq.{log_id}"))],
                None,
                Some("return=minimal"),
            )
            .await?;
        }
        self.rest_write(
            Method::POST,
            "change_log_entries",
            &[],
            Some(&Value::Array(entries)),
            Some("return=minimal"),
        )
        .await?;
        Ok(())
    }

    async fn record_audit(
        &self,
        context: &MutationContext,
        action: &str,
        resource: Resource,
        id: &str,
        before: Option<Value>,
        after: Option<Value>,
    ) -> Result<(), ApiError> {
        let body = json!({
            "request_id": context.request_id,
            "idempotency_key": context.idempotency_key,
            "actor_user_id": context.scope.user_id,
            "actor_role": context.scope.role,
            "action": action, "resource": resource.name(), "document_id": id,
            "village": context.scope.desa, "posyandu": context.scope.posyandu,
            "before_data": before, "after_data": after,
            "metadata": { "origin": "oracle-native" }
        });
        self.rest_write(
            Method::POST,
            "audit_events",
            &[(
                "on_conflict".into(),
                "idempotency_key,action,resource,document_id".into(),
            )],
            Some(&body),
            Some("resolution=ignore-duplicates,return=minimal"),
        )
        .await?;
        Ok(())
    }

    async fn document_from_raw(&self, resource: Resource, raw: &Value) -> Result<Value, ApiError> {
        let id = text(row(raw)?.get("id"));
        let extras = self.enrichment(resource, std::slice::from_ref(raw)).await?;
        api_document(resource, raw, extras.get(&id).cloned())
    }

    async fn collection_create(
        &self,
        context: &MutationContext,
        resource: Resource,
        payload: Value,
    ) -> Result<Value, ApiError> {
        let payload = payload
            .as_object()
            .ok_or_else(|| ApiError::validation("Data dokumen tidak valid."))?;
        let id = string_value(payload.get("id"));
        if !valid_document_id(&id) {
            return Err(ApiError::validation("ID dan data dokumen wajib diisi."));
        }
        let mut data = payload
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| ApiError::validation("ID dan data dokumen wajib diisi."))?;
        self.prepare_data(&context.scope, resource, &mut data, true, &id)
            .await?;
        let mut db_data = map_payload(resource, &data);
        db_data.insert("id".into(), Value::String(id.clone()));
        if resource != Resource::Children {
            db_data.insert(
                "child_id".into(),
                Value::String(string_value(data.get("childId"))),
            );
        }
        let created = self
            .rest_write(
                Method::POST,
                resource.name(),
                &[("on_conflict".into(), "id".into())],
                Some(&Value::Object(db_data)),
                Some("resolution=ignore-duplicates,return=representation"),
            )
            .await?;
        let created_new = created
            .as_array()
            .is_some_and(|documents| !documents.is_empty());
        let raw = self
            .raw_document(&context.scope, resource, &id)
            .await?
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::CONFLICT,
                    "conflict",
                    "ID data sudah digunakan di wilayah lain.",
                )
            })?;
        if !created_new {
            let existing = self.document_from_raw(resource, &raw).await?;
            let existing_data = existing
                .get("data")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let retry_matches = data
                .iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "createdAt" | "updatedAt" | "createdBy" | "version"
                    )
                })
                .all(|(key, value)| existing_data.get(key) == Some(value));
            if !retry_matches {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "conflict",
                    "ID data sudah digunakan oleh dokumen berbeda.",
                ));
            }
            return Ok(existing);
        }
        self.clear_tombstone(resource, &id).await?;
        if resource == Resource::PmtPrograms {
            self.write_monitorings(&id, &data).await?;
        }
        if resource == Resource::ChangeLogs {
            self.write_change_entries(&id, &data, false).await?;
        }
        let raw = self
            .raw_document(&context.scope, resource, &id)
            .await?
            .unwrap_or(raw);
        let document = self.document_from_raw(resource, &raw).await?;
        self.record_audit(
            context,
            "create",
            resource,
            &id,
            None,
            document.get("data").cloned(),
        )
        .await?;
        let (village, posyandu) = raw_location(resource, &raw);
        self.publish_realtime(RealtimeEvent::new(
            resource.name(),
            "create",
            now_iso(),
            village,
            posyandu,
        ))
        .await;
        Ok(document)
    }

    async fn collection_update(
        &self,
        context: &MutationContext,
        resource: Resource,
        id: &str,
        payload: Value,
    ) -> Result<Value, ApiError> {
        if !valid_document_id(id) {
            return Err(ApiError::validation("ID data tidak valid."));
        }
        let payload = payload
            .as_object()
            .ok_or_else(|| ApiError::validation("Data dokumen tidak valid."))?;
        let mut data = payload
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| ApiError::validation("Data dokumen wajib diisi."))?;
        let existing = self
            .raw_document(&context.scope, resource, id)
            .await?
            .ok_or_else(|| {
                ApiError::new(StatusCode::NOT_FOUND, "not_found", "Data tidak ditemukan.")
            })?;
        let existing_document = self.document_from_raw(resource, &existing).await?;
        let existing_data = existing_document
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let already_applied = data
            .iter()
            .all(|(key, value)| existing_data.get(key) == Some(value));
        let expected_version = payload.get("expectedVersion").and_then(Value::as_u64);
        let expected_updated_at = payload
            .get("expectedUpdatedAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        if expected_version.is_some_and(|expected| {
            existing_data
                .get("version")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                != expected
        }) || expected_updated_at
            .is_some_and(|expected| string_value(existing_data.get("updatedAt")) != expected)
        {
            if already_applied {
                return Ok(existing_document);
            }
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "conflict",
                "Data telah diperbarui pengguna lain. Muat ulang sebelum menyimpan.",
            ));
        }
        let mut candidate = existing_data.clone();
        candidate.extend(data.clone());
        validate_common_data(resource, &candidate)?;
        if resource == Resource::Children {
            assert_location(
                &context.scope,
                &string_value(candidate.get("desa")),
                &string_value(candidate.get("posyandu")),
            )?;
        }
        for key in ["createdAt", "updatedAt", "createdBy", "version"] {
            data.remove(key);
        }
        self.prepare_data(&context.scope, resource, &mut data, false, id)
            .await?;
        let mut db_data = map_payload(resource, &data);
        if resource != Resource::ChangeLogs && !db_data.is_empty() {
            db_data.insert("updated_at".into(), Value::String(now_iso()));
        }
        if !db_data.is_empty() {
            let mut parameters = vec![("id".into(), format!("eq.{id}"))];
            if let Some(version) = expected_version {
                parameters.push(("version".into(), format!("eq.{version}")));
            }
            if let Some(updated_at) = expected_updated_at {
                parameters.push(("updated_at".into(), format!("eq.{updated_at}")));
            }
            let updated = self
                .rest_write(
                    Method::PATCH,
                    resource.name(),
                    &parameters,
                    Some(&Value::Object(db_data)),
                    Some("return=representation"),
                )
                .await?;
            if updated.as_array().is_some_and(Vec::is_empty) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "conflict",
                    "Data telah diperbarui pengguna lain. Muat ulang sebelum menyimpan.",
                ));
            }
        }
        if resource == Resource::PmtPrograms {
            self.write_monitorings(id, &data).await?;
        }
        if resource == Resource::ChangeLogs {
            self.write_change_entries(id, &data, true).await?;
        }
        self.clear_tombstone(resource, id).await?;
        let updated = self
            .raw_document(&context.scope, resource, id)
            .await?
            .ok_or_else(|| {
                ApiError::new(StatusCode::NOT_FOUND, "not_found", "Data tidak ditemukan.")
            })?;
        let document = self.document_from_raw(resource, &updated).await?;
        self.record_audit(
            context,
            "update",
            resource,
            id,
            existing_document.get("data").cloned(),
            document.get("data").cloned(),
        )
        .await?;
        let (village, posyandu) = raw_location(resource, &updated);
        self.publish_realtime(RealtimeEvent::new(
            resource.name(),
            "update",
            now_iso(),
            village,
            posyandu,
        ))
        .await;
        Ok(document)
    }

    async fn collection_delete(
        &self,
        context: &MutationContext,
        resource: Resource,
        id: &str,
        payload: Value,
    ) -> Result<Value, ApiError> {
        if !valid_document_id(id) {
            return Err(ApiError::validation("ID data tidak valid."));
        }
        let Some(existing) = self.raw_document(&context.scope, resource, id).await? else {
            return Ok(json!({}));
        };
        let document = self.document_from_raw(resource, &existing).await?;
        let current = document
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let expected_version = payload.get("expectedVersion").and_then(Value::as_u64);
        let expected_updated_at = payload
            .get("expectedUpdatedAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        if expected_version.is_some_and(|expected| {
            current.get("version").and_then(Value::as_u64).unwrap_or(1) != expected
        }) || expected_updated_at
            .is_some_and(|expected| string_value(current.get("updatedAt")) != expected)
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "conflict",
                "Data telah diperbarui pengguna lain. Periksa data terbaru sebelum menghapus.",
            ));
        }
        let source = row(&existing)?;
        let (village, posyandu) = match resource {
            Resource::Children => (text(source.get("village")), text(source.get("posyandu"))),
            Resource::Measurements => (
                text(source.get("legacy_village")),
                text(source.get("legacy_posyandu")),
            ),
            _ => (
                text(child_value(source, "village")),
                text(child_value(source, "posyandu")),
            ),
        };
        let mut parameters = vec![("id".into(), format!("eq.{id}"))];
        if let Some(version) = expected_version {
            parameters.push(("version".into(), format!("eq.{version}")));
        }
        if let Some(updated_at) = expected_updated_at {
            parameters.push(("updated_at".into(), format!("eq.{updated_at}")));
        }
        let deleted = self
            .rest_write(
                Method::DELETE,
                resource.name(),
                &parameters,
                None,
                Some("return=representation"),
            )
            .await?;
        if deleted.as_array().is_some_and(Vec::is_empty) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "conflict",
                "Data telah diperbarui pengguna lain. Periksa data terbaru sebelum menghapus.",
            ));
        }
        let tombstone = json!({"resource": resource.name(), "document_id": id, "village": village, "posyandu": posyandu, "deleted_at": now_iso()});
        self.rest_write(
            Method::POST,
            "sync_tombstones",
            &[("on_conflict".into(), "resource,document_id".into())],
            Some(&tombstone),
            Some("resolution=merge-duplicates,return=minimal"),
        )
        .await?;
        self.record_audit(
            context,
            "delete",
            resource,
            id,
            document.get("data").cloned(),
            None,
        )
        .await?;
        self.publish_realtime(RealtimeEvent::new(
            resource.name(),
            "delete",
            now_iso(),
            (!village.is_empty()).then_some(village),
            (!posyandu.is_empty()).then_some(posyandu),
        ))
        .await;
        Ok(json!({}))
    }

    async fn sync_batch(
        &self,
        context: &MutationContext,
        payload: Value,
    ) -> Result<Value, ApiError> {
        let payload = payload
            .as_object()
            .ok_or_else(|| ApiError::validation("Data sinkronisasi tidak valid."))?;
        let mutations = payload
            .get("mutations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if mutations.len() > 25 {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "Maksimal 25 perubahan per sinkronisasi.",
            ));
        }
        let mut results = Vec::with_capacity(mutations.len());
        for mutation in mutations {
            let mutation = mutation
                .as_object()
                .ok_or_else(|| ApiError::validation("Format perubahan tidak valid."))?;
            let mutation_id = string_value(mutation.get("id"));
            let resource_name = string_value(mutation.get("resource"));
            let document_id = string_value(mutation.get("documentId"));
            let operation = string_value(mutation.get("operation"));
            if !valid_idempotency_key(&mutation_id) || !valid_document_id(&document_id) {
                return Err(ApiError::validation("ID sinkronisasi tidak valid."));
            }
            let resource = Resource::parse(&resource_name)
                .ok_or_else(|| ApiError::validation("Koleksi sinkronisasi tidak didukung."))?;
            let mutation_context = MutationContext {
                scope: context.scope.clone(),
                request_id: context.request_id.clone(),
                idempotency_key: Some(mutation_id.clone()),
            };
            let mutation_payload = match operation.as_str() {
                "add" => {
                    json!({"id": document_id, "data": mutation.get("data").cloned().unwrap_or_else(|| json!({}))})
                }
                "update" | "delete" => json!({
                    "data": mutation.get("data").cloned().unwrap_or_else(|| json!({})),
                    "expectedVersion": mutation.get("expectedVersion").cloned().unwrap_or(Value::Null),
                    "expectedUpdatedAt": mutation.get("expectedUpdatedAt").cloned().unwrap_or(Value::Null),
                }),
                _ => return Err(ApiError::validation("Operasi sinkronisasi tidak didukung.")),
            };
            let outcome = match operation.as_str() {
                "add" => {
                    self.collection_create(&mutation_context, resource, mutation_payload)
                        .await
                }
                "update" => {
                    self.collection_update(
                        &mutation_context,
                        resource,
                        &document_id,
                        mutation_payload,
                    )
                    .await
                }
                "delete" => {
                    self.collection_delete(
                        &mutation_context,
                        resource,
                        &document_id,
                        mutation_payload,
                    )
                    .await
                }
                _ => unreachable!(),
            };
            match outcome {
                Ok(document) => results.push(json!({"id": mutation_id, "resource": resource.name(), "documentId": document_id, "operation": operation, "document": document})),
                Err(error) => {
                    let status = error.status.as_u16();
                    let code = error.code;
                    let message = error.message.clone();
                    let conflict = if error.status == StatusCode::CONFLICT {
                        match self.raw_document(&context.scope, resource, &document_id).await? {
                            Some(raw) => json!({"serverDocument": self.document_from_raw(resource, &raw).await?}),
                            None => json!({"serverDocument": Value::Null}),
                        }
                    } else { Value::Null };
                    results.push(json!({"id": mutation_id, "resource": resource.name(), "documentId": document_id, "operation": operation, "error": {"status": status, "code": code, "detail": message}, "conflict": conflict}));
                }
            }
        }
        let pulls = payload
            .get("pull")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if pulls.len() > 5 {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "Maksimal lima koleksi per sinkronisasi.",
            ));
        }
        let mut changes = Map::new();
        for pull in pulls {
            let pull = pull
                .as_object()
                .ok_or_else(|| ApiError::validation("Format pengambilan perubahan tidak valid."))?;
            let resource_name = string_value(pull.get("resource"));
            let resource = Resource::parse(&resource_name)
                .ok_or_else(|| ApiError::validation("Koleksi sinkronisasi tidak didukung."))?;
            let since = string_value(pull.get("since"));
            if !since.contains('T') {
                return Err(ApiError::validation("Cursor sinkronisasi tidak valid."));
            }
            let query = BTreeMap::from([("since".into(), since.clone())]);
            let pairs = vec![("since".into(), since)];
            changes.insert(
                resource.name().into(),
                self.collection_list(&context.scope, resource, &query, &pairs)
                    .await?,
            );
        }
        Ok(json!({"results": results, "changes": changes, "cursor": now_iso()}))
    }

    async fn rpc(&self, name: &str, payload: Value) -> Result<Value, ApiError> {
        self.database
            .rpc(name, payload)
            .await
            .map_err(native_database_error)
    }

    async fn rest_get(
        &self,
        table: &str,
        parameters: &[(String, String)],
        count: bool,
    ) -> Result<(Value, Option<String>), ApiError> {
        let result = self
            .database
            .get(table, parameters, count)
            .await
            .map_err(native_database_error)?;
        Ok((result.value, result.content_range))
    }

    fn location_parameters(
        resource: Resource,
        scope: &AccessScope,
        parameters: &mut Vec<(String, String)>,
    ) -> Result<(), ApiError> {
        if is_full_access_role(&scope.role) {
            return Ok(());
        }
        let village = scope
            .desa
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "Wilayah akun belum lengkap.",
                )
            })?;
        let (village_key, posyandu_key) = match resource {
            Resource::Children => ("village", "posyandu"),
            Resource::Measurements => ("legacy_village", "legacy_posyandu"),
            _ => ("children.village", "children.posyandu"),
        };
        parameters.push((village_key.into(), format!("eq.{village}")));
        if scope.role == "Kader Posyandu" {
            let posyandu = scope
                .posyandu
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    ApiError::new(
                        StatusCode::FORBIDDEN,
                        "forbidden",
                        "Posyandu akun belum lengkap.",
                    )
                })?;
            parameters.push((posyandu_key.into(), format!("eq.{posyandu}")));
        }
        Ok(())
    }

    fn collection_parameters(
        resource: Resource,
        query: &BTreeMap<String, String>,
        pairs: &[(String, String)],
        scope: &AccessScope,
    ) -> Result<CollectionParameters, ApiError> {
        let mut parameters = vec![("select".into(), resource.select().into())];
        let since = pairs
            .iter()
            .find(|(key, _)| key == "since")
            .map(|(_, value)| value.trim())
            .filter(|value| !value.is_empty());
        if let Some(since) = since {
            if !since.contains('T') {
                return Err(ApiError::validation("Cursor sinkronisasi tidak valid."));
            }
            parameters.push((resource.sync_column().into(), format!("gt.{since}")));
        } else {
            for (_, filter) in pairs.iter().filter(|(key, _)| key == "filter") {
                let mut parts = filter.splitn(3, '|');
                let field = parts.next().unwrap_or_default();
                let operator = parts.next().unwrap_or_default();
                let selected = parts.next().unwrap_or_default();
                let column = filter_column(resource, field).ok_or_else(|| {
                    ApiError::validation(format!("Filter atau urutan {field} tidak didukung."))
                })?;
                let operator = match operator {
                    "==" => "eq",
                    ">=" => "gte",
                    "<=" => "lte",
                    _ => return Err(ApiError::validation("Format filter tidak valid.")),
                };
                parameters.push((column.into(), format!("{operator}.{selected}")));
            }
        }
        let mut orders = Vec::new();
        for (_, order) in pairs.iter().filter(|(key, _)| key == "order") {
            let mut parts = order.splitn(2, '|');
            let field = parts.next().unwrap_or_default();
            let direction = parts.next().unwrap_or_default();
            let column = filter_column(resource, field).ok_or_else(|| {
                ApiError::validation(format!("Filter atau urutan {field} tidak didukung."))
            })?;
            if !matches!(direction, "asc" | "desc") || column.contains('.') {
                return Err(ApiError::validation(format!(
                    "Filter atau urutan {field} tidak didukung."
                )));
            }
            orders.push(format!("{column}.{direction}"));
        }
        if !orders.is_empty() {
            parameters.push(("order".into(), orders.join(",")));
        }
        let export = pairs
            .iter()
            .any(|(key, value)| key == "export" && value == "1");
        let history = resource == Resource::ChangeLogs
            && !export
            && pairs.iter().any(|(key, _)| key == "page");
        let mut page_size = 0;
        if export || history {
            let page = positive_integer(query, "page", 1, 1_000_000)?;
            page_size = positive_integer(
                query,
                "size",
                if export { 500 } else { 10 },
                if export { 500 } else { 50 },
            )?;
            parameters.push(("limit".into(), page_size.to_string()));
            parameters.push(("offset".into(), ((page - 1) * page_size).to_string()));
        }
        Self::location_parameters(resource, scope, &mut parameters)?;
        Ok((parameters, export, history, page_size))
    }

    async fn collection_read(
        &self,
        scope: &AccessScope,
        query: &BTreeMap<String, String>,
        pairs: &[(String, String)],
        path: &str,
    ) -> Result<Value, ApiError> {
        let suffix = path
            .trim_start_matches("/api/v1/collections/")
            .trim_matches('/');
        let parts = suffix.split('/').collect::<Vec<_>>();
        if parts.is_empty() || parts.len() > 2 || parts[0].is_empty() {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Koleksi data tidak ditemukan.",
            ));
        }
        let resource = Resource::parse(parts[0]).ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "Koleksi data tidak ditemukan.",
            )
        })?;
        if parts.len() == 2 {
            return self.collection_get(scope, resource, parts[1]).await;
        }
        self.collection_list(scope, resource, query, pairs).await
    }

    async fn collection_get(
        &self,
        scope: &AccessScope,
        resource: Resource,
        id: &str,
    ) -> Result<Value, ApiError> {
        if id.is_empty() || id.len() > 128 {
            return Err(ApiError::validation("ID data tidak valid."));
        }
        let mut parameters = vec![
            ("select".into(), resource.select().into()),
            ("id".into(), format!("eq.{id}")),
            ("limit".into(), "1".into()),
        ];
        Self::location_parameters(resource, scope, &mut parameters)?;
        let (payload, _) = self.rest_get(resource.name(), &parameters, false).await?;
        let rows = payload.as_array().ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_database_response",
                "Respons database tidak valid.",
            )
        })?;
        let source = rows.first().ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "not_found", "Data tidak ditemukan.")
        })?;
        let extras = self
            .enrichment(resource, std::slice::from_ref(source))
            .await?;
        api_document(resource, source, extras.get(id).cloned())
    }

    async fn collection_list(
        &self,
        scope: &AccessScope,
        resource: Resource,
        query: &BTreeMap<String, String>,
        pairs: &[(String, String)],
    ) -> Result<Value, ApiError> {
        let (parameters, export, history, page_size) =
            Self::collection_parameters(resource, query, pairs, scope)?;
        let (payload, content_range) = self.rest_get(resource.name(), &parameters, history).await?;
        let rows = payload.as_array().ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_database_response",
                "Respons database tidak valid.",
            )
        })?;
        let extras = self.enrichment(resource, rows).await?;
        let items = rows
            .iter()
            .map(|source| {
                let id = text(row(source)?.get("id"));
                api_document(resource, source, extras.get(&id).cloned())
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        let mut deleted_ids = Vec::new();
        if let Some(since) = value(query, "since") {
            let mut tombstone_parameters = vec![
                ("select".into(), "document_id".into()),
                ("resource".into(), format!("eq.{}", resource.name())),
                ("deleted_at".into(), format!("gt.{since}")),
            ];
            if !is_full_access_role(&scope.role) {
                if let Some(village) = scope.desa.as_deref() {
                    tombstone_parameters.push(("village".into(), format!("eq.{village}")));
                }
                if scope.role == "Kader Posyandu"
                    && let Some(posyandu) = scope.posyandu.as_deref()
                {
                    tombstone_parameters.push(("posyandu".into(), format!("eq.{posyandu}")));
                }
            }
            let (payload, _) = self
                .rest_get("sync_tombstones", &tombstone_parameters, false)
                .await?;
            for source in payload.as_array().into_iter().flatten() {
                let id = text(row(source)?.get("document_id"));
                if !id.is_empty() {
                    deleted_ids.push(id);
                }
            }
        }
        let total = content_range
            .as_deref()
            .and_then(|range| range.rsplit('/').next())
            .and_then(|value| value.parse::<i64>().ok());
        Ok(json!({
            "items": items,
            "deletedIds": deleted_ids,
            "cursor": time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()),
            "hasMore": export && rows.len() == page_size,
            "page": if history { query.get("page").and_then(|value| value.parse::<usize>().ok()) } else { None },
            "size": if history { Some(page_size) } else { None },
            "total": total
        }))
    }

    async fn enrichment(
        &self,
        resource: Resource,
        sources: &[Value],
    ) -> Result<BTreeMap<String, Value>, ApiError> {
        if sources.is_empty() || !matches!(resource, Resource::PmtPrograms | Resource::ChangeLogs) {
            return Ok(BTreeMap::new());
        }
        let ids = sources
            .iter()
            .map(|source| row(source).map(|row| text(row.get("id"))))
            .collect::<Result<Vec<_>, _>>()?;
        let mut output = BTreeMap::new();
        for chunk in ids.chunks(75) {
            let (table, parameters) = if resource == Resource::PmtPrograms {
                (
                    "pmt_monitorings",
                    vec![
                        ("select".into(), "program_id,week_number,monitoring_date,weight_kg,height_cm,measurement_method,consumed_days,health_monitoring,follow_up".into()),
                        ("program_id".into(), format!("in.({})", chunk.join(","))),
                        ("order".into(), "week_number.asc".into()),
                    ],
                )
            } else {
                (
                    "change_log_entries",
                    vec![
                        (
                            "select".into(),
                            "change_log_id,field_name,old_value,new_value".into(),
                        ),
                        ("change_log_id".into(), format!("in.({})", chunk.join(","))),
                        ("order".into(), "id.asc".into()),
                    ],
                )
            };
            let (payload, _) = self.rest_get(table, &parameters, false).await?;
            for source in payload.as_array().into_iter().flatten() {
                let source = row(source)?;
                if resource == Resource::PmtPrograms {
                    let program_id = text(source.get("program_id"));
                    let week = text(source.get("week_number"));
                    output
                        .entry(program_id)
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .expect("monitoring object")
                        .insert(
                            week,
                            json!({
                                "tgl": date_or_null(source.get("monitoring_date")),
                                "bb": number_or_null(source.get("weight_kg")),
                                "tb": number_or_null(source.get("height_cm")),
                                "caraUkur": text(source.get("measurement_method")),
                                "days": source.get("consumed_days").cloned().unwrap_or_else(|| json!([false,false,false,false,false,false,false])),
                                "pemantauanKesehatan": text(source.get("health_monitoring")),
                                "tindakLanjut": text(source.get("follow_up"))
                            }),
                        );
                } else {
                    let log_id = text(source.get("change_log_id"));
                    output
                        .entry(log_id)
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .expect("change array")
                        .push(json!({
                            "field": text(source.get("field_name")),
                            "oldValue": nullable(source.get("old_value")),
                            "newValue": nullable(source.get("new_value"))
                        }));
                }
            }
        }
        Ok(output)
    }

    async fn children_page(
        &self,
        scope: &AccessScope,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        let as_of = date_value(query, "asOf", "Periode data balita tidak valid.")?;
        let start = date_value(
            query,
            "measurementStart",
            "Periode data balita tidak valid.",
        )?;
        let end = date_value(query, "measurementEnd", "Periode data balita tidak valid.")?;
        let page = positive_integer(query, "page", 1, 1_000_000)?;
        let size = positive_integer(query, "size", 10, 50)?;
        let view = value(query, "view").unwrap_or("data");
        let sort = value(query, "sort").unwrap_or("recent");
        if !matches!(
            sort,
            "recent" | "oldest_input" | "name_asc" | "name_desc" | "age_oldest" | "age_youngest"
        ) {
            return Err(ApiError::validation("Urutan data balita tidak valid."));
        }
        if value(query, "search").is_some_and(|value| value.chars().count() > 80) {
            return Err(ApiError::validation("Kata pencarian terlalu panjang."));
        }
        let village = scoped_value(scope, value(query, "village"), true);
        let posyandu = scoped_value(scope, value(query, "posyandu"), false);
        let (rpc, payload) = if matches!(
            view,
            "problem_underweight" | "problem_stunting" | "problem_wasting" | "problem_tidak_naik"
        ) {
            (
                "eposyandu_problem_children_page",
                json!({
                    "p_month_start": start,
                    "p_month_end": end,
                    "p_problem": view,
                    "p_page": page,
                    "p_size": size,
                    "p_search": value(query, "search"),
                    "p_sort": sort,
                    "p_village": village,
                    "p_posyandu": posyandu,
                    "p_role": database_scope_role(&scope.role),
                    "p_scope_village": scope.desa,
                    "p_scope_posyandu": scope.posyandu
                }),
            )
        } else {
            if !matches!(view, "data" | "recent" | "recycle" | "mpasi") {
                return Err(ApiError::validation("Tampilan data balita tidak valid."));
            }
            (
                "eposyandu_replica_children_page",
                json!({
                    "p_as_of": as_of,
                    "p_measurement_start": start,
                    "p_measurement_end": end,
                    "p_page": page,
                    "p_size": size,
                    "p_sort": sort,
                    "p_view": view,
                    "p_search": value(query, "search"),
                    "p_village": village,
                    "p_posyandu": posyandu,
                    "p_role": database_scope_role(&scope.role),
                    "p_scope_village": scope.desa,
                    "p_scope_posyandu": scope.posyandu
                }),
            )
        };
        self.rpc(rpc, payload).await
    }

    async fn exclusive_breastfeeding_page(
        &self,
        scope: &AccessScope,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        let start = date_value(
            query,
            "measurementStart",
            "Parameter ASI eksklusif tidak valid.",
        )?;
        let end = date_value(
            query,
            "measurementEnd",
            "Parameter ASI eksklusif tidak valid.",
        )?;
        let age_group = required_value(query, "ageGroup", "Parameter ASI eksklusif tidak valid.")?;
        if !matches!(age_group, "0-5" | "6") {
            return Err(ApiError::validation("Parameter ASI eksklusif tidak valid."));
        }
        self.rpc(
            "eposyandu_exclusive_breastfeeding_page",
            json!({
                "p_measurement_start": start,
                "p_measurement_end": end,
                "p_age_group": age_group,
                "p_page": positive_integer(query, "page", 1, 1_000_000)?,
                "p_size": positive_integer(query, "size", 10, 50)?,
                "p_village": scoped_value(scope, value(query, "village"), true),
                "p_posyandu": scoped_value(scope, value(query, "posyandu"), false),
                "p_role": database_scope_role(&scope.role),
                "p_scope_village": scope.desa,
                "p_scope_posyandu": scope.posyandu
            }),
        )
        .await
    }

    async fn dashboard(
        &self,
        scope: &AccessScope,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        let invalid = "Periode dashboard tidak valid.";
        self.rpc(
            "eposyandu_dashboard_stats",
            json!({
                "p_month_start": date_value(query, "monthStart", invalid)?,
                "p_month_end": date_value(query, "monthEnd", invalid)?,
                "p_previous_month_start": date_value(query, "previousMonthStart", invalid)?,
                "p_previous_month_end": date_value(query, "previousMonthEnd", invalid)?,
                "p_village": scoped_value(scope, value(query, "village"), true),
                "p_posyandu": scoped_value(scope, value(query, "posyandu"), false),
                "p_role": database_scope_role(&scope.role),
                "p_scope_village": scope.desa,
                "p_scope_posyandu": scope.posyandu
            }),
        )
        .await
    }

    async fn sigizi_export(
        &self,
        scope: &AccessScope,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        let invalid = "Periode ekspor pengukuran tidak valid.";
        self.rpc(
            "eposyandu_sigizi_measurement_export",
            json!({
                "p_month_start": date_value(query, "monthStart", invalid)?,
                "p_month_end": date_value(query, "monthEnd", invalid)?,
                "p_village": scoped_value(scope, value(query, "village"), true),
                "p_posyandu": scoped_value(scope, value(query, "posyandu"), false),
                "p_role": database_scope_role(&scope.role),
                "p_scope_village": scope.desa,
                "p_scope_posyandu": scope.posyandu
            }),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_dates_strictly() {
        assert!(is_date("2026-08-21"));
        assert!(!is_date("21-08-2026"));
        assert!(!is_date("2026-8-21"));
    }

    #[test]
    fn enforces_role_scope_over_requested_location() {
        let scope = AccessScope {
            user_id: "user-1".into(),
            email: None,
            role: "Kader Posyandu".into(),
            desa: Some("Mayangan".into()),
            posyandu: Some("Salak 36".into()),
            access_mode: "write".into(),
        };
        assert_eq!(
            scoped_value(&scope, Some("Desa lain"), true).as_deref(),
            Some("Mayangan")
        );
        assert_eq!(
            scoped_value(&scope, Some("Posyandu lain"), false).as_deref(),
            Some("Salak 36")
        );
    }

    #[test]
    fn dashboard_cache_is_shorter_than_other_dynamic_reads() {
        assert_eq!(dynamic_cache_ttl_seconds("/api/v1/dashboard/stats"), 60);
        assert_eq!(dynamic_cache_ttl_seconds("/api/v1/children/page"), 300);
        assert_eq!(
            dynamic_cache_ttl_seconds("/api/v1/collections/measurements"),
            300
        );
    }

    #[test]
    fn temporary_nik_uses_birth_date_and_posyandu_code() {
        let data = serde_json::json!({
            "tglLahir": "2026-07-31",
            "hasNIK": false,
            "nik": "",
            "posyandu": "SALAK 1"
        })
        .as_object()
        .cloned()
        .expect("child payload");
        assert_eq!(temporary_birth_segment(&data, "child-test"), "310726");
        assert_eq!(temporary_posyandu_segment(&data), "01");
    }

    #[test]
    fn temporary_nik_preserves_random_suffix_for_special_posyandu() {
        let mut data = serde_json::json!({
            "tglLahir": "2026-07-31",
            "hasNIK": false,
            "nik": "3509043107260012",
            "posyandu": "SALAK 98"
        })
        .as_object()
        .cloned()
        .expect("child payload");

        normalize_child_identity(&mut data, "child-special").expect("temporary identity");

        assert_eq!(string_value(data.get("nik")), "3509043107260012");
    }
}
