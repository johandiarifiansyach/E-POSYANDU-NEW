use crate::{
    AccessScope, ApiFailure, ApiResult, hashed_key, optional_secret, redis_commands, require_scope,
    secret,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use worker::{
    Env, Fetch, Headers, HttpMetadata, Method, Request, RequestInit, Response,
    wasm_bindgen::JsValue,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Resource {
    Children,
    Measurements,
    MpasiLogs,
    PmtPrograms,
    ChangeLogs,
}

const DYNAMIC_CACHE_TTL_SECONDS: u64 = 5 * 60;
const DASHBOARD_CACHE_TTL_SECONDS: u64 = 60;
const DYNAMIC_CACHE_VERSION_KEY: &str = "dynamic:data:version:v1";
const REPLICA_PRIMARY_PIN_SECONDS: u64 = 360;
const FEATURE_FLAGS_KEY: &str = "feature:flags:v1";
const CHANGE_AUDIT_MAX_DISTANCE_MS: f64 = 5.0 * 60.0 * 1_000.0;
const COLLECTION_MUTATION_MAX_BODY_BYTES: usize = 256 * 1024;
const BACKGROUND_JOB_MAX_BODY_BYTES: usize = 4_000_000;
const BACKGROUND_JOB_MAX_FILE_BYTES: usize = 50_000_000;
const IDENTITY_CHANGE_FIELDS: [&str; 23] = [
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
];

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

    fn sync_column(self) -> &'static str {
        if self == Self::ChangeLogs {
            "changed_at"
        } else {
            "updated_at"
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
}

fn api_error(status: u16, detail: impl Into<String>) -> ApiFailure {
    ApiFailure::new(status, detail)
}

fn valid_idempotency_key(key: &str) -> bool {
    (8..=128).contains(&key.len())
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

fn validate_idempotency_key(request: &Request) -> ApiResult<()> {
    let Some(key) = request
        .headers()
        .get("Idempotency-Key")
        .map_err(|_| api_error(422, "Kunci idempotensi tidak valid."))?
    else {
        return Ok(());
    };
    if !valid_idempotency_key(&key) {
        return Err(api_error(422, "Kunci idempotensi tidak valid."));
    }
    Ok(())
}

fn mutation_request_metadata(request: &Request) -> (String, Option<String>) {
    let idempotency_key = request
        .headers()
        .get("Idempotency-Key")
        .ok()
        .flatten()
        .filter(|value| valid_idempotency_key(value));
    let request_id = request
        .headers()
        .get("X-Request-ID")
        .ok()
        .flatten()
        .or_else(|| request.headers().get("CF-Ray").ok().flatten())
        .or_else(|| idempotency_key.clone())
        .unwrap_or_else(|| format!("audit-{}", now_iso()));
    (request_id, idempotency_key)
}

fn now_iso() -> String {
    worker::js_sys::Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}

fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn nullable_value(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

fn identity_changes(before: Option<&Value>, after: Option<&Value>) -> Vec<Value> {
    let before = before.and_then(Value::as_object);
    let after = after.and_then(Value::as_object);
    IDENTITY_CHANGE_FIELDS
        .iter()
        .filter_map(|field| {
            let old_value = before
                .and_then(|data| data.get(*field))
                .cloned()
                .unwrap_or(Value::Null);
            let new_value = after
                .and_then(|data| data.get(*field))
                .cloned()
                .unwrap_or(Value::Null);
            (old_value != new_value).then(|| {
                json!({
                    "field": field,
                    "oldValue": old_value,
                    "newValue": new_value,
                })
            })
        })
        .collect()
}

fn change_entries_from_payload(data: &Map<String, Value>) -> Vec<Value> {
    data.get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|change| {
            let field = string_value(change.get("field"));
            let old_value = nullable_value(change.get("oldValue"));
            let new_value = nullable_value(change.get("newValue"));
            (!field.trim().is_empty() && old_value != new_value).then(|| {
                json!({
                    "field": field,
                    "oldValue": old_value,
                    "newValue": new_value,
                })
            })
        })
        .collect()
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

fn normalize_decimal_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut has_separator = false;
    for character in value.trim().chars() {
        if character.is_ascii_digit() {
            normalized.push(character);
            continue;
        }
        if character == '-' && normalized.is_empty() {
            normalized.push('-');
            continue;
        }
        if !has_separator
            && matches!(
                character,
                '.' | ',' | '\u{066B}' | '\u{066C}' | '\u{FF0C}' | '\u{FE50}' | '\u{FF0E}'
            )
        {
            normalized.push('.');
            has_separator = true;
        }
    }
    normalized
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(value)) => value.as_f64(),
        Some(Value::String(value)) => {
            let normalized = normalize_decimal_text(value);
            if normalized.is_empty() || normalized == "-" {
                None
            } else {
                normalized.parse::<f64>().ok()
            }
        }
        _ => None,
    }
}

fn number_or_null(value: Option<&Value>) -> Value {
    number_value(value).map_or(Value::Null, |value| json!(value))
}

fn date_value(value: Option<&Value>) -> Value {
    let value = string_value(value);
    if is_date(&value) {
        Value::String(value[..10].into())
    } else {
        Value::Null
    }
}

fn timestamp_value(value: Option<&Value>) -> Value {
    let value = string_value(value);
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

fn row_object(row: &Value) -> ApiResult<&Map<String, Value>> {
    row.as_object()
        .ok_or_else(|| api_error(503, "Respons database tidak dapat dibaca."))
}

fn nested_child(row: &Map<String, Value>) -> Option<&Map<String, Value>> {
    row.get("children").and_then(Value::as_object)
}

fn child_field<'a>(row: &'a Map<String, Value>, key: &str, fallback: &str) -> Option<&'a Value> {
    row.get(key)
        .or_else(|| nested_child(row).and_then(|child| child.get(fallback)))
}

fn preferred_child_value(row: &Map<String, Value>, primary: &str, fallback: &str) -> String {
    let value = string_value(row.get(primary));
    if value.is_empty() {
        string_value(child_field(row, primary, fallback))
    } else {
        value
    }
}

fn preferred_value(row: &Map<String, Value>, primary: &str, fallback: &str) -> String {
    let value = string_value(row.get(primary));
    if value.is_empty() {
        string_value(row.get(fallback))
    } else {
        value
    }
}

fn api_document(resource: Resource, row: &Value, extras: Option<Value>) -> ApiResult<Value> {
    let row = row_object(row)?;
    let data = match resource {
        Resource::Children => json!({
            "nama": string_value(row.get("name")),
            "nik": string_value(row.get("national_id")),
            "anakKe": number_or_null(row.get("child_order")),
            "tglLahir": if date_value(row.get("birth_date")).is_null() { Value::String(string_value(row.get("birth_date_raw"))) } else { date_value(row.get("birth_date")) },
            "jk": string_value(row.get("sex")),
            "noKK": string_value(row.get("family_card_number")),
            "hasKK": bool_value(row.get("has_family_card")),
            "hasNIK": bool_value(row.get("has_national_id")),
            "usiaKehamilan": number_or_null(row.get("gestational_age_weeks")),
            "bbLahir": number_or_null(row.get("birth_weight_kg")),
            "pbLahir": number_or_null(row.get("birth_length_cm")),
            "lkLahir": number_or_null(row.get("birth_head_circumference_cm")),
            "bukuKIA": yes_no(row.get("has_maternal_child_book")),
            "bukuKIAKecil": yes_no(row.get("has_small_baby_book")),
            "imd": yes_no(row.get("early_breastfeeding_initiation")),
            "namaOrtu": string_value(row.get("parent_name")),
            "nikOrtu": string_value(row.get("parent_national_id")),
            "noHpOrtu": string_value(row.get("parent_phone")),
            "alamat": string_value(row.get("address")),
            "rt": string_value(row.get("rt")),
            "rw": string_value(row.get("rw")),
            "desa": string_value(row.get("village")),
            "posyandu": string_value(row.get("posyandu")),
            "currentBB": number_or_null(row.get("current_weight_kg")),
            "currentTB": number_or_null(row.get("current_height_cm")),
            "currentLILA": number_or_null(row.get("current_mid_upper_arm_circumference_cm")),
            "currentLK": number_or_null(row.get("current_head_circumference_cm")),
            "lastMeasurementDate": date_value(row.get("last_measurement_date")),
            "createdAt": timestamp_value(row.get("created_at")),
            "createdBy": nullable_value(row.get("created_by")),
            "updatedAt": timestamp_value(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1)),
            "deletedAt": timestamp_value(row.get("deleted_at")),
            "deleteReason": nullable_value(row.get("delete_reason")),
            "deathDate": date_value(row.get("death_date")),
            "deathCause": nullable_value(row.get("death_cause")),
            "deathLocation": nullable_value(row.get("death_location")),
        }),
        Resource::Measurements => json!({
            "childId": string_value(row.get("legacy_child_id")),
            "childName": preferred_child_value(row, "legacy_child_name", "name"),
            "desa": preferred_child_value(row, "legacy_village", "village"),
            "posyandu": preferred_child_value(row, "legacy_posyandu", "posyandu"),
            "tglUkur": if date_value(row.get("measurement_date")).is_null() { Value::String(string_value(row.get("measurement_date_raw"))) } else { date_value(row.get("measurement_date")) },
            "bb": number_or_null(row.get("weight_kg")),
            "tb": number_or_null(row.get("height_cm")),
            "lk": number_or_null(row.get("head_circumference_cm")),
            "lila": number_or_null(row.get("mid_upper_arm_circumference_cm")),
            "edema": string_value(row.get("edema")),
            "kelasIbu": string_value(row.get("mother_class_attendance")),
            "mbg": string_value(row.get("mbg")),
            "vitA": string_value(row.get("vitamin_a")),
            "asi": string_value(row.get("exclusive_breastfeeding")),
            "caraUkur": string_value(row.get("measurement_method")),
            "statusNaik": string_value(row.get("weight_gain_status")),
            "ageInMonths": number_or_null(row.get("age_in_months")),
            "createdAt": timestamp_value(row.get("created_at")),
            "updatedAt": timestamp_value(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1)),
        }),
        Resource::MpasiLogs => json!({
            "childId": string_value(row.get("legacy_child_id")),
            "childName": preferred_child_value(row, "legacy_child_name", "name"),
            "tglMonitoring": date_value(row.get("monitoring_date")),
            "asi": string_value(row.get("breastfeeding")),
            "makananPokok": yes_array(row.get("staple_food")),
            "kacang": yes_array(row.get("legumes")),
            "susu": yes_array(row.get("dairy")),
            "daging": yes_array(row.get("meat")),
            "telur": yes_array(row.get("eggs")),
            "sayurVitA": yes_array(row.get("vitamin_a_fruit_vegetable")),
            "sayurLain": yes_array(row.get("other_fruit_vegetable")),
            "intervensiGizi": string_value(row.get("nutrition_intervention")),
            "createdAt": timestamp_value(row.get("created_at")),
            "updatedAt": timestamp_value(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1)),
        }),
        Resource::PmtPrograms => json!({
            "childId": string_value(row.get("legacy_child_id")),
            "childName": preferred_child_value(row, "legacy_child_name", "name"),
            "category": string_value(row.get("category")),
            "jenisPmt": string_value(row.get("pmt_type")),
            "sumberAnggaran": string_value(row.get("funding_source")),
            "mitra": string_value(row.get("partner")),
            "mitraLain": string_value(row.get("other_partner")),
            "siklusKe": number_or_null(row.get("cycle_number")),
            "pmtSesuaiJuknis": string_value(row.get("follows_guidelines")),
            "tglPemberian": date_value(row.get("distribution_date")),
            "initialMeasurementDate": date_value(row.get("initial_measurement_date")),
            "initialBB": number_or_null(row.get("initial_weight_kg")),
            "initialTB": number_or_null(row.get("initial_height_cm")),
            "status": string_value(row.get("status")),
            "monitorings": extras.unwrap_or_else(|| json!({})),
            "createdAt": timestamp_value(row.get("created_at")),
            "updatedAt": timestamp_value(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1)),
        }),
        Resource::ChangeLogs => json!({
            "childId": preferred_value(row, "legacy_child_id", "child_id"),
            "childName": preferred_child_value(row, "child_name", "name"),
            "changes": extras.unwrap_or_else(|| json!([])),
            "changedBy": string_value(row.get("changed_by")),
            "timestamp": timestamp_value(row.get("changed_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1)),
        }),
    };
    Ok(json!({ "id": string_value(row.get("id")), "data": data }))
}

fn is_date(value: &str) -> bool {
    let value = value.get(..10).unwrap_or_default();
    value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value
            .as_bytes()
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn parse_positive(value: Option<&String>, fallback: usize, maximum: usize) -> ApiResult<usize> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(fallback);
    };
    let parsed = value
        .parse::<usize>()
        .map_err(|_| api_error(422, "Parameter halaman tidak valid."))?;
    if parsed == 0 || parsed > maximum {
        return Err(api_error(422, "Parameter halaman tidak valid."));
    }
    Ok(parsed)
}

fn add_months(date: &str, delta: i32) -> Option<String> {
    if !is_date(date) {
        return None;
    }
    let year = date.get(0..4)?.parse::<i32>().ok()?;
    let month = date.get(5..7)?.parse::<i32>().ok()?;
    let day = date.get(8..10)?.parse::<u32>().ok()?;
    let serial = year
        .checked_mul(12)?
        .checked_add(month - 1)?
        .checked_add(delta)?;
    let next_year = serial.div_euclid(12);
    let next_month = serial.rem_euclid(12) + 1;
    let max_day = match next_month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (next_year % 4 == 0 && next_year % 100 != 0) || next_year % 400 == 0 => 29,
        _ => 28,
    };
    Some(format!(
        "{next_year:04}-{next_month:02}-{:02}",
        day.min(max_day)
    ))
}

fn query_string(parameters: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in parameters {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

fn rest_path(path: &str, parameters: &[(String, String)]) -> String {
    if parameters.is_empty() {
        path.into()
    } else {
        format!("{path}?{}", query_string(parameters))
    }
}

async fn rest_json(
    env: &Env,
    path: String,
    method: Method,
    body: Option<Value>,
    prefer: Option<&str>,
    count: bool,
) -> ApiResult<(Value, Option<String>)> {
    let base_url = secret(env, "SUPABASE_URL")?
        .trim_end_matches('/')
        .to_owned();
    let secret_key = secret(env, "SUPABASE_SECRET_KEY")?;
    let headers = Headers::new();
    headers
        .set("apikey", &secret_key)
        .map_err(|_| api_error(503, "Konfigurasi Supabase belum tersedia."))?;
    headers
        .set("Authorization", &format!("Bearer {secret_key}"))
        .map_err(|_| api_error(503, "Konfigurasi Supabase belum tersedia."))?;
    headers
        .set("Accept", "application/json")
        .map_err(|_| api_error(503, "Konfigurasi Supabase belum tersedia."))?;
    if body.is_some() {
        headers
            .set("Content-Type", "application/json")
            .map_err(|_| api_error(503, "Konfigurasi Supabase belum tersedia."))?;
    }
    let mut preferences = Vec::new();
    if count {
        preferences.push("count=exact");
    }
    if let Some(prefer) = prefer {
        preferences.push(prefer);
    }
    if !preferences.is_empty() {
        headers
            .set("Prefer", &preferences.join(","))
            .map_err(|_| api_error(503, "Konfigurasi Supabase belum tersedia."))?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        let encoded = serde_json::to_string(&body)
            .map_err(|_| api_error(422, "Data permintaan tidak valid."))?;
        init.with_body(Some(JsValue::from_str(&encoded)));
    }
    let request = Request::new_with_init(&format!("{base_url}/rest/v1/{path}"), &init)
        .map_err(|_| api_error(503, "Layanan data belum tersedia."))?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|_| api_error(503, "Layanan data belum tersedia."))?;
    let status = response.status_code();
    let content_range = response.headers().get("Content-Range").ok().flatten();
    let raw = response
        .text()
        .await
        .map_err(|_| api_error(503, "Respons layanan data tidak dapat dibaca."))?;
    let payload = if raw.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(&raw)
            .map_err(|_| api_error(503, "Respons layanan data tidak dapat dibaca."))?
    };
    if !(200..300).contains(&status) {
        let detail = payload
            .get("message")
            .or_else(|| payload.get("hint"))
            .and_then(Value::as_str)
            .unwrap_or("Data tidak dapat diproses.");
        return Err(api_error(
            if status == 401 || status == 403 {
                503
            } else {
                422
            },
            detail,
        ));
    }
    Ok((payload, content_range))
}

async fn record_audit_event(
    env: &Env,
    scope: &AccessScope,
    request_id: &str,
    idempotency_key: Option<&str>,
    action: &str,
    resource: Resource,
    document_id: &str,
    before_data: Option<Value>,
    after_data: Option<Value>,
) -> ApiResult<()> {
    record_operational_audit(
        env,
        &scope.user_id,
        &scope.role,
        scope.desa.as_deref(),
        scope.posyandu.as_deref(),
        request_id,
        idempotency_key,
        action,
        resource.name(),
        document_id,
        before_data,
        after_data,
        json!({}),
    )
    .await
}

pub(crate) async fn record_operational_audit(
    env: &Env,
    actor_user_id: &str,
    actor_role: &str,
    village: Option<&str>,
    posyandu: Option<&str>,
    request_id: &str,
    idempotency_key: Option<&str>,
    action: &str,
    resource: &str,
    document_id: &str,
    before_data: Option<Value>,
    after_data: Option<Value>,
    metadata: Value,
) -> ApiResult<()> {
    let body = json!({
        "request_id": request_id,
        "idempotency_key": idempotency_key,
        "actor_user_id": actor_user_id,
        "actor_role": actor_role,
        "action": action,
        "resource": resource,
        "document_id": document_id,
        "village": village,
        "posyandu": posyandu,
        "before_data": before_data,
        "after_data": after_data,
        "metadata": metadata,
    });
    rest_json(
        env,
        "audit_events?on_conflict=idempotency_key,action,resource,document_id".into(),
        Method::Post,
        Some(body),
        Some("resolution=ignore-duplicates,return=minimal"),
        false,
    )
    .await?;
    Ok(())
}

fn rows(payload: Value) -> ApiResult<Vec<Value>> {
    payload
        .as_array()
        .cloned()
        .ok_or_else(|| api_error(503, "Respons layanan data tidak dapat dibaca."))
}

fn count_from_range(content_range: Option<String>) -> i64 {
    content_range
        .as_deref()
        .and_then(|value| value.rsplit('/').next())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default()
}

fn is_full_access_role(role: &str) -> bool {
    matches!(role, "Ahli Gizi" | "super_admin")
}

fn database_scope_role(role: &str) -> &str {
    if is_full_access_role(role) {
        "Ahli Gizi"
    } else {
        role
    }
}

fn location_parameters(
    resource: Resource,
    scope: &AccessScope,
    parameters: &mut Vec<(String, String)>,
) -> ApiResult<()> {
    if is_full_access_role(&scope.role) {
        return Ok(());
    }
    let village = scope
        .desa
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| api_error(403, "Wilayah akun belum lengkap."))?;
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
            .ok_or_else(|| api_error(403, "Posyandu akun belum lengkap."))?;
        parameters.push((posyandu_key.into(), format!("eq.{posyandu}")));
    }
    Ok(())
}

fn assert_location(scope: &AccessScope, village: &str, posyandu: &str) -> ApiResult<()> {
    if is_full_access_role(&scope.role) {
        return Ok(());
    }
    if scope.desa.as_deref() != Some(village) {
        return Err(api_error(403, "Data berada di luar wilayah akun."));
    }
    if scope.role == "Kader Posyandu" && scope.posyandu.as_deref() != Some(posyandu) {
        return Err(api_error(403, "Data berada di luar posyandu akun."));
    }
    Ok(())
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

fn query_pairs(request: &Request) -> ApiResult<BTreeMap<String, Vec<String>>> {
    let url = request
        .url()
        .map_err(|_| api_error(400, "Alamat API tidak valid."))?;
    let mut values = BTreeMap::<String, Vec<String>>::new();
    for (key, value) in url.query_pairs() {
        values
            .entry(key.into_owned())
            .or_default()
            .push(value.into_owned());
    }
    Ok(values)
}

fn first_query<'a>(query: &'a BTreeMap<String, Vec<String>>, key: &str) -> Option<&'a String> {
    query.get(key).and_then(|values| values.first())
}

fn dynamic_cacheable_request(request: &Request) -> bool {
    let path = request.path();
    let export = request
        .url()
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "export")
                .map(|(_, value)| value == "1")
        })
        .unwrap_or(false);
    dynamic_cacheable_target(&request.method(), &path, export)
}

fn dynamic_cacheable_target(method: &Method, path: &str, export: bool) -> bool {
    *method == Method::Get
        && !export
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

fn dynamic_cache_key(scope: &AccessScope, request_target: &str, version: &str) -> String {
    let value = [
        version,
        scope.role.as_str(),
        scope.desa.as_deref().unwrap_or_default(),
        scope.posyandu.as_deref().unwrap_or_default(),
        request_target,
    ]
    .join("\u{1f}");
    hashed_key("dynamic:data:v1", &value)
}

fn redis_result(payload: &Value, index: usize) -> Option<&Value> {
    payload.as_array()?.get(index)?.get("result")
}

async fn dynamic_cache_version(env: &Env) -> String {
    let seed = worker::js_sys::Date::now().floor() as u64;
    redis_commands(
        env,
        json!([
            ["SET", DYNAMIC_CACHE_VERSION_KEY, seed, "NX"],
            ["GET", DYNAMIC_CACHE_VERSION_KEY]
        ]),
    )
    .await
    .as_ref()
    .and_then(|payload| redis_result(payload, 1))
    .and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
    .unwrap_or_else(|| "0".into())
}

async fn cached_dynamic_data(env: &Env, key: &str) -> Option<Value> {
    let payload = redis_commands(env, json!([["GET", key]])).await?;
    let encoded = redis_result(&payload, 0)?.as_str()?;
    serde_json::from_str(encoded).ok()
}

async fn cache_dynamic_data(env: &Env, key: &str, value: &Value, ttl_seconds: u64) {
    let Ok(encoded) = serde_json::to_string(value) else {
        return;
    };
    let _ = redis_commands(env, json!([["SET", key, encoded, "EX", ttl_seconds]])).await;
}

fn replica_primary_pin_key(user_id: &str) -> String {
    hashed_key("replica:primary-pin:v1", user_id)
}

async fn replica_reads_pinned_to_primary(env: &Env, user_id: &str) -> bool {
    redis_commands(env, json!([["GET", replica_primary_pin_key(user_id)]]))
        .await
        .as_ref()
        .and_then(|payload| redis_result(payload, 0))
        .filter(|value| !value.is_null())
        .is_some()
}

async fn invalidate_dynamic_cache(env: &Env, user_id: &str) {
    let _ = redis_commands(
        env,
        json!([
            [
                "SET",
                replica_primary_pin_key(user_id),
                "primary",
                "EX",
                REPLICA_PRIMARY_PIN_SECONDS
            ],
            ["INCR", DYNAMIC_CACHE_VERSION_KEY]
        ]),
    )
    .await;
}

async fn feature_flags(request: Request, env: &Env) -> ApiResult<Value> {
    let _scope = require_scope(&request, env).await?;
    let defaults = json!({
        "csvExport": false,
        "largeExports": false,
        "notifications": false,
        "webhooks": false,
        "fileUploads": false,
    });
    let Ok(cache) = env.kv("E_POSYANDU_CACHE") else {
        return Ok(defaults);
    };
    let configured = cache
        .get(FEATURE_FLAGS_KEY)
        .text()
        .await
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str::<Value>(&value).ok());
    let Some(configured) = configured.and_then(|value| value.as_object().cloned()) else {
        return Ok(defaults);
    };
    let mut result = defaults.as_object().cloned().unwrap_or_default();
    for key in [
        "csvExport",
        "largeExports",
        "notifications",
        "webhooks",
        "fileUploads",
    ] {
        if let Some(value) = configured.get(key).and_then(Value::as_bool) {
            result.insert(key.into(), Value::Bool(value));
        }
    }
    Ok(Value::Object(result))
}

fn safe_client_error_field(value: Option<&Value>, max_chars: usize) -> String {
    string_value(value)
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(max_chars)
        .collect()
}

fn optional_env(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .ok()
        .or_else(|| env.var(name).ok())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

async fn send_client_error_email(
    env: &Env,
    scope: &AccessScope,
    request_id: &str,
    source: &str,
    error_type: &str,
    route: &str,
    stack_frames: &str,
) {
    let Some(api_key) = optional_env(env, "RESEND_API_KEY") else {
        return;
    };
    let Some(email_to) = optional_env(env, "ERROR_REPORT_EMAIL_TO") else {
        return;
    };
    let Some(email_from) = optional_env(env, "ERROR_REPORT_EMAIL_FROM") else {
        return;
    };

    let environment = env
        .var("ENVIRONMENT")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "unknown".into());
    let subject =
        format!("[E-Posyandu][{environment}] Laporan Error Frontend {error_type} ({source})");
    let text = format!(
        "Terjadi error frontend dan pengguna menekan Laporkan Masalah.\n\nrequest_id: {request_id}\nuser_id: {}\nrole: {}\nsource: {source}\nroute: {route}\nerror_type: {error_type}\n\nstack_frames:\n{stack_frames}\n",
        scope.user_id, scope.role
    );

    let body = json!({
        "from": email_from,
        "to": [email_to],
        "subject": subject,
        "text": text,
    });

    let headers = Headers::new();
    if headers
        .set("Authorization", &format!("Bearer {api_key}"))
        .is_err()
    {
        return;
    }
    if headers.set("Content-Type", "application/json").is_err() {
        return;
    }

    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    init.with_body(Some(JsValue::from_str(&body.to_string())));

    let Ok(request) = Request::new_with_init("https://api.resend.com/emails", &init) else {
        return;
    };
    match Fetch::Request(request).send().await {
        Ok(response) if response.status_code() < 400 => {}
        Ok(response) => {
            worker::console_log!(
                "{}",
                json!({
                    "level": "warn",
                    "event": "client_error_email_failed",
                    "status": response.status_code(),
                    "request_id": request_id,
                    "environment": environment,
                })
            );
        }
        Err(error) => {
            worker::console_log!(
                "{}",
                json!({
                    "level": "warn",
                    "event": "client_error_email_failed",
                    "error": format!("{error:?}"),
                    "request_id": request_id,
                    "environment": environment,
                })
            );
        }
    }
}

async fn client_error(mut request: Request, env: &Env) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    let (request_id, _) = mutation_request_metadata(&request);
    let payload = request
        .json::<Value>()
        .await
        .map_err(|_| api_error(422, "Laporan error tidak valid."))?;
    let error_type = safe_client_error_field(payload.get("name"), 64);
    let source = safe_client_error_field(payload.get("source"), 64);
    let route = safe_client_error_field(payload.get("route"), 200);
    let stack_frames = safe_client_error_field(payload.get("stackFrames"), 1_500);
    worker::console_log!(
        "{}",
        json!({
            "level": "error",
            "event": "frontend_error",
            "request_id": request_id,
            "actor_user_id": scope.user_id,
            "actor_role": scope.role,
            "source": source,
            "error_type": error_type,
            "route": route,
            "stack_frames": stack_frames,
            "environment": env.var("ENVIRONMENT").map(|value| value.to_string()).unwrap_or_else(|_| "unknown".into())
        })
    );
    send_client_error_email(
        env,
        &scope,
        &request_id,
        &source,
        &error_type,
        &route,
        &stack_frames,
    )
    .await;
    Ok(json!({ "accepted": true, "requestId": request_id }))
}

fn log_dynamic_cache(env: &Env, request: &Request, status: &str) {
    let environment = env
        .var("ENVIRONMENT")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "unknown".into());
    let (request_id, _) = mutation_request_metadata(request);
    worker::console_log!(
        "{}",
        json!({
            "level": "info",
            "event": "dynamic_redis_cache",
            "cache_status": status,
            "request_id": request_id,
            "environment": environment,
        })
    );
}

fn api_document_summary(row: &Value) -> ApiResult<Value> {
    let row = row_object(row)?;
    Ok(json!({
        "id": string_value(row.get("id")),
        "data": {
            "nama": string_value(row.get("name")), "nik": string_value(row.get("national_id")),
            "hasNIK": bool_value(row.get("has_national_id")), "tglLahir": date_value(row.get("birth_date")),
            "jk": string_value(row.get("sex")), "namaOrtu": string_value(row.get("parent_name")),
            "desa": string_value(row.get("village")), "posyandu": string_value(row.get("posyandu")),
            "createdAt": timestamp_value(row.get("created_at")), "updatedAt": timestamp_value(row.get("updated_at")),
            "version": row.get("version").cloned().unwrap_or_else(|| json!(1)),
        }
    }))
}

async fn children_page(request: Request, env: &Env) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    let query = query_pairs(&request)?;
    let as_of = first_query(&query, "asOf")
        .map(String::as_str)
        .unwrap_or_default();
    let measurement_start = first_query(&query, "measurementStart")
        .map(String::as_str)
        .unwrap_or_default();
    let measurement_end = first_query(&query, "measurementEnd")
        .map(String::as_str)
        .unwrap_or_default();
    if !is_date(as_of) || !is_date(measurement_start) || !is_date(measurement_end) {
        return Err(api_error(422, "Periode data balita tidak valid."));
    }
    let page = parse_positive(first_query(&query, "page"), 1, 1_000_000)?;
    let size = parse_positive(first_query(&query, "size"), 10, 50)?;
    let view = first_query(&query, "view")
        .map(String::as_str)
        .unwrap_or("data");
    let sort = first_query(&query, "sort")
        .map(String::as_str)
        .unwrap_or("recent");
    let order = match sort {
        "recent" => "created_at.desc,id.desc",
        "oldest_input" => "created_at.asc,id.asc",
        "name_asc" => "name.asc,id.asc",
        "name_desc" => "name.desc,id.asc",
        "age_oldest" => "birth_date.asc.nullslast,id.asc",
        "age_youngest" => "birth_date.desc.nullslast,id.asc",
        _ => return Err(api_error(422, "Urutan data balita tidak valid.")),
    };
    let search = first_query(&query, "search")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    if search.is_some_and(|value| value.chars().count() > 80) {
        return Err(api_error(422, "Kata pencarian terlalu panjang."));
    }
    if matches!(
        view,
        "problem_underweight" | "problem_stunting" | "problem_wasting" | "problem_tidak_naik"
    ) {
        return read_rpc(
            env,
            &scope.user_id,
            "eposyandu_problem_children_page",
            json!({
                "p_month_start": measurement_start,
                "p_month_end": measurement_end,
                "p_problem": view,
                "p_page": page,
                "p_size": size,
                "p_search": search,
                "p_sort": sort,
                "p_village": first_query(&query, "village").map(|value| value.trim()).filter(|value| !value.is_empty()),
                "p_posyandu": first_query(&query, "posyandu").map(|value| value.trim()).filter(|value| !value.is_empty()),
                "p_role": database_scope_role(&scope.role),
                "p_scope_village": scope.desa,
                "p_scope_posyandu": scope.posyandu,
            }),
        )
        .await;
    }
    let replica_payload = json!({
        "p_as_of": as_of,
        "p_measurement_start": measurement_start,
        "p_measurement_end": measurement_end,
        "p_page": page,
        "p_size": size,
        "p_sort": sort,
        "p_view": view,
        "p_search": search,
        "p_village": first_query(&query, "village").map(|value| value.trim()).filter(|value| !value.is_empty()),
        "p_posyandu": first_query(&query, "posyandu").map(|value| value.trim()).filter(|value| !value.is_empty()),
        "p_role": database_scope_role(&scope.role),
        "p_scope_village": scope.desa,
        "p_scope_posyandu": scope.posyandu,
    });
    if let Ok(value) = read_rpc(
        env,
        &scope.user_id,
        "eposyandu_replica_children_page",
        replica_payload,
    )
    .await
    {
        return Ok(value);
    }
    let mut parameters = vec![
        ("select".into(), "id,name,national_id,has_national_id,birth_date,sex,parent_name,village,posyandu,created_at,updated_at,version".into()),
        ("order".into(), order.into()), ("limit".into(), size.to_string()),
        ("offset".into(), ((page - 1) * size).to_string()),
    ];
    match view {
        "data" | "" => {
            let cutoff = add_months(as_of, -60)
                .ok_or_else(|| api_error(422, "Periode data balita tidak valid."))?;
            parameters.push(("deleted_at".into(), "is.null".into()));
            parameters.push(("birth_date".into(), format!("lte.{as_of}")));
            parameters.push(("birth_date".into(), format!("gt.{cutoff}")));
        }
        "recent" => {
            let next = add_months(as_of, 1)
                .ok_or_else(|| api_error(422, "Periode data balita tidak valid."))?;
            parameters.push(("deleted_at".into(), "is.null".into()));
            parameters.push(("created_at".into(), format!("gte.{as_of}T00:00:00Z")));
            parameters.push(("created_at".into(), format!("lt.{next}T00:00:00Z")));
        }
        "recycle" => parameters.push(("deleted_at".into(), "not.is.null".into())),
        "mpasi" => {
            let oldest = add_months(as_of, -24)
                .ok_or_else(|| api_error(422, "Periode data balita tidak valid."))?;
            let youngest = add_months(as_of, -6)
                .ok_or_else(|| api_error(422, "Periode data balita tidak valid."))?;
            parameters.push(("deleted_at".into(), "is.null".into()));
            parameters.push(("birth_date".into(), format!("gt.{oldest}")));
            parameters.push(("birth_date".into(), format!("lte.{youngest}")));
        }
        _ => return Err(api_error(422, "Tampilan data balita tidak valid.")),
    }
    if let Some(search) = search {
        parameters.push((
            "or".into(),
            format!("(name.ilike.*{search}*,national_id.ilike.*{search}*)"),
        ));
    }
    for (query_key, column) in [("village", "village"), ("posyandu", "posyandu")] {
        if let Some(value) = first_query(&query, query_key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            parameters.push((column.into(), format!("eq.{value}")));
        }
    }
    location_parameters(Resource::Children, &scope, &mut parameters)?;
    let (payload, content_range) = rest_json(
        env,
        rest_path("children", &parameters),
        Method::Get,
        None,
        None,
        true,
    )
    .await?;
    let child_rows = rows(payload)?;
    let mut items = Vec::with_capacity(child_rows.len());
    let mut ids = Vec::with_capacity(child_rows.len());
    for row in &child_rows {
        ids.push(string_value(row_object(row)?.get("id")));
        items.push(api_document_summary(row)?);
    }
    if ids.is_empty() {
        return Ok(
            json!({"items": items, "measurements": [], "mpasiLogs": [], "total": count_from_range(content_range)}),
        );
    }
    let in_list = format!("in.({})", ids.join(","));
    if view == "mpasi" {
        let params = vec![
            ("select".into(), "id,legacy_child_id,monitoring_date,breastfeeding,staple_food,legumes,dairy,meat,eggs,vitamin_a_fruit_vegetable,other_fruit_vegetable,nutrition_intervention,created_at,updated_at,version".into()),
            ("legacy_child_id".into(), in_list), ("monitoring_date".into(), format!("gte.{measurement_start}")),
            ("monitoring_date".into(), format!("lte.{measurement_end}")),
            ("order".into(), "legacy_child_id.asc,monitoring_date.desc,created_at.desc".into()), ("limit".into(), "100".into()),
        ];
        let (logs, _) = rest_json(
            env,
            rest_path("mpasi_logs", &params),
            Method::Get,
            None,
            None,
            false,
        )
        .await?;
        let mut latest = BTreeMap::new();
        for row in rows(logs)? {
            let child_id = string_value(row_object(&row)?.get("legacy_child_id"));
            latest
                .entry(child_id)
                .or_insert(api_document(Resource::MpasiLogs, &row, None)?);
        }
        let ordered = ids
            .iter()
            .filter_map(|id| latest.remove(id))
            .collect::<Vec<_>>();
        return Ok(
            json!({"items": items, "measurements": [], "mpasiLogs": ordered, "total": count_from_range(content_range)}),
        );
    }
    let params = vec![
        ("select".into(), "id,legacy_child_id,legacy_child_name,legacy_village,legacy_posyandu,measurement_date,measurement_date_raw,weight_kg,height_cm,head_circumference_cm,mid_upper_arm_circumference_cm,measurement_method,weight_gain_status,created_at,updated_at,version".into()),
        ("legacy_child_id".into(), in_list), ("measurement_date".into(), format!("gte.{measurement_start}")),
        ("measurement_date".into(), format!("lte.{measurement_end}")),
        ("order".into(), "legacy_child_id.asc,measurement_date.desc,created_at.desc".into()), ("limit".into(), "100".into()),
    ];
    let (measurements, _) = rest_json(
        env,
        rest_path("measurements", &params),
        Method::Get,
        None,
        None,
        false,
    )
    .await?;
    let mut latest = BTreeMap::new();
    for row in rows(measurements)? {
        let child_id = string_value(row_object(&row)?.get("legacy_child_id"));
        latest
            .entry(child_id)
            .or_insert(api_document(Resource::Measurements, &row, None)?);
    }
    let ordered = ids
        .iter()
        .filter_map(|id| latest.remove(id))
        .collect::<Vec<_>>();
    Ok(
        json!({"items": items, "measurements": ordered, "mpasiLogs": [], "total": count_from_range(content_range)}),
    )
}

async fn rpc(env: &Env, name: &str, payload: Value) -> ApiResult<Value> {
    let (value, _) = rest_json(
        env,
        format!("rpc/{name}"),
        Method::Post,
        Some(payload),
        None,
        false,
    )
    .await?;
    Ok(value)
}

fn read_replica_config(env: &Env) -> Option<String> {
    let mode = env
        .var("READ_REPLICA_MODE")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "prefer-replica".into());
    if mode == "primary-only" {
        return None;
    }
    if env.service("NEON_READ_SERVICE").is_err()
        && optional_secret(env, "NEON_READ_API_URL").is_none()
    {
        return None;
    }
    optional_secret(env, "READ_REPLICA_SHARED_SECRET")
}

async fn replica_rpc(env: &Env, name: &str, payload: Value) -> ApiResult<Value> {
    let shared_secret = read_replica_config(env)
        .ok_or_else(|| api_error(503, "Read replica belum dikonfigurasi."))?;
    let headers = Headers::new();
    headers
        .set("Content-Type", "application/json")
        .map_err(|_| api_error(503, "Read replica belum dapat dihubungi."))?;
    headers
        .set("Accept", "application/json")
        .map_err(|_| api_error(503, "Read replica belum dapat dihubungi."))?;
    headers
        .set("X-EPosyandu-Replica-Secret", &shared_secret)
        .map_err(|_| api_error(503, "Read replica belum dapat dihubungi."))?;
    let encoded = serde_json::to_string(&json!({
        "operation": name,
        "payload": payload,
    }))
    .map_err(|_| api_error(422, "Parameter baca tidak valid."))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&encoded)));
    let mut response = if let Ok(service) = env.service("NEON_READ_SERVICE") {
        service
            .fetch("https://neon-read.internal/v1/read", Some(init))
            .await
            .map_err(|_| api_error(503, "Read replica belum dapat dihubungi."))?
    } else {
        let base_url = optional_secret(env, "NEON_READ_API_URL")
            .ok_or_else(|| api_error(503, "Read replica belum dikonfigurasi."))?;
        let endpoint = format!("{}/v1/read", base_url.trim_end_matches('/'));
        let request = Request::new_with_init(&endpoint, &init)
            .map_err(|_| api_error(503, "Read replica belum dapat dihubungi."))?;
        Fetch::Request(request)
            .send()
            .await
            .map_err(|_| api_error(503, "Read replica belum dapat dihubungi."))?
    };
    if !(200..300).contains(&response.status_code()) {
        return Err(api_error(
            503,
            "Read replica belum dapat melayani permintaan.",
        ));
    }
    let envelope = response
        .json::<Value>()
        .await
        .map_err(|_| api_error(503, "Respons read replica tidak valid."))?;
    envelope
        .get("data")
        .cloned()
        .ok_or_else(|| api_error(503, "Respons read replica tidak valid."))
}

async fn read_rpc(env: &Env, user_id: &str, name: &str, payload: Value) -> ApiResult<Value> {
    if read_replica_config(env).is_some() && !replica_reads_pinned_to_primary(env, user_id).await {
        match replica_rpc(env, name, payload.clone()).await {
            Ok(value) => {
                worker::console_log!(
                    "{}",
                    json!({
                        "level": "info",
                        "event": "read_router",
                        "operation": name,
                        "source": "neon",
                    })
                );
                return Ok(value);
            }
            Err(_) => worker::console_warn!(
                "{}",
                json!({
                    "level": "warn",
                    "event": "read_router_fallback",
                    "operation": name,
                    "source": "supabase",
                })
            ),
        }
    }
    rpc(env, name, payload).await
}

async fn exclusive_breastfeeding_page(request: Request, env: &Env) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    let query = query_pairs(&request)?;
    let start = first_query(&query, "measurementStart")
        .map(String::as_str)
        .unwrap_or_default();
    let end = first_query(&query, "measurementEnd")
        .map(String::as_str)
        .unwrap_or_default();
    let age_group = first_query(&query, "ageGroup")
        .map(String::as_str)
        .unwrap_or_default();
    if !is_date(start) || !is_date(end) || !matches!(age_group, "0-5" | "6") {
        return Err(api_error(422, "Parameter ASI eksklusif tidak valid."));
    }
    let page = parse_positive(first_query(&query, "page"), 1, 1_000_000)?;
    let size = parse_positive(first_query(&query, "size"), 10, 50)?;
    read_rpc(env, &scope.user_id, "eposyandu_exclusive_breastfeeding_page", json!({
        "p_measurement_start": start, "p_measurement_end": end, "p_age_group": age_group,
        "p_page": page, "p_size": size,
        "p_village": first_query(&query, "village").map(|value| value.trim()).filter(|value| !value.is_empty()),
        "p_posyandu": first_query(&query, "posyandu").map(|value| value.trim()).filter(|value| !value.is_empty()),
        "p_role": database_scope_role(&scope.role), "p_scope_village": scope.desa, "p_scope_posyandu": scope.posyandu,
    })).await
}

async fn dashboard(request: Request, env: &Env) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    let query = query_pairs(&request)?;
    let required = [
        "monthStart",
        "monthEnd",
        "previousMonthStart",
        "previousMonthEnd",
    ];
    if required.iter().any(|key| {
        !is_date(
            first_query(&query, key)
                .map(String::as_str)
                .unwrap_or_default(),
        )
    }) {
        return Err(api_error(422, "Periode dashboard tidak valid."));
    }
    // The dashboard must agree with writes immediately. Other read-heavy
    // pages may use Neon, but these aggregate counters stay on Supabase.
    rpc(env, "eposyandu_dashboard_stats", json!({
        "p_month_start": first_query(&query, "monthStart"), "p_month_end": first_query(&query, "monthEnd"),
        "p_previous_month_start": first_query(&query, "previousMonthStart"), "p_previous_month_end": first_query(&query, "previousMonthEnd"),
        "p_village": first_query(&query, "village").map(|value| value.trim()).filter(|value| !value.is_empty()),
        "p_posyandu": first_query(&query, "posyandu").map(|value| value.trim()).filter(|value| !value.is_empty()),
        "p_role": database_scope_role(&scope.role), "p_scope_village": scope.desa, "p_scope_posyandu": scope.posyandu,
    })).await
}

async fn sigizi_measurement_export(request: Request, env: &Env) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    let (request_id, _) = mutation_request_metadata(&request);
    let query = query_pairs(&request)?;
    let month_start = first_query(&query, "monthStart")
        .map(String::as_str)
        .unwrap_or_default();
    let month_end = first_query(&query, "monthEnd")
        .map(String::as_str)
        .unwrap_or_default();
    if !is_date(month_start) || !is_date(month_end) {
        return Err(api_error(422, "Periode ekspor pengukuran tidak valid."));
    }
    let village = first_query(&query, "village")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let posyandu = first_query(&query, "posyandu")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let value = read_rpc(
        env,
        &scope.user_id,
        "eposyandu_sigizi_measurement_export",
        json!({
            "p_month_start": month_start,
            "p_month_end": month_end,
            "p_village": village,
            "p_posyandu": posyandu,
            "p_role": database_scope_role(&scope.role),
            "p_scope_village": scope.desa,
            "p_scope_posyandu": scope.posyandu,
        }),
    )
    .await?;
    let export_id = hashed_key(
        "sigizi-export",
        &format!(
            "{month_start}:{month_end}:{}:{}",
            village.unwrap_or_default(),
            posyandu.unwrap_or_default()
        ),
    );
    if record_operational_audit(
        env,
        &scope.user_id,
        &scope.role,
        scope.desa.as_deref(),
        scope.posyandu.as_deref(),
        &request_id,
        None,
        "export",
        "sigizi_measurement_export",
        &export_id,
        None,
        None,
        json!({
            "format": "xls",
            "month_start": month_start,
            "month_end": month_end,
            "village_filter": village,
            "posyandu_filter": posyandu,
            "row_count": value.as_array().map(Vec::len).unwrap_or_default(),
        }),
    )
    .await
    .is_err()
    {
        worker::console_log!(
            "{}",
            json!({
                "level": "warn",
                "event": "audit_write_failed",
                "request_id": request_id,
                "action": "export",
                "resource": "sigizi_measurement_export"
            })
        );
    }
    Ok(value)
}

fn collection_filters(
    resource: Resource,
    query: &BTreeMap<String, Vec<String>>,
    scope: &AccessScope,
) -> ApiResult<Vec<(String, String)>> {
    let mut parameters = vec![("select".into(), resource.select().into())];
    let since = first_query(query, "since")
        .map(String::as_str)
        .unwrap_or_default();
    if !since.is_empty() {
        if !since.contains('T') {
            return Err(api_error(422, "Cursor sinkronisasi tidak valid."));
        }
        parameters.push((resource.sync_column().into(), format!("gt.{since}")));
    } else {
        for value in query.get("filter").into_iter().flatten() {
            let mut parts = value.splitn(3, '|');
            let field = parts.next().unwrap_or_default();
            let operator = parts.next().unwrap_or_default();
            let value = parts.next().unwrap_or_default();
            let column = filter_column(resource, field).ok_or_else(|| {
                api_error(422, format!("Filter atau urutan {field} tidak didukung."))
            })?;
            let operator = match operator {
                "==" => "eq",
                ">=" => "gte",
                "<=" => "lte",
                _ => return Err(api_error(422, "Format filter tidak valid.")),
            };
            parameters.push((column.into(), format!("{operator}.{value}")));
        }
    }
    let mut orders = Vec::new();
    for value in query.get("order").into_iter().flatten() {
        let mut parts = value.splitn(2, '|');
        let field = parts.next().unwrap_or_default();
        let direction = parts.next().unwrap_or_default();
        let column = filter_column(resource, field)
            .ok_or_else(|| api_error(422, format!("Filter atau urutan {field} tidak didukung.")))?;
        if !matches!(direction, "asc" | "desc") || column.contains('.') {
            return Err(api_error(
                422,
                format!("Filter atau urutan {field} tidak didukung."),
            ));
        }
        orders.push(format!("{column}.{direction}"));
    }
    if !orders.is_empty() {
        parameters.push(("order".into(), orders.join(",")));
    }
    location_parameters(resource, scope, &mut parameters)?;
    Ok(parameters)
}

async fn enrichment(
    resource: Resource,
    source_rows: &[Value],
    env: &Env,
) -> ApiResult<BTreeMap<String, Value>> {
    if source_rows.is_empty() || !matches!(resource, Resource::PmtPrograms | Resource::ChangeLogs) {
        return Ok(BTreeMap::new());
    }
    let ids = source_rows
        .iter()
        .map(row_object)
        .collect::<ApiResult<Vec<_>>>()?
        .iter()
        .map(|row| string_value(row.get("id")))
        .collect::<Vec<_>>();
    let table = if resource == Resource::PmtPrograms {
        "pmt_monitorings"
    } else {
        "change_log_entries"
    };
    let mut enrichment_rows = Vec::new();
    // Keep PostgREST URLs comfortably below proxy limits when a collection has
    // many related records. This is especially important for change history.
    for id_chunk in ids.chunks(75) {
        let params = match resource {
            Resource::PmtPrograms => vec![
                ("select".into(), "program_id,week_number,monitoring_date,weight_kg,height_cm,measurement_method,consumed_days,health_monitoring,follow_up".into()),
                ("program_id".into(), format!("in.({})", id_chunk.join(","))), ("order".into(), "week_number.asc".into()),
            ],
            Resource::ChangeLogs => vec![
                ("select".into(), "change_log_id,field_name,old_value,new_value".into()),
                ("change_log_id".into(), format!("in.({})", id_chunk.join(","))), ("order".into(), "id.asc".into()),
            ],
            _ => vec![],
        };
        let (payload, _) = rest_json(
            env,
            rest_path(table, &params),
            Method::Get,
            None,
            None,
            false,
        )
        .await?;
        enrichment_rows.extend(rows(payload)?);
    }
    let mut output = BTreeMap::<String, Value>::new();
    for row in enrichment_rows {
        let row = row_object(&row)?;
        if resource == Resource::PmtPrograms {
            let program_id = string_value(row.get("program_id"));
            let week = string_value(row.get("week_number"));
            let entry = json!({
                "tgl": date_value(row.get("monitoring_date")), "bb": number_or_null(row.get("weight_kg")),
                "tb": number_or_null(row.get("height_cm")), "caraUkur": string_value(row.get("measurement_method")),
                "days": row.get("consumed_days").cloned().unwrap_or_else(|| json!([false,false,false,false,false,false,false])),
                "pemantauanKesehatan": string_value(row.get("health_monitoring")), "tindakLanjut": string_value(row.get("follow_up")),
            });
            output
                .entry(program_id)
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .unwrap()
                .insert(week, entry);
        } else {
            let log_id = string_value(row.get("change_log_id"));
            output.entry(log_id).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!({
                "field": string_value(row.get("field_name")), "oldValue": nullable_value(row.get("old_value")), "newValue": nullable_value(row.get("new_value")),
            }));
        }
    }
    if resource == Resource::ChangeLogs {
        recover_missing_change_details(source_rows, &mut output, env).await;
    }
    Ok(output)
}

async fn recover_missing_change_details(
    source_rows: &[Value],
    output: &mut BTreeMap<String, Value>,
    env: &Env,
) {
    let missing_logs = source_rows
        .iter()
        .filter_map(|source| row_object(source).ok())
        .filter_map(|row| {
            let log_id = string_value(row.get("id"));
            if log_id.is_empty() || output.contains_key(&log_id) {
                return None;
            }
            let child_id = preferred_value(row, "child_id", "legacy_child_id");
            let changed_at = string_value(row.get("changed_at"));
            (!child_id.is_empty() && !changed_at.is_empty())
                .then_some((log_id, child_id, changed_at))
        })
        .collect::<Vec<_>>();
    if missing_logs.is_empty() {
        return;
    }

    let mut child_ids = missing_logs
        .iter()
        .map(|(_, child_id, _)| child_id.clone())
        .collect::<Vec<_>>();
    child_ids.sort();
    child_ids.dedup();
    let parameters = vec![
        (
            "select".into(),
            "id,document_id,before_data,after_data,created_at".into(),
        ),
        ("resource".into(), "eq.children".into()),
        ("action".into(), "eq.update".into()),
        (
            "document_id".into(),
            format!("in.({})", child_ids.join(",")),
        ),
        ("order".into(), "created_at.asc".into()),
        ("limit".into(), "1000".into()),
    ];
    let Ok((payload, _)) = rest_json(
        env,
        rest_path("audit_events", &parameters),
        Method::Get,
        None,
        None,
        false,
    )
    .await
    else {
        return;
    };
    let Ok(audit_rows) = rows(payload) else {
        return;
    };

    for (log_id, child_id, changed_at) in missing_logs {
        let changed_at_ms = worker::js_sys::Date::parse(&changed_at);
        if !changed_at_ms.is_finite() {
            continue;
        }
        let nearest = audit_rows
            .iter()
            .filter_map(|audit| row_object(audit).ok())
            .filter(|audit| string_value(audit.get("document_id")) == child_id)
            .filter_map(|audit| {
                let audit_time =
                    worker::js_sys::Date::parse(&string_value(audit.get("created_at")));
                let distance = (audit_time - changed_at_ms).abs();
                (audit_time.is_finite() && distance <= CHANGE_AUDIT_MAX_DISTANCE_MS)
                    .then_some((audit, distance))
            })
            .min_by(|left, right| left.1.total_cmp(&right.1))
            .map(|(audit, _)| audit);
        let Some(audit) = nearest else {
            continue;
        };
        let changes = identity_changes(audit.get("before_data"), audit.get("after_data"));
        if !changes.is_empty() {
            output.insert(log_id, Value::Array(changes));
        }
    }
}

async fn collection_list(request: Request, env: &Env, resource: Resource) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    let (request_id, _) = mutation_request_metadata(&request);
    let query = query_pairs(&request)?;
    let mut parameters = collection_filters(resource, &query, &scope)?;
    let export_request = first_query(&query, "export").is_some_and(|value| value == "1");
    let history_page = if resource == Resource::ChangeLogs
        && !export_request
        && first_query(&query, "page").is_some()
    {
        let page = parse_positive(first_query(&query, "page"), 1, 1_000_000)?;
        let size = parse_positive(first_query(&query, "size"), 10, 50)?;
        parameters.push(("limit".into(), size.to_string()));
        parameters.push(("offset".into(), ((page - 1) * size).to_string()));
        Some((page, size))
    } else {
        None
    };
    let export_size = if export_request {
        let page = parse_positive(first_query(&query, "page"), 1, 1_000_000)?;
        let size = parse_positive(first_query(&query, "size"), 500, 500)?;
        parameters.push(("limit".into(), size.to_string()));
        parameters.push(("offset".into(), ((page - 1) * size).to_string()));
        size
    } else {
        0
    };
    let (payload, content_range) = rest_json(
        env,
        rest_path(resource.name(), &parameters),
        Method::Get,
        None,
        None,
        history_page.is_some(),
    )
    .await?;
    let result_rows = rows(payload)?;
    let extras = enrichment(resource, &result_rows, env).await?;
    let mut items = Vec::with_capacity(result_rows.len());
    for row in &result_rows {
        let id = string_value(row_object(row)?.get("id"));
        items.push(api_document(resource, row, extras.get(&id).cloned())?);
    }
    let mut deleted_ids = Vec::<String>::new();
    if let Some(since) = first_query(&query, "since") {
        let mut parameters = vec![
            ("select".into(), "document_id".into()),
            ("resource".into(), format!("eq.{}", resource.name())),
            ("deleted_at".into(), format!("gt.{since}")),
        ];
        location_parameters(Resource::Children, &scope, &mut parameters)?;
        let (tombstones, _) = rest_json(
            env,
            rest_path("sync_tombstones", &parameters),
            Method::Get,
            None,
            None,
            false,
        )
        .await?;
        for row in rows(tombstones)? {
            deleted_ids.push(string_value(row_object(&row)?.get("document_id")));
        }
    }
    if export_request {
        let export_id = hashed_key("collection-export", &request_id);
        if record_operational_audit(
            env,
            &scope.user_id,
            &scope.role,
            scope.desa.as_deref(),
            scope.posyandu.as_deref(),
            &request_id,
            None,
            "export",
            resource.name(),
            &export_id,
            None,
            None,
            json!({
                "format": "spreadsheet",
                "row_count": result_rows.len(),
                "page_size": export_size,
            }),
        )
        .await
        .is_err()
        {
            worker::console_log!(
                "{}",
                json!({
                    "level": "warn",
                    "event": "audit_write_failed",
                    "request_id": request_id,
                    "action": "export",
                    "resource": resource.name()
                })
            );
        }
    }
    Ok(json!({
        "items": items,
        "deletedIds": deleted_ids,
        "cursor": now_iso(),
        "hasMore": export_request && result_rows.len() == export_size,
        "page": history_page.map(|(page, _)| page),
        "size": history_page.map(|(_, size)| size),
        "total": history_page.map(|_| count_from_range(content_range)),
    }))
}

async fn fetch_raw_document(
    resource: Resource,
    id: &str,
    scope: &AccessScope,
    env: &Env,
) -> ApiResult<Option<Value>> {
    let mut parameters = vec![
        ("select".into(), resource.select().into()),
        ("id".into(), format!("eq.{id}")),
        ("limit".into(), "1".into()),
    ];
    location_parameters(resource, scope, &mut parameters)?;
    let (payload, _) = rest_json(
        env,
        rest_path(resource.name(), &parameters),
        Method::Get,
        None,
        None,
        false,
    )
    .await?;
    Ok(rows(payload)?.into_iter().next())
}

async fn collection_get(
    request: Request,
    env: &Env,
    resource: Resource,
    id: &str,
) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    let row = fetch_raw_document(resource, id, &scope, env)
        .await?
        .ok_or_else(|| api_error(404, "Data tidak ditemukan."))?;
    let extras = enrichment(resource, std::slice::from_ref(&row), env).await?;
    api_document(resource, &row, extras.get(id).cloned())
}

fn input_text(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key)
        .map(|value| Value::String(sanitize_text(&string_value(Some(value)))))
}

fn input_nullable(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).map(|value| {
        let sanitized = sanitize_text(&string_value(Some(value)));
        if value.is_null() || sanitized.trim().is_empty() {
            Value::Null
        } else {
            Value::String(sanitized)
        }
    })
}

fn input_bool(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key)
        .map(|value| Value::Bool(bool_value(Some(value))))
}

fn input_number(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key)
        .map(|value| number_value(Some(value)).map_or(Value::Null, |value| json!(value)))
}

fn input_integer(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).map(|value| {
        number_value(Some(value))
            .filter(|value| {
                value.is_finite()
                    && value.fract() == 0.0
                    && *value >= i16::MIN as f64
                    && *value <= i16::MAX as f64
            })
            .map_or(Value::Null, |value| json!(value as i64))
    })
}

fn input_weight(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key)
        .map(|value| normalized_weight(value).map_or(Value::Null, |value| json!(value)))
}

fn normalized_weight(value: &Value) -> Option<f64> {
    number_value(Some(value)).map(|value| {
        if value.abs() >= 1000.0 {
            value / 1000.0
        } else {
            value
        }
    })
}

fn input_date(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).map(|value| date_value(Some(value)))
}

fn copy_value(target: &mut Map<String, Value>, column: &str, value: Option<Value>) {
    if let Some(value) = value {
        target.insert(column.into(), value);
    }
}

fn validate_weight(
    data: &Map<String, Value>,
    key: &str,
    label: &str,
    maximum: f64,
) -> ApiResult<()> {
    let Some(value) = data.get(key) else {
        return Ok(());
    };
    if value.is_null() || string_value(Some(value)).trim().is_empty() {
        return Ok(());
    }
    let Some(value) = normalized_weight(value) else {
        return Err(api_error(
            422,
            format!(
                "{label} harus diisi dalam kilogram antara 0,1 sampai {maximum} kg (contoh: 3,2), bukan gram seperti 3200."
            ),
        ));
    };
    if !(0.1..=maximum).contains(&value) {
        return Err(api_error(
            422,
            format!(
                "{label} harus diisi dalam kilogram antara 0,1 sampai {maximum} kg (contoh: 3,2), bukan gram seperti 3200."
            ),
        ));
    }
    Ok(())
}

fn validate_integer(
    data: &Map<String, Value>,
    key: &str,
    label: &str,
    minimum: i16,
    maximum: i16,
) -> ApiResult<()> {
    let Some(value) = data.get(key) else {
        return Ok(());
    };
    if value.is_null() || string_value(Some(value)).trim().is_empty() {
        return Ok(());
    }
    let Some(value) = number_value(Some(value)) else {
        return Err(api_error(
            422,
            format!("{label} harus berupa angka bulat antara {minimum} sampai {maximum}."),
        ));
    };
    if !value.is_finite()
        || value.fract() != 0.0
        || value < minimum as f64
        || value > maximum as f64
    {
        return Err(api_error(
            422,
            format!("{label} harus berupa angka bulat antara {minimum} sampai {maximum}."),
        ));
    }
    Ok(())
}

fn required(data: &Map<String, Value>, keys: &[&str]) -> ApiResult<()> {
    for key in keys {
        if string_value(data.get(*key)).trim().is_empty() {
            return Err(api_error(422, format!("Kolom {key} wajib diisi.")));
        }
    }
    Ok(())
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

fn validate_text(
    data: &Map<String, Value>,
    key: &str,
    label: &str,
    maximum: usize,
) -> ApiResult<()> {
    let Some(value) = data.get(key) else {
        return Ok(());
    };
    if !value.is_string() && !value.is_number() && !value.is_boolean() && !value.is_null() {
        return Err(api_error(422, format!("{label} harus berupa teks.")));
    }
    let value = string_value(Some(value));
    if value.chars().any(is_forbidden_text_character) {
        return Err(api_error(
            422,
            format!("{label} mengandung karakter kontrol yang tidak diizinkan."),
        ));
    }
    if value.chars().count() > maximum {
        return Err(api_error(
            422,
            format!("{label} maksimal {maximum} karakter."),
        ));
    }
    Ok(())
}

fn validate_resource_text(resource: Resource, data: &Map<String, Value>) -> ApiResult<()> {
    let fields: &[(&str, &str, usize)] = match resource {
        Resource::Children => &[
            ("nama", "Nama balita", 120),
            ("tglLahir", "Tanggal lahir", 32),
            ("jk", "Jenis kelamin", 8),
            ("noKK", "Nomor KK", 32),
            ("nik", "NIK balita", 32),
            ("namaOrtu", "Nama orang tua", 120),
            ("nikOrtu", "NIK orang tua", 32),
            ("noHpOrtu", "Nomor HP orang tua", 32),
            ("alamat", "Alamat", 500),
            ("rt", "RT", 8),
            ("rw", "RW", 8),
            ("desa", "Desa", 120),
            ("posyandu", "Posyandu", 120),
            ("createdBy", "Pembuat data", 80),
            ("deleteReason", "Alasan penghapusan", 500),
            ("deathCause", "Penyebab kematian", 500),
            ("deathLocation", "Lokasi kematian", 200),
        ],
        Resource::Measurements => &[
            ("childId", "ID balita", 128),
            ("childName", "Nama balita", 120),
            ("tglUkur", "Tanggal ukur", 32),
            ("desa", "Desa", 120),
            ("posyandu", "Posyandu", 120),
            ("edema", "Edema", 32),
            ("kelasIbu", "Kelas ibu", 32),
            ("mbg", "MBG", 32),
            ("vitA", "Vitamin A", 32),
            ("asi", "ASI eksklusif", 32),
            ("caraUkur", "Cara ukur", 32),
            ("statusNaik", "Status kenaikan", 8),
        ],
        Resource::MpasiLogs => &[
            ("childId", "ID balita", 128),
            ("childName", "Nama balita", 120),
            ("tglMonitoring", "Tanggal monitoring", 32),
            ("asi", "ASI", 32),
            ("intervensiGizi", "Intervensi gizi", 32),
        ],
        Resource::PmtPrograms => &[
            ("childId", "ID balita", 128),
            ("childName", "Nama balita", 120),
            ("category", "Kategori PMT", 32),
            ("jenisPmt", "Jenis PMT", 32),
            ("sumberAnggaran", "Sumber anggaran", 120),
            ("pmtSesuaiJuknis", "Kesesuaian juknis", 32),
            ("status", "Status PMT", 32),
            ("mitra", "Mitra", 120),
            ("mitraLain", "Mitra lain", 200),
            ("tglPemberian", "Tanggal pemberian", 32),
            ("initialMeasurementDate", "Tanggal ukur awal", 32),
        ],
        Resource::ChangeLogs => &[
            ("childId", "ID balita", 128),
            ("childName", "Nama balita", 120),
            ("changedBy", "Pengubah data", 80),
        ],
    };
    for (key, label, maximum) in fields {
        validate_text(data, key, label, *maximum)?;
    }
    Ok(())
}

fn validate_collection_payload_size(payload: &Value) -> ApiResult<()> {
    let size = serde_json::to_vec(payload)
        .map_err(|_| api_error(422, "Data dokumen tidak valid."))?
        .len();
    if size > COLLECTION_MUTATION_MAX_BODY_BYTES {
        return Err(api_error(413, "Data dokumen melebihi batas 256 KB."));
    }
    Ok(())
}

fn is_sixteen_digits(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn deterministic_digits(seed: &str, length: usize) -> String {
    hashed_key("temporary-identity", seed)
        .rsplit(':')
        .next()
        .unwrap_or_default()
        .chars()
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

fn normalize_child_identity(data: &mut Map<String, Value>, id: &str) -> ApiResult<()> {
    let has_family_card = bool_value(data.get("hasKK"));
    let family_card_number = string_value(data.get("noKK"));
    if has_family_card && !is_sixteen_digits(&family_card_number) {
        return Err(api_error(422, "No. KK harus berisi 16 digit."));
    }
    if !has_family_card && !is_sixteen_digits(&family_card_number) {
        data.insert(
            "noKK".into(),
            Value::String(format!(
                "350904{}",
                deterministic_digits(&format!("family-card:{id}"), 10)
            )),
        );
    }

    let has_national_id = bool_value(data.get("hasNIK"));
    let national_id = string_value(data.get("nik"));
    if has_national_id && !is_sixteen_digits(&national_id) {
        return Err(api_error(422, "NIK balita harus berisi 16 digit."));
    }
    if !has_national_id && !is_sixteen_digits(&national_id) {
        data.insert(
            "nik".into(),
            Value::String(format!(
                "350904{}{}",
                temporary_birth_segment(data, id),
                deterministic_digits(&format!("national-id:{id}"), 4)
            )),
        );
    }
    Ok(())
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
                copy_value(&mut output, column, input_text(data, key));
            }
            for (key, column) in [
                ("hasKK", "has_family_card"),
                ("hasNIK", "has_national_id"),
                ("bukuKIA", "has_maternal_child_book"),
                ("bukuKIAKecil", "has_small_baby_book"),
                ("imd", "early_breastfeeding_initiation"),
            ] {
                copy_value(&mut output, column, input_bool(data, key));
            }
            for (key, column) in [
                ("anakKe", "child_order"),
                ("usiaKehamilan", "gestational_age_weeks"),
            ] {
                copy_value(&mut output, column, input_integer(data, key));
            }
            for (key, column) in [
                ("pbLahir", "birth_length_cm"),
                ("lkLahir", "birth_head_circumference_cm"),
                ("currentTB", "current_height_cm"),
                ("currentLILA", "current_mid_upper_arm_circumference_cm"),
                ("currentLK", "current_head_circumference_cm"),
            ] {
                copy_value(&mut output, column, input_number(data, key));
            }
            for (key, column) in [
                ("bbLahir", "birth_weight_kg"),
                ("currentBB", "current_weight_kg"),
            ] {
                copy_value(&mut output, column, input_weight(data, key));
            }
            for (key, column) in [
                ("lastMeasurementDate", "last_measurement_date"),
                ("deathDate", "death_date"),
            ] {
                copy_value(&mut output, column, input_date(data, key));
            }
            if let Some(value) = data.get("tglLahir") {
                let raw_birth_date = sanitize_text(&string_value(Some(value)));
                output.insert("birth_date_raw".into(), Value::String(raw_birth_date));
                output.insert("birth_date".into(), date_value(Some(value)));
            }
            copy_value(
                &mut output,
                "deleted_at",
                data.get("deletedAt")
                    .map(|value| timestamp_value(Some(value))),
            );
            copy_value(
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
                copy_value(&mut output, column, input_text(data, key));
            }
            copy_value(&mut output, "weight_kg", input_weight(data, "bb"));
            for (key, column) in [
                ("tb", "height_cm"),
                ("lk", "head_circumference_cm"),
                ("lila", "mid_upper_arm_circumference_cm"),
            ] {
                copy_value(&mut output, column, input_number(data, key));
            }
            copy_value(
                &mut output,
                "age_in_months",
                input_integer(data, "ageInMonths"),
            );
            if let Some(value) = data.get("tglUkur") {
                let raw_measurement_date = sanitize_text(&string_value(Some(value)));
                output.insert(
                    "measurement_date_raw".into(),
                    Value::String(raw_measurement_date),
                );
                output.insert("measurement_date".into(), date_value(Some(value)));
            }
            copy_value(
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
                copy_value(&mut output, column, input_text(data, key));
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
                copy_value(&mut output, column, input_bool(data, key));
            }
            copy_value(
                &mut output,
                "monitoring_date",
                input_date(data, "tglMonitoring"),
            );
            copy_value(
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
                copy_value(&mut output, column, input_text(data, key));
            }
            for (key, column) in [("mitra", "partner"), ("mitraLain", "other_partner")] {
                copy_value(&mut output, column, input_nullable(data, key));
            }
            copy_value(&mut output, "cycle_number", input_integer(data, "siklusKe"));
            copy_value(
                &mut output,
                "distribution_date",
                input_date(data, "tglPemberian"),
            );
            copy_value(
                &mut output,
                "initial_measurement_date",
                input_date(data, "initialMeasurementDate"),
            );
            copy_value(
                &mut output,
                "initial_weight_kg",
                input_weight(data, "initialBB"),
            );
            copy_value(
                &mut output,
                "initial_height_cm",
                input_number(data, "initialTB"),
            );
            copy_value(
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
                copy_value(&mut output, column, input_text(data, key));
            }
            copy_value(
                &mut output,
                "changed_at",
                data.get("timestamp")
                    .map(|value| timestamp_value(Some(value))),
            );
        }
    }
    output
}

async fn child_for_write(
    env: &Env,
    id: &str,
    scope: &AccessScope,
) -> ApiResult<(String, String, String)> {
    let row = fetch_raw_document(Resource::Children, id, scope, env)
        .await?
        .ok_or_else(|| api_error(422, "Data balita tidak ditemukan."))?;
    let row = row_object(&row)?;
    Ok((
        string_value(row.get("id")),
        string_value(row.get("name")),
        string_value(row.get("village")),
    ))
    .and_then(|(id, name, village)| {
        let posyandu = string_value(row.get("posyandu"));
        assert_location(scope, &village, &posyandu)?;
        Ok((id, name, format!("{village}\u{1f}{posyandu}")))
    })
}

fn child_location_parts(value: String) -> (String, String) {
    let mut parts = value.splitn(2, '\u{1f}');
    (
        parts.next().unwrap_or_default().into(),
        parts.next().unwrap_or_default().into(),
    )
}

fn scoped_candidate(scope: &AccessScope, data: &Map<String, Value>) -> ApiResult<()> {
    assert_location(
        scope,
        &string_value(data.get("desa")),
        &string_value(data.get("posyandu")),
    )
}

async fn write_monitorings(
    env: &Env,
    program_id: &str,
    data: &Map<String, Value>,
) -> ApiResult<()> {
    let Some(monitorings) = data.get("monitorings").and_then(Value::as_object) else {
        return Ok(());
    };
    for (week, value) in monitorings {
        let Ok(week_number) = week.parse::<i32>() else {
            continue;
        };
        if week_number < 1 {
            continue;
        }
        let Some(value) = value.as_object() else {
            continue;
        };
        let mut days = value
            .get("days")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|value| Value::Bool(bool_value(Some(&value))))
            .collect::<Vec<_>>();
        days.resize(7, Value::Bool(false));
        let health_monitoring = string_value(value.get("pemantauanKesehatan"));
        let follow_up = string_value(value.get("tindakLanjut"));
        let body = json!({
            "program_id": program_id, "week_number": week_number, "monitoring_date": input_date(value, "tgl").unwrap_or(Value::Null),
            "weight_kg": input_weight(value, "bb").unwrap_or(Value::Null), "height_cm": input_number(value, "tb").unwrap_or(Value::Null),
            "measurement_method": string_value(value.get("caraUkur")), "consumed_days": days,
            "health_monitoring": if health_monitoring.is_empty() { "Ada" } else { health_monitoring.as_str() },
            "follow_up": if follow_up.is_empty() { "Dilanjutkan" } else { follow_up.as_str() },
            "updated_at": now_iso(),
        });
        rest_json(
            env,
            "pmt_monitorings?on_conflict=program_id,week_number".into(),
            Method::Post,
            Some(body),
            Some("resolution=merge-duplicates,return=minimal"),
            false,
        )
        .await?;
    }
    Ok(())
}

async fn write_change_entries(env: &Env, log_id: &str, data: &Map<String, Value>) -> ApiResult<()> {
    let changes = change_entries_from_payload(data);
    if changes.is_empty() {
        return Err(api_error(422, "Rincian perubahan identitas wajib diisi."));
    }
    rest_json(
        env,
        format!("change_log_entries?change_log_id=eq.{log_id}"),
        Method::Delete,
        None,
        Some("return=minimal"),
        false,
    )
    .await?;
    let entries = changes
        .iter()
        .filter_map(Value::as_object)
        .map(|change| json!({
            "change_log_id": log_id, "field_name": string_value(change.get("field")),
            "old_value": change.get("oldValue").cloned().unwrap_or(Value::Null), "new_value": change.get("newValue").cloned().unwrap_or(Value::Null),
        }))
        .collect::<Vec<_>>();
    rest_json(
        env,
        "change_log_entries".into(),
        Method::Post,
        Some(Value::Array(entries)),
        Some("return=minimal"),
        false,
    )
    .await?;
    Ok(())
}

async fn clear_tombstone(env: &Env, resource: Resource, id: &str) -> ApiResult<()> {
    rest_json(
        env,
        format!(
            "sync_tombstones?resource=eq.{}&document_id=eq.{id}",
            resource.name()
        ),
        Method::Delete,
        None,
        Some("return=minimal"),
        false,
    )
    .await?;
    Ok(())
}

async fn collection_create(
    mut request: Request,
    env: &Env,
    resource: Resource,
) -> ApiResult<Value> {
    validate_idempotency_key(&request)?;
    let (request_id, idempotency_key) = mutation_request_metadata(&request);
    let scope = require_scope(&request, env).await?;
    let payload = request
        .json::<Value>()
        .await
        .map_err(|_| api_error(422, "Data dokumen tidak valid."))?;
    validate_collection_payload_size(&payload)?;
    let id = string_value(payload.get("id"));
    let mut data = payload
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| api_error(422, "ID dan data dokumen wajib diisi."))?;
    if id.trim().is_empty() {
        return Err(api_error(422, "ID dan data dokumen wajib diisi."));
    }
    validate_resource_text(resource, &data)?;
    match resource {
        Resource::Children => {
            required(&data, &["nama", "tglLahir", "jk", "desa", "posyandu"])?;
            scoped_candidate(&scope, &data)?;
            normalize_child_identity(&mut data, &id)?;
            validate_integer(&data, "anakKe", "Anak ke-", 1, i16::MAX)?;
            validate_integer(&data, "usiaKehamilan", "Usia kehamilan", 1, 50)?;
            validate_weight(&data, "bbLahir", "Berat lahir", 10.0)?;
            validate_weight(&data, "currentBB", "Berat badan", 60.0)?;
            data.insert("createdBy".into(), Value::String(scope.role.clone()));
        }
        Resource::Measurements => {
            required(&data, &["childId", "tglUkur"])?;
            validate_integer(&data, "ageInMonths", "Usia balita", 0, i16::MAX)?;
            validate_weight(&data, "bb", "Berat badan", 60.0)?;
            let (child_id, child_name, location) =
                child_for_write(env, &string_value(data.get("childId")), &scope).await?;
            let (village, posyandu) = child_location_parts(location);
            data.insert("childId".into(), Value::String(child_id));
            data.insert("childName".into(), Value::String(child_name));
            data.insert("desa".into(), Value::String(village));
            data.insert("posyandu".into(), Value::String(posyandu));
        }
        Resource::MpasiLogs => {
            required(&data, &["childId", "tglMonitoring"])?;
            let (child_id, child_name, _) =
                child_for_write(env, &string_value(data.get("childId")), &scope).await?;
            data.insert("childId".into(), Value::String(child_id));
            data.insert("childName".into(), Value::String(child_name));
        }
        Resource::PmtPrograms => {
            required(
                &data,
                &[
                    "childId",
                    "category",
                    "jenisPmt",
                    "sumberAnggaran",
                    "tglPemberian",
                ],
            )?;
            validate_integer(&data, "siklusKe", "Siklus PMT", 1, i16::MAX)?;
            let (child_id, child_name, _) =
                child_for_write(env, &string_value(data.get("childId")), &scope).await?;
            data.insert("childId".into(), Value::String(child_id));
            data.insert("childName".into(), Value::String(child_name));
        }
        Resource::ChangeLogs => {
            if change_entries_from_payload(&data).is_empty() {
                return Err(api_error(422, "Rincian perubahan identitas wajib diisi."));
            }
            let (child_id, child_name, _) =
                child_for_write(env, &string_value(data.get("childId")), &scope).await?;
            data.insert("childId".into(), Value::String(child_id));
            data.insert("childName".into(), Value::String(child_name));
            data.insert("changedBy".into(), Value::String(scope.role.clone()));
            data.insert("timestamp".into(), Value::String(now_iso()));
        }
    }
    let mut db_data = map_payload(resource, &data);
    db_data.insert("id".into(), Value::String(id.clone()));
    if resource != Resource::Children {
        db_data.insert(
            "child_id".into(),
            Value::String(string_value(data.get("childId"))),
        );
    }
    let (created, _) = rest_json(
        env,
        format!("{}?on_conflict=id", resource.name()),
        Method::Post,
        Some(Value::Object(db_data)),
        Some("resolution=ignore-duplicates,return=representation"),
        false,
    )
    .await?;
    let created = match rows(created)?.into_iter().next() {
        Some(created) => created,
        None => fetch_raw_document(resource, &id, &scope, env)
            .await?
            .ok_or_else(|| api_error(409, "ID data sudah digunakan di wilayah lain."))?,
    };
    clear_tombstone(env, resource, &id).await?;
    if resource == Resource::PmtPrograms {
        write_monitorings(env, &id, &data).await?;
    }
    if resource == Resource::ChangeLogs {
        write_change_entries(env, &id, &data).await?;
    }
    let extras = enrichment(resource, std::slice::from_ref(&created), env).await?;
    let created_document = api_document(resource, &created, extras.get(&id).cloned())?;
    record_audit_event(
        env,
        &scope,
        &request_id,
        idempotency_key.as_deref(),
        "create",
        resource,
        &id,
        None,
        created_document.get("data").cloned(),
    )
    .await?;
    invalidate_dynamic_cache(env, &scope.user_id).await;
    Ok(created_document)
}

async fn collection_update(
    mut request: Request,
    env: &Env,
    resource: Resource,
    id: &str,
) -> ApiResult<Value> {
    validate_idempotency_key(&request)?;
    let (request_id, idempotency_key) = mutation_request_metadata(&request);
    let scope = require_scope(&request, env).await?;
    let payload = request
        .json::<Value>()
        .await
        .map_err(|_| api_error(422, "Data dokumen tidak valid."))?;
    validate_collection_payload_size(&payload)?;
    let mut data = payload
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| api_error(422, "Data dokumen wajib diisi."))?;
    let existing = fetch_raw_document(resource, id, &scope, env)
        .await?
        .ok_or_else(|| api_error(404, "Data tidak ditemukan."))?;
    let existing_extras = enrichment(resource, std::slice::from_ref(&existing), env).await?;
    let existing_document = api_document(resource, &existing, existing_extras.get(id).cloned())?;
    let mut candidate = existing_document
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if let Some(expected_version) = payload.get("expectedVersion").and_then(Value::as_u64) {
        let current_version = candidate
            .get("version")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        if current_version != expected_version {
            let already_applied = data
                .iter()
                .all(|(key, value)| candidate.get(key) == Some(value));
            if already_applied {
                record_audit_event(
                    env,
                    &scope,
                    &request_id,
                    idempotency_key.as_deref(),
                    "update",
                    resource,
                    id,
                    None,
                    existing_document.get("data").cloned(),
                )
                .await?;
                return Ok(existing_document);
            }
            return Err(api_error(
                409,
                "Data telah diperbarui oleh pengguna lain. Muat ulang data sebelum menyimpan lagi.",
            ));
        }
    }

    if let Some(expected_updated_at) = payload
        .get("expectedUpdatedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let current_updated_at = string_value(candidate.get("updatedAt"));
        if current_updated_at != expected_updated_at {
            let already_applied = data
                .iter()
                .all(|(key, value)| candidate.get(key) == Some(value));
            if already_applied {
                record_audit_event(
                    env,
                    &scope,
                    &request_id,
                    idempotency_key.as_deref(),
                    "update",
                    resource,
                    id,
                    None,
                    existing_document.get("data").cloned(),
                )
                .await?;
                return Ok(existing_document);
            }
            return Err(api_error(
                409,
                "Data telah diperbarui oleh pengguna lain. Muat ulang data sebelum menyimpan lagi.",
            ));
        }
    }
    candidate.extend(data.clone());
    validate_resource_text(resource, &candidate)?;
    data.remove("createdAt");
    data.remove("updatedAt");
    data.remove("createdBy");
    data.remove("version");
    match resource {
        Resource::Children => {
            scoped_candidate(&scope, &candidate)?;
            validate_integer(&data, "anakKe", "Anak ke-", 1, i16::MAX)?;
            validate_integer(&data, "usiaKehamilan", "Usia kehamilan", 1, 50)?;
            validate_weight(&data, "bbLahir", "Berat lahir", 10.0)?;
            validate_weight(&data, "currentBB", "Berat badan", 60.0)?;
        }
        Resource::Measurements => {
            validate_integer(&data, "ageInMonths", "Usia balita", 0, i16::MAX)?;
            validate_weight(&data, "bb", "Berat badan", 60.0)?;
            let (child_id, child_name, location) =
                child_for_write(env, &string_value(candidate.get("childId")), &scope).await?;
            let (village, posyandu) = child_location_parts(location);
            if data.contains_key("childId") {
                data.insert("childId".into(), Value::String(child_id));
                data.insert("childName".into(), Value::String(child_name));
                data.insert("desa".into(), Value::String(village));
                data.insert("posyandu".into(), Value::String(posyandu));
            }
        }
        Resource::MpasiLogs | Resource::PmtPrograms | Resource::ChangeLogs => {
            if resource == Resource::PmtPrograms {
                validate_integer(&data, "siklusKe", "Siklus PMT", 1, i16::MAX)?;
            }
            let (child_id, child_name, _) =
                child_for_write(env, &string_value(candidate.get("childId")), &scope).await?;
            if data.contains_key("childId") {
                data.insert("childId".into(), Value::String(child_id));
                data.insert("childName".into(), Value::String(child_name));
            }
            if resource == Resource::ChangeLogs {
                data.insert("changedBy".into(), Value::String(scope.role.clone()));
                data.insert("timestamp".into(), Value::String(now_iso()));
            }
        }
    }
    let mut db_data = map_payload(resource, &data);
    if resource != Resource::ChangeLogs && !db_data.is_empty() {
        db_data.insert("updated_at".into(), Value::String(now_iso()));
    }
    if !db_data.is_empty() {
        rest_json(
            env,
            format!("{}?id=eq.{id}", resource.name()),
            Method::Patch,
            Some(Value::Object(db_data)),
            Some("return=minimal"),
            false,
        )
        .await?;
    }
    if resource == Resource::PmtPrograms {
        write_monitorings(env, id, &data).await?;
    }
    if resource == Resource::ChangeLogs {
        write_change_entries(env, id, &data).await?;
    }
    let updated = fetch_raw_document(resource, id, &scope, env)
        .await?
        .ok_or_else(|| api_error(404, "Data tidak ditemukan."))?;
    let extras = enrichment(resource, std::slice::from_ref(&updated), env).await?;
    let updated_document = api_document(resource, &updated, extras.get(id).cloned())?;
    record_audit_event(
        env,
        &scope,
        &request_id,
        idempotency_key.as_deref(),
        "update",
        resource,
        id,
        existing_document.get("data").cloned(),
        updated_document.get("data").cloned(),
    )
    .await?;
    invalidate_dynamic_cache(env, &scope.user_id).await;
    Ok(updated_document)
}

async fn collection_delete(
    mut request: Request,
    env: &Env,
    resource: Resource,
    id: &str,
) -> ApiResult<Value> {
    validate_idempotency_key(&request)?;
    let (request_id, idempotency_key) = mutation_request_metadata(&request);
    let scope = require_scope(&request, env).await?;
    let Some(existing) = fetch_raw_document(resource, id, &scope, env).await? else {
        return Ok(json!({}));
    };
    let existing_extras = enrichment(resource, std::slice::from_ref(&existing), env).await?;
    let existing_document = api_document(resource, &existing, existing_extras.get(id).cloned())?;
    let precondition = request
        .text()
        .await
        .ok()
        .filter(|body| !body.trim().is_empty())
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .unwrap_or_else(|| json!({}));
    let current_data = existing_document
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(expected_version) = precondition.get("expectedVersion").and_then(Value::as_u64) {
        let current_version = current_data
            .get("version")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        if current_version != expected_version {
            return Err(api_error(
                409,
                "Data telah diperbarui oleh pengguna lain. Periksa data terbaru sebelum menghapus.",
            ));
        }
    }
    if let Some(expected_updated_at) = precondition
        .get("expectedUpdatedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let current_updated_at = string_value(current_data.get("updatedAt"));
        if current_updated_at != expected_updated_at {
            return Err(api_error(
                409,
                "Data telah diperbarui oleh pengguna lain. Periksa data terbaru sebelum menghapus.",
            ));
        }
    }
    let row = row_object(&existing)?;
    let (village, posyandu) = match resource {
        Resource::Children => (
            string_value(row.get("village")),
            string_value(row.get("posyandu")),
        ),
        Resource::Measurements => (
            string_value(row.get("legacy_village")),
            string_value(row.get("legacy_posyandu")),
        ),
        _ => (
            string_value(child_field(row, "child_village", "village")),
            string_value(child_field(row, "child_posyandu", "posyandu")),
        ),
    };
    rest_json(
        env,
        format!("{}?id=eq.{id}", resource.name()),
        Method::Delete,
        None,
        Some("return=minimal"),
        false,
    )
    .await?;
    let body = json!({"resource": resource.name(), "document_id": id, "village": village, "posyandu": posyandu, "deleted_at": now_iso()});
    rest_json(
        env,
        "sync_tombstones?on_conflict=resource,document_id".into(),
        Method::Post,
        Some(body),
        Some("resolution=merge-duplicates,return=minimal"),
        false,
    )
    .await?;
    record_audit_event(
        env,
        &scope,
        &request_id,
        idempotency_key.as_deref(),
        "delete",
        resource,
        id,
        existing_document.get("data").cloned(),
        None,
    )
    .await?;
    invalidate_dynamic_cache(env, &scope.user_id).await;
    Ok(json!({}))
}

fn sync_request(
    authorization: &str,
    request_id: &str,
    method: Method,
    path: &str,
    idempotency_key: Option<&str>,
    body: Option<&Value>,
) -> ApiResult<Request> {
    let headers = Headers::new();
    headers
        .set("Authorization", authorization)
        .map_err(|_| api_error(422, "Header sinkronisasi tidak valid."))?;
    headers
        .set("X-Request-ID", request_id)
        .map_err(|_| api_error(422, "Header sinkronisasi tidak valid."))?;
    headers
        .set("Content-Type", "application/json")
        .map_err(|_| api_error(422, "Header sinkronisasi tidak valid."))?;
    if let Some(idempotency_key) = idempotency_key {
        headers
            .set("Idempotency-Key", idempotency_key)
            .map_err(|_| api_error(422, "Kunci idempotensi tidak valid."))?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        let encoded = serde_json::to_string(body)
            .map_err(|_| api_error(422, "Data sinkronisasi tidak valid."))?;
        init.with_body(Some(JsValue::from_str(&encoded)));
    }
    Request::new_with_init(&format!("https://sync.e-posyandu.internal{path}"), &init)
        .map_err(|_| api_error(422, "Permintaan sinkronisasi tidak valid."))
}

async fn sync_batch(mut request: Request, env: &Env) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    let authorization = request
        .headers()
        .get("Authorization")
        .map_err(|_| api_error(401, "Sesi masuk diperlukan."))?
        .ok_or_else(|| api_error(401, "Sesi masuk diperlukan."))?;
    let (request_id, _) = mutation_request_metadata(&request);
    let payload = request
        .json::<Value>()
        .await
        .map_err(|_| api_error(422, "Data sinkronisasi tidak valid."))?;
    let mutations = payload
        .get("mutations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if mutations.len() > 25 {
        return Err(api_error(
            413,
            "Maksimal 25 perubahan untuk satu sinkronisasi.",
        ));
    }

    let mut mutation_results = Vec::with_capacity(mutations.len());
    for mutation in mutations {
        let mutation = mutation
            .as_object()
            .ok_or_else(|| api_error(422, "Format perubahan tidak valid."))?;
        let mutation_id = string_value(mutation.get("id"));
        if !valid_idempotency_key(&mutation_id) {
            return Err(api_error(422, "Kunci idempotensi tidak valid."));
        }
        let resource_name = string_value(mutation.get("resource"));
        let resource = Resource::parse(&resource_name)
            .ok_or_else(|| api_error(422, "Koleksi sinkronisasi tidak didukung."))?;
        let document_id = string_value(mutation.get("documentId"));
        if document_id.trim().is_empty() {
            return Err(api_error(422, "ID data sinkronisasi wajib diisi."));
        }
        let operation = string_value(mutation.get("operation"));
        let encoded_id =
            url::form_urlencoded::byte_serialize(document_id.as_bytes()).collect::<String>();
        let collection_path = format!("/api/v1/collections/{}", resource.name());
        let (method, path, body) = match operation.as_str() {
            "add" => (
                Method::Post,
                collection_path,
                Some(json!({
                    "id": document_id,
                    "data": mutation.get("data").cloned().unwrap_or_else(|| json!({}))
                })),
            ),
            "update" => (
                Method::Patch,
                format!("{collection_path}/{encoded_id}"),
                Some(json!({
                    "data": mutation.get("data").cloned().unwrap_or_else(|| json!({})),
                    "expectedVersion": mutation.get("expectedVersion").cloned().unwrap_or(Value::Null),
                    "expectedUpdatedAt": mutation.get("expectedUpdatedAt").cloned().unwrap_or(Value::Null)
                })),
            ),
            "delete" => (
                Method::Delete,
                format!("{collection_path}/{encoded_id}"),
                Some(json!({
                    "expectedVersion": mutation.get("expectedVersion").cloned().unwrap_or(Value::Null),
                    "expectedUpdatedAt": mutation.get("expectedUpdatedAt").cloned().unwrap_or(Value::Null)
                })),
            ),
            _ => return Err(api_error(422, "Operasi sinkronisasi tidak didukung.")),
        };
        let subrequest = sync_request(
            &authorization,
            &request_id,
            method,
            &path,
            Some(&mutation_id),
            body.as_ref(),
        )?;
        match collections(subrequest, env).await {
            Ok(document) => mutation_results.push(json!({
                "id": mutation_id,
                "resource": resource.name(),
                "documentId": document_id,
                "operation": operation,
                "document": document,
            })),
            Err(error) => {
                let server_document = if error.status == 409 {
                    match fetch_raw_document(resource, &document_id, &scope, env).await? {
                        Some(row) => {
                            let extras =
                                enrichment(resource, std::slice::from_ref(&row), env).await?;
                            Some(api_document(
                                resource,
                                &row,
                                extras.get(&document_id).cloned(),
                            )?)
                        }
                        None => None,
                    }
                } else {
                    None
                };
                mutation_results.push(json!({
                    "id": mutation_id,
                    "resource": resource.name(),
                    "documentId": document_id,
                    "operation": operation,
                    "error": {
                        "status": error.status,
                        "code": error.code,
                        "detail": error.detail,
                    },
                    "conflict": if error.status == 409 {
                        json!({ "serverDocument": server_document })
                    } else {
                        Value::Null
                    },
                }));
            }
        }
    }

    let pulls = payload
        .get("pull")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if pulls.len() > 5 {
        return Err(api_error(
            413,
            "Maksimal lima koleksi untuk satu pengambilan perubahan.",
        ));
    }
    let mut changes = Map::new();
    for pull in pulls {
        let pull = pull
            .as_object()
            .ok_or_else(|| api_error(422, "Format pengambilan perubahan tidak valid."))?;
        let resource_name = string_value(pull.get("resource"));
        let resource = Resource::parse(&resource_name)
            .ok_or_else(|| api_error(422, "Koleksi sinkronisasi tidak didukung."))?;
        let since = string_value(pull.get("since"));
        if since.is_empty() || !since.contains('T') {
            return Err(api_error(422, "Cursor sinkronisasi tidak valid."));
        }
        let encoded_since =
            url::form_urlencoded::byte_serialize(since.as_bytes()).collect::<String>();
        let path = format!(
            "/api/v1/collections/{}?since={encoded_since}",
            resource.name()
        );
        let subrequest = sync_request(&authorization, &request_id, Method::Get, &path, None, None)?;
        changes.insert(
            resource.name().into(),
            collection_list(subrequest, env, resource).await?,
        );
    }

    Ok(json!({
        "results": mutation_results,
        "changes": changes,
        "cursor": now_iso(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundJobCreate {
    kind: String,
    #[serde(default = "empty_object")]
    payload: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundJobMessage {
    job_id: String,
}

fn empty_object() -> Value {
    json!({})
}

fn valid_background_job_kind(kind: &str) -> bool {
    matches!(
        kind,
        "import_validation" | "nutrition_report" | "export_file" | "system_sync"
    )
}

fn safe_job_id(value: &str) -> ApiResult<&str> {
    let valid = value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if valid {
        Ok(value)
    } else {
        Err(api_error(404, "Job tidak ditemukan."))
    }
}

fn background_job_public(row: &Value, queue_configured: Option<bool>) -> ApiResult<Value> {
    let row = row_object(row)?;
    let id = string_value(row.get("id"));
    Ok(json!({
        "id": id,
        "kind": string_value(row.get("kind")),
        "status": string_value(row.get("status")),
        "progress": number_or_null(row.get("progress")),
        "result": nullable_value(row.get("result")),
        "error": nullable_value(row.get("error")),
        "fileName": nullable_value(row.get("file_name")),
        "contentType": nullable_value(row.get("content_type")),
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

async fn fetch_background_job(env: &Env, id: &str, include_payload: bool) -> ApiResult<Value> {
    let select = if include_payload {
        "id,kind,status,progress,owner_user_id,actor_role,village,posyandu,idempotency_key,request_id,payload,result,error,object_key,file_name,content_type,size_bytes,created_at,updated_at,started_at,completed_at,expires_at"
    } else {
        "id,kind,status,progress,owner_user_id,result,error,object_key,file_name,content_type,size_bytes,created_at,updated_at,started_at,completed_at,expires_at"
    };
    let (payload, _) = rest_json(
        env,
        rest_path(
            "background_jobs",
            &[
                ("select".into(), select.into()),
                ("id".into(), format!("eq.{id}")),
                ("limit".into(), "1".into()),
            ],
        ),
        Method::Get,
        None,
        None,
        false,
    )
    .await?;
    rows(payload)?
        .into_iter()
        .next()
        .ok_or_else(|| api_error(404, "Job tidak ditemukan."))
}

async fn create_background_job(mut request: Request, env: &Env) -> ApiResult<Value> {
    validate_idempotency_key(&request)?;
    let scope = require_scope(&request, env).await?;
    let (request_id, idempotency_key) = mutation_request_metadata(&request);
    let body = request
        .text()
        .await
        .map_err(|_| api_error(422, "Data job tidak valid."))?;
    if body.len() > BACKGROUND_JOB_MAX_BODY_BYTES {
        return Err(api_error(413, "Payload job terlalu besar."));
    }
    let job: BackgroundJobCreate =
        serde_json::from_str(&body).map_err(|_| api_error(422, "Data job tidak valid."))?;
    let kind = job.kind.trim().to_ascii_lowercase();
    if !valid_background_job_kind(&kind) || !job.payload.is_object() {
        return Err(api_error(422, "Jenis atau payload job tidak valid."));
    }
    let idempotency_key = idempotency_key.unwrap_or_else(|| request_id.clone());
    let job_row = json!({
        "kind": kind,
        "status": "queued",
        "progress": 0,
        "owner_user_id": scope.user_id,
        "actor_role": scope.role,
        "village": scope.desa,
        "posyandu": scope.posyandu,
        "idempotency_key": idempotency_key,
        "request_id": request_id,
        "payload": job.payload,
    });
    let (inserted, _) = rest_json(
        env,
        "background_jobs?on_conflict=owner_user_id,idempotency_key".into(),
        Method::Post,
        Some(job_row),
        Some("resolution=ignore-duplicates,return=representation"),
        false,
    )
    .await?;
    let mut stored = rows(inserted)?.into_iter().next();
    if stored.is_none() {
        let (existing, _) = rest_json(
            env,
            rest_path(
                "background_jobs",
                &[
                    ("select".into(), "*".into()),
                    ("owner_user_id".into(), format!("eq.{}", scope.user_id)),
                    ("idempotency_key".into(), format!("eq.{idempotency_key}")),
                    ("limit".into(), "1".into()),
                ],
            ),
            Method::Get,
            None,
            None,
            false,
        )
        .await?;
        stored = rows(existing)?.into_iter().next();
    }
    let stored = stored.ok_or_else(|| api_error(503, "Job belum dapat dibuat."))?;
    let job_id = string_value(row_object(&stored)?.get("id"));
    let queue_configured = match env.queue("E_POSYANDU_JOBS") {
        Ok(queue) => queue
            .send(BackgroundJobMessage {
                job_id: job_id.clone(),
            })
            .await
            .is_ok(),
        Err(_) => false,
    };
    let _ = record_operational_audit(
        env,
        &scope.user_id,
        &scope.role,
        scope.desa.as_deref(),
        scope.posyandu.as_deref(),
        &request_id,
        Some(&idempotency_key),
        "job_create",
        "background_jobs",
        &job_id,
        None,
        None,
        json!({ "kind": kind, "queueConfigured": queue_configured }),
    )
    .await;
    background_job_public(&stored, Some(queue_configured))
}

async fn get_background_job(request: Request, env: &Env, id: &str) -> ApiResult<Value> {
    let id = safe_job_id(id)?;
    let scope = require_scope(&request, env).await?;
    let row = fetch_background_job(env, id, false).await?;
    let owner = string_value(row_object(&row)?.get("owner_user_id"));
    if owner != scope.user_id && !is_full_access_role(&scope.role) {
        return Err(api_error(404, "Job tidak ditemukan."));
    }
    background_job_public(&row, None)
}

fn background_job_route(path: &str) -> Option<(&str, bool)> {
    let suffix = path.trim_start_matches("/api/v1/jobs/");
    let mut parts = suffix.split('/');
    let id = parts.next()?;
    let file = parts.next() == Some("file");
    (parts.next().is_none() && !id.is_empty()).then_some((id, file))
}

pub(crate) async fn internal_background_job(
    method: Method,
    path: &str,
    body: &str,
    env: &Env,
) -> ApiResult<Value> {
    let suffix = path.trim_start_matches("/internal/v1/jobs/");
    let mut parts = suffix.split('/');
    let id = safe_job_id(parts.next().unwrap_or_default())?;
    let file_upload = parts.next() == Some("file");
    if parts.next().is_some() {
        return Err(api_error(404, "Job tidak ditemukan."));
    }
    if method == Method::Get && !file_upload {
        let row = fetch_background_job(env, id, true).await?;
        let row = row_object(&row)?;
        return Ok(json!({
            "id": string_value(row.get("id")),
            "kind": string_value(row.get("kind")),
            "status": string_value(row.get("status")),
            "progress": number_or_null(row.get("progress")),
            "payload": nullable_value(row.get("payload")),
            "actorRole": string_value(row.get("actor_role")),
            "village": nullable_value(row.get("village")),
            "posyandu": nullable_value(row.get("posyandu")),
        }));
    }
    if method == Method::Patch && !file_upload {
        let current = fetch_background_job(env, id, true).await?;
        let current = row_object(&current)?;
        let previous_status = string_value(current.get("status"));
        let actor_user_id = string_value(current.get("owner_user_id"));
        let actor_role = string_value(current.get("actor_role"));
        let village = string_value(current.get("village"));
        let posyandu = string_value(current.get("posyandu"));
        let request_id = string_value(current.get("request_id"));
        let idempotency_key = string_value(current.get("idempotency_key"));
        let payload = serde_json::from_str::<Value>(body)
            .map_err(|_| api_error(422, "Pembaruan job tidak valid."))?;
        let payload = payload
            .as_object()
            .ok_or_else(|| api_error(422, "Pembaruan job tidak valid."))?;
        let status = string_value(payload.get("status"));
        if !matches!(
            status.as_str(),
            "queued" | "processing" | "completed" | "failed" | "cancelled"
        ) {
            return Err(api_error(422, "Status job tidak valid."));
        }
        let progress = payload
            .get("progress")
            .and_then(Value::as_u64)
            .filter(|value| *value <= 100)
            .ok_or_else(|| api_error(422, "Progres job tidak valid."))?;
        let update = json!({
            "status": status,
            "progress": progress,
            "result": nullable_value(payload.get("result")),
            "error": nullable_value(payload.get("error")),
        });
        let (updated, _) = rest_json(
            env,
            rest_path("background_jobs", &[("id".into(), format!("eq.{id}"))]),
            Method::Patch,
            Some(update),
            Some("return=representation"),
            false,
        )
        .await?;
        let row = rows(updated)?
            .into_iter()
            .next()
            .ok_or_else(|| api_error(404, "Job tidak ditemukan."))?;
        let audit_action = if previous_status == status {
            None
        } else {
            match status.as_str() {
                "processing" => Some("job_start"),
                "completed" => Some("job_complete"),
                "failed" => Some("job_fail"),
                _ => None,
            }
        };
        if let Some(action) = audit_action {
            let _ = record_operational_audit(
                env,
                &actor_user_id,
                &actor_role,
                (!village.is_empty()).then_some(village.as_str()),
                (!posyandu.is_empty()).then_some(posyandu.as_str()),
                &request_id,
                (!idempotency_key.is_empty()).then_some(idempotency_key.as_str()),
                action,
                "background_jobs",
                id,
                Some(json!({ "status": previous_status })),
                Some(json!({ "status": status, "progress": progress })),
                json!({ "source": "nutrition-grpc" }),
            )
            .await;
        }
        return background_job_public(&row, None);
    }
    if method == Method::Post && file_upload {
        let payload = serde_json::from_str::<Value>(body)
            .map_err(|_| api_error(422, "Berkas hasil job tidak valid."))?;
        let filename = string_value(payload.get("filename"));
        let content_type = string_value(payload.get("contentType"));
        let encoded = string_value(payload.get("contentBase64"));
        let content = BASE64
            .decode(encoded)
            .map_err(|_| api_error(422, "Berkas hasil job tidak valid."))?;
        if content.is_empty() || content.len() > BACKGROUND_JOB_MAX_FILE_BYTES {
            return Err(api_error(413, "Ukuran berkas hasil job tidak valid."));
        }
        let safe_filename = filename
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        if safe_filename.is_empty() {
            return Err(api_error(422, "Nama berkas hasil job tidak valid."));
        }
        fetch_background_job(env, id, false).await?;
        let object_key = format!("jobs/{id}/{safe_filename}");
        let bucket = env
            .bucket("E_POSYANDU_FILES")
            .map_err(|_| api_error(503, "Penyimpanan R2 belum diaktifkan."))?;
        bucket
            .put(&object_key, content.clone())
            .http_metadata(HttpMetadata {
                content_type: Some(content_type.clone()),
                content_disposition: Some(format!("attachment; filename=\"{safe_filename}\"")),
                cache_control: Some("private, no-store".into()),
                ..HttpMetadata::default()
            })
            .execute()
            .await
            .map_err(|_| api_error(503, "Berkas hasil job belum dapat disimpan."))?;
        rest_json(
            env,
            rest_path("background_jobs", &[("id".into(), format!("eq.{id}"))]),
            Method::Patch,
            Some(json!({
                "object_key": object_key,
                "file_name": safe_filename,
                "content_type": content_type,
                "size_bytes": content.len(),
            })),
            Some("return=minimal"),
            false,
        )
        .await?;
        return Ok(json!({
            "objectKey": object_key,
            "downloadUrl": format!("/api/v1/jobs/{id}/file"),
        }));
    }
    Err(api_error(405, "Metode API job tidak didukung."))
}

pub(crate) async fn download_background_job_file(
    request: Request,
    env: &Env,
    id: &str,
) -> ApiResult<Response> {
    let id = safe_job_id(id)?;
    let scope = require_scope(&request, env).await?;
    let row = fetch_background_job(env, id, false).await?;
    let row = row_object(&row)?;
    let owner = string_value(row.get("owner_user_id"));
    if owner != scope.user_id && !is_full_access_role(&scope.role) {
        return Err(api_error(404, "Berkas job tidak ditemukan."));
    }
    let object_key = string_value(row.get("object_key"));
    if object_key.is_empty() {
        return Err(api_error(404, "Berkas job belum tersedia."));
    }
    let bucket = env
        .bucket("E_POSYANDU_FILES")
        .map_err(|_| api_error(503, "Penyimpanan R2 belum diaktifkan."))?;
    let object = bucket
        .get(object_key)
        .execute()
        .await
        .map_err(|_| api_error(503, "Berkas job belum dapat dibaca."))?
        .ok_or_else(|| api_error(404, "Berkas job tidak ditemukan."))?;
    let body = object
        .body()
        .ok_or_else(|| api_error(503, "Berkas job belum dapat dibaca."))?
        .response_body()
        .map_err(|_| api_error(503, "Berkas job belum dapat dibaca."))?;
    let mut response =
        Response::from_body(body).map_err(|_| api_error(503, "Berkas job belum dapat dibaca."))?;
    response
        .headers_mut()
        .set("Content-Type", &string_value(row.get("content_type")))
        .map_err(|_| api_error(503, "Header berkas job tidak dapat dibuat."))?;
    response
        .headers_mut()
        .set(
            "Content-Disposition",
            &format!(
                "attachment; filename=\"{}\"",
                string_value(row.get("file_name"))
            ),
        )
        .map_err(|_| api_error(503, "Header berkas job tidak dapat dibuat."))?;
    Ok(response)
}

async fn collections(request: Request, env: &Env) -> ApiResult<Value> {
    let path = request.path();
    let suffix = path
        .trim_start_matches("/api/v1/collections/")
        .trim_matches('/');
    let parts = suffix.split('/').collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 2 || parts[0].is_empty() {
        return Err(api_error(404, "Koleksi data tidak ditemukan."));
    }
    let resource =
        Resource::parse(parts[0]).ok_or_else(|| api_error(404, "Koleksi data tidak ditemukan."))?;
    match (parts.len(), request.method()) {
        (1, Method::Get) => collection_list(request, env, resource).await,
        (1, Method::Post) => collection_create(request, env, resource).await,
        (2, Method::Get) => collection_get(request, env, resource, parts[1]).await,
        (2, Method::Patch) => collection_update(request, env, resource, parts[1]).await,
        (2, Method::Delete) => collection_delete(request, env, resource, parts[1]).await,
        _ => Err(api_error(405, "Metode API tidak didukung.")),
    }
}

fn mutation_requires_write(method: &Method, path: &str) -> bool {
    (method == &Method::Post && matches!(path, "/api/v1/sync" | "/api/v1/jobs"))
        || (path.starts_with("/api/v1/collections/")
            && (method == &Method::Post || method == &Method::Patch || method == &Method::Delete))
}

pub async fn dispatch(request: Request, env: &Env) -> ApiResult<Value> {
    if mutation_requires_write(&request.method(), &request.path()) {
        let scope = require_scope(&request, env).await?;
        if scope.access_mode != "write" {
            return Err(api_error(403, "Akun ini hanya memiliki hak baca."));
        }
    }
    let cache_ttl_seconds = dynamic_cache_ttl_seconds(request.path().as_str());
    let cache_key = if dynamic_cacheable_request(&request) {
        let scope = require_scope(&request, env).await?;
        let url = request
            .url()
            .map_err(|_| api_error(400, "Alamat API tidak valid."))?;
        let request_target = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_owned(),
        };
        let version = dynamic_cache_version(env).await;
        let key = dynamic_cache_key(&scope, &request_target, &version);
        if let Some(value) = cached_dynamic_data(env, &key).await {
            log_dynamic_cache(env, &request, "HIT");
            return Ok(value);
        }
        log_dynamic_cache(env, &request, "MISS");
        Some(key)
    } else {
        None
    };

    let value = match (request.method(), request.path().as_str()) {
        (Method::Post, "/api/v1/sync") => sync_batch(request, env).await,
        (Method::Post, "/api/v1/jobs") => create_background_job(request, env).await,
        (Method::Post, "/api/v1/client-errors") => client_error(request, env).await,
        (Method::Get, "/api/v1/features") => feature_flags(request, env).await,
        (Method::Get, "/api/v1/dashboard/stats") => dashboard(request, env).await,
        (Method::Get, "/api/v1/exports/sigizi-measurements") => {
            sigizi_measurement_export(request, env).await
        }
        (Method::Get, "/api/v1/children/page") => children_page(request, env).await,
        (Method::Get, "/api/v1/exclusive-breastfeeding/page") => {
            exclusive_breastfeeding_page(request, env).await
        }
        _ if request.method() == Method::Get && request.path().starts_with("/api/v1/jobs/") => {
            let path = request.path();
            let (id, file) = background_job_route(&path)
                .ok_or_else(|| api_error(404, "Job tidak ditemukan."))?;
            if file {
                Err(api_error(
                    404,
                    "Rute unduhan harus ditangani sebagai berkas.",
                ))
            } else {
                get_background_job(request, env, id).await
            }
        }
        _ if request.path().starts_with("/api/v1/collections/") => collections(request, env).await,
        _ => Err(api_error(404, "Rute API tidak ditemukan.")),
    }?;
    if let Some(key) = cache_key {
        cache_dynamic_data(env, &key, &value, cache_ttl_seconds).await;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caches_dynamic_reads_with_dashboard_exception() {
        assert_eq!(DYNAMIC_CACHE_TTL_SECONDS, 300);
        assert_eq!(DASHBOARD_CACHE_TTL_SECONDS, 60);
        assert_eq!(dynamic_cache_ttl_seconds("/api/v1/dashboard/stats"), 60);
        assert_eq!(dynamic_cache_ttl_seconds("/api/v1/children/page"), 300);
        assert!(dynamic_cacheable_target(
            &Method::Get,
            "/api/v1/children/page",
            false
        ));
        assert!(dynamic_cacheable_target(
            &Method::Get,
            "/api/v1/collections/measurements",
            false
        ));
        assert!(!dynamic_cacheable_target(
            &Method::Get,
            "/api/v1/features",
            false
        ));
        assert!(!dynamic_cacheable_target(
            &Method::Get,
            "/api/v1/collections/measurements",
            true
        ));
        assert!(!dynamic_cacheable_target(
            &Method::Post,
            "/api/v1/collections/children",
            false
        ));
    }

    #[test]
    fn read_only_mode_covers_every_public_mutation_route() {
        assert!(mutation_requires_write(&Method::Post, "/api/v1/sync"));
        assert!(mutation_requires_write(&Method::Post, "/api/v1/jobs"));
        assert!(mutation_requires_write(
            &Method::Post,
            "/api/v1/collections/children"
        ));
        assert!(mutation_requires_write(
            &Method::Patch,
            "/api/v1/collections/children/example"
        ));
        assert!(mutation_requires_write(
            &Method::Delete,
            "/api/v1/collections/measurements/example"
        ));
        assert!(!mutation_requires_write(
            &Method::Get,
            "/api/v1/collections/children"
        ));
        assert!(!mutation_requires_write(&Method::Post, "/api/v1/graphql"));
    }

    #[test]
    fn separates_redis_cache_by_access_scope_and_version() {
        let scope = AccessScope {
            user_id: "user-1".into(),
            email: None,
            role: "Kader Posyandu".into(),
            desa: Some("Purwoasri".into()),
            posyandu: Some("SALAK 58".into()),
            access_mode: "write".into(),
        };
        let base = dynamic_cache_key(
            &scope,
            "/api/v1/collections/measurements?filter=childId%7C%3D%3D%7C123",
            "7",
        );
        let mut another_scope = scope.clone();
        another_scope.posyandu = Some("MELATI 01".into());
        assert_ne!(
            base,
            dynamic_cache_key(
                &another_scope,
                "/api/v1/collections/measurements?filter=childId%7C%3D%3D%7C123",
                "7"
            )
        );
        assert_ne!(
            base,
            dynamic_cache_key(
                &scope,
                "/api/v1/collections/measurements?filter=childId%7C%3D%3D%7C123",
                "8"
            )
        );
    }

    #[test]
    fn creates_temporary_identity_for_child_without_documents() {
        let mut data = json!({
            "tglLahir": "2026-07-31",
            "hasKK": false,
            "hasNIK": false,
            "noKK": "",
            "nik": ""
        })
        .as_object()
        .cloned()
        .expect("child payload");

        normalize_child_identity(&mut data, "child-test-1").expect("temporary identity");

        let family_card = string_value(data.get("noKK"));
        let national_id = string_value(data.get("nik"));
        assert!(is_sixteen_digits(&family_card));
        assert!(is_sixteen_digits(&national_id));
        assert!(national_id.starts_with("350904310726"));
    }

    #[test]
    fn rejects_invalid_official_child_identity() {
        let mut data = json!({
            "tglLahir": "2026-07-31",
            "hasKK": true,
            "hasNIK": true,
            "noKK": "123",
            "nik": "456"
        })
        .as_object()
        .cloned()
        .expect("child payload");

        let error = normalize_child_identity(&mut data, "child-test-2")
            .expect_err("invalid official identity must be rejected");
        assert_eq!(error.status, 422);
    }

    #[test]
    fn serializes_smallint_values_as_json_integers() {
        let data = json!({
            "anakKe": "4.0",
            "usiaKehamilan": 39.0,
            "pbLahir": "49.5"
        })
        .as_object()
        .cloned()
        .expect("child payload");

        let payload = map_payload(Resource::Children, &data);

        assert_eq!(payload.get("child_order"), Some(&json!(4)));
        assert_eq!(payload.get("gestational_age_weeks"), Some(&json!(39)));
        assert_eq!(payload.get("birth_length_cm"), Some(&json!(49.5)));
    }

    #[test]
    fn rejects_fractional_smallint_values() {
        let data = json!({"anakKe": "4.5"})
            .as_object()
            .cloned()
            .expect("child payload");

        let error = validate_integer(&data, "anakKe", "Anak ke-", 1, i16::MAX)
            .expect_err("fractional child order must be rejected");

        assert_eq!(error.status, 422);
    }

    #[test]
    fn normalizes_legacy_gram_weight_before_validation_and_storage() {
        let data = json!({"bbLahir": "3200"})
            .as_object()
            .cloned()
            .expect("child payload");

        validate_weight(&data, "bbLahir", "Berat lahir", 10.0)
            .expect("gram weight should be normalized safely");
        let payload = map_payload(Resource::Children, &data);

        assert_eq!(payload.get("birth_weight_kg"), Some(&json!(3.2)));
    }

    #[test]
    fn accepts_offline_mutation_idempotency_key() {
        assert!(valid_idempotency_key("mutation:01JABC-def_123"));
    }

    #[test]
    fn rejects_short_or_unsafe_idempotency_key() {
        assert!(!valid_idempotency_key("short"));
        assert!(!valid_idempotency_key("mutation key with spaces"));
    }

    #[test]
    fn rejects_control_characters_and_oversized_identity_text() {
        let control = json!({"nama": "Bayi\u{202e}uji"})
            .as_object()
            .cloned()
            .expect("child payload");
        let oversized = json!({"nama": "A".repeat(121)})
            .as_object()
            .cloned()
            .expect("child payload");

        assert_eq!(
            validate_resource_text(Resource::Children, &control)
                .expect_err("bidi control must be rejected")
                .status,
            422
        );
        assert_eq!(
            validate_resource_text(Resource::Children, &oversized)
                .expect_err("oversized child name must be rejected")
                .status,
            422
        );
    }

    #[test]
    fn strips_forbidden_controls_before_database_mapping() {
        let data = json!({"nama": "Bayi\u{0000} Aman"})
            .as_object()
            .cloned()
            .expect("child payload");

        let payload = map_payload(Resource::Children, &data);

        assert_eq!(payload.get("name"), Some(&json!("Bayi Aman")));
    }

    #[test]
    fn limits_collection_mutation_payload_size() {
        let payload = json!({"data": {"alamat": "A".repeat(COLLECTION_MUTATION_MAX_BODY_BYTES)}});

        assert_eq!(
            validate_collection_payload_size(&payload)
                .expect_err("oversized payload must be rejected")
                .status,
            413
        );
    }

    #[test]
    fn extracts_only_identity_changes_from_audit_data() {
        let before = json!({
            "nama": "Nama Lama",
            "hasNIK": true,
            "currentBB": 8.1,
            "version": 1
        });
        let after = json!({
            "nama": "Nama Baru",
            "hasNIK": false,
            "currentBB": 8.4,
            "version": 2
        });

        let changes = identity_changes(Some(&before), Some(&after));

        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].get("field"), Some(&json!("nama")));
        assert_eq!(changes[1].get("field"), Some(&json!("hasNIK")));
    }

    #[test]
    fn removes_empty_or_unchanged_change_entries() {
        let data = json!({
            "changes": [
                {"field": "nama", "oldValue": "Sama", "newValue": "Sama"},
                {"field": "", "oldValue": "Lama", "newValue": "Baru"},
                {"field": "alamat", "oldValue": "Alamat lama", "newValue": "Alamat baru"}
            ]
        })
        .as_object()
        .cloned()
        .expect("change payload");

        let changes = change_entries_from_payload(&data);

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].get("field"), Some(&json!("alamat")));
    }
}
