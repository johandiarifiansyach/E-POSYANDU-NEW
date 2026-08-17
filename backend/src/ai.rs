use crate::{ApiFailure, ApiResult, hashed_key, optional_secret, redis_commands, require_scope};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::HashMap};
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, wasm_bindgen::JsValue};

const MAX_REQUEST_BYTES: usize = 48 * 1024;
const MAX_MEASUREMENTS: usize = 61;
const RATE_LIMIT_REQUESTS: u8 = 6;
const RATE_LIMIT_WINDOW_SECONDS: u64 = 60;
const DISCLAIMER: &str = "Ringkasan AI hanya membantu membaca pola. Keputusan status gizi tetap mengikuti hasil WHO dan penilaian tenaga kesehatan.";

struct LocalAttempt {
    count: u8,
    reset_at: f64,
}

thread_local! {
    static AI_ATTEMPTS: RefCell<HashMap<String, LocalAttempt>> = RefCell::new(HashMap::new());
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrowthSummaryRequest {
    sex: String,
    measurements: Vec<AnonymousMeasurement>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnonymousMeasurement {
    age_months: i32,
    weight_kg: Option<f64>,
    length_height_cm: Option<f64>,
    lila_cm: Option<f64>,
    head_circumference_cm: Option<f64>,
    measurement_method: Option<String>,
    weight_trend: Option<String>,
    gap_before: bool,
    statuses: GrowthValues<String>,
    z_scores: GrowthValues<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrowthValues<T> {
    bbu: Option<T>,
    tbu: Option<T>,
    bbtb: Option<T>,
    imtu: Option<T>,
    lilau: Option<T>,
    lku: Option<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelSummary {
    overview: String,
    observations: Vec<String>,
    follow_up: Vec<String>,
}

fn api_error(status: u16, detail: impl Into<String>) -> ApiFailure {
    ApiFailure::new(status, detail)
}

fn now_ms() -> f64 {
    worker::js_sys::Date::now()
}

fn finite_in_range(value: Option<f64>, min: f64, max: f64) -> bool {
    value.is_none_or(|number| number.is_finite() && number >= min && number <= max)
}

fn valid_short_text(value: &str, max: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= max
        && trimmed.chars().all(|character| !character.is_control())
}

fn validate_growth_values(values: &GrowthValues<String>) -> bool {
    [
        &values.bbu,
        &values.tbu,
        &values.bbtb,
        &values.imtu,
        &values.lilau,
        &values.lku,
    ]
    .iter()
    .all(|value| {
        value
            .as_deref()
            .is_none_or(|text| valid_short_text(text, 48))
    })
}

fn validate_z_scores(values: &GrowthValues<f64>) -> bool {
    [
        values.bbu,
        values.tbu,
        values.bbtb,
        values.imtu,
        values.lilau,
        values.lku,
    ]
    .into_iter()
    .all(|value| finite_in_range(value, -20.0, 20.0))
}

fn validate_payload(payload: &GrowthSummaryRequest) -> ApiResult<()> {
    if !matches!(payload.sex.as_str(), "L" | "P") {
        return Err(api_error(
            422,
            "Jenis kelamin pada ringkasan pertumbuhan tidak valid.",
        ));
    }
    if payload.measurements.is_empty() || payload.measurements.len() > MAX_MEASUREMENTS {
        return Err(api_error(
            422,
            "Jumlah riwayat pertumbuhan harus antara 1 sampai 61 pengukuran.",
        ));
    }

    let mut previous_age = -1;
    for measurement in &payload.measurements {
        if !(0..=60).contains(&measurement.age_months) || measurement.age_months < previous_age {
            return Err(api_error(
                422,
                "Urutan usia pada riwayat pertumbuhan tidak valid.",
            ));
        }
        previous_age = measurement.age_months;
        if !finite_in_range(measurement.weight_kg, 0.1, 60.0)
            || !finite_in_range(measurement.length_height_cm, 10.0, 220.0)
            || !finite_in_range(measurement.lila_cm, 0.1, 50.0)
            || !finite_in_range(measurement.head_circumference_cm, 0.1, 80.0)
        {
            return Err(api_error(
                422,
                "Nilai antropometri pada ringkasan pertumbuhan tidak valid.",
            ));
        }
        if measurement.age_months < 3 && measurement.lila_cm.is_some() {
            return Err(api_error(
                422,
                "LILA tidak boleh dikirim untuk bayi berusia di bawah 3 bulan.",
            ));
        }
        if measurement
            .measurement_method
            .as_deref()
            .is_some_and(|method| !matches!(method, "Terlentang" | "Berdiri"))
            || measurement
                .weight_trend
                .as_deref()
                .is_some_and(|trend| !matches!(trend, "B" | "N" | "T" | "O"))
            || !validate_growth_values(&measurement.statuses)
            || !validate_z_scores(&measurement.z_scores)
        {
            return Err(api_error(
                422,
                "Status pertumbuhan pada permintaan AI tidak valid.",
            ));
        }
    }
    Ok(())
}

fn allow_local_request(key: String) -> ApiResult<()> {
    let now = now_ms();
    AI_ATTEMPTS.with(|attempts| {
        let mut attempts = attempts.borrow_mut();
        attempts.retain(|_, attempt| attempt.reset_at > now);
        let attempt = attempts.entry(key).or_insert(LocalAttempt {
            count: 0,
            reset_at: now + RATE_LIMIT_WINDOW_SECONDS as f64 * 1_000.0,
        });
        if attempt.count >= RATE_LIMIT_REQUESTS {
            return Err(api_error(
                429,
                "Terlalu banyak permintaan Ringkasan AI. Coba lagi sebentar.",
            ));
        }
        attempt.count += 1;
        Ok(())
    })
}

async fn enforce_rate_limit(env: &Env, user_id: &str) -> ApiResult<()> {
    let key = hashed_key("ai:growth-summary:v1", user_id);
    if let Some(payload) = redis_commands(
        env,
        json!([["INCR", key], ["EXPIRE", key, RATE_LIMIT_WINDOW_SECONDS]]),
    )
    .await
    {
        let count = payload
            .as_array()
            .and_then(|results| results.first())
            .and_then(|result| result.get("result"))
            .and_then(Value::as_u64)
            .unwrap_or(RATE_LIMIT_REQUESTS as u64 + 1);
        if count > RATE_LIMIT_REQUESTS as u64 {
            return Err(api_error(
                429,
                "Terlalu banyak permintaan Ringkasan AI. Coba lagi sebentar.",
            ));
        }
        return Ok(());
    }
    allow_local_request(key)
}

fn output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["overview", "observations", "followUp"],
        "properties": {
            "overview": { "type": "string", "minLength": 1, "maxLength": 500 },
            "observations": {
                "type": "array",
                "minItems": 1,
                "maxItems": 4,
                "items": { "type": "string", "minLength": 1, "maxLength": 260 }
            },
            "followUp": {
                "type": "array",
                "minItems": 1,
                "maxItems": 4,
                "items": { "type": "string", "minLength": 1, "maxLength": 260 }
            }
        }
    })
}

fn model_output_text(payload: &Value) -> Option<&str> {
    payload
        .get("output")?
        .as_array()?
        .iter()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .find(|content| content.get("type").and_then(Value::as_str) == Some("output_text"))?
        .get("text")?
        .as_str()
}

fn clean_model_text(value: String, max: usize) -> ApiResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > max
        || trimmed
            .chars()
            .any(|character| character.is_control() && character != '\n')
    {
        return Err(api_error(
            503,
            "Ringkasan AI belum dapat dibaca. Silakan coba lagi.",
        ));
    }
    Ok(trimmed.to_owned())
}

fn validated_model_summary(payload: Value) -> ApiResult<ModelSummary> {
    let encoded = model_output_text(&payload)
        .ok_or_else(|| api_error(503, "Ringkasan AI belum dapat dibaca. Silakan coba lagi."))?;
    let mut result: ModelSummary = serde_json::from_str(encoded)
        .map_err(|_| api_error(503, "Ringkasan AI belum dapat dibaca. Silakan coba lagi."))?;
    result.overview = clean_model_text(result.overview, 500)?;
    if !(1..=4).contains(&result.observations.len()) || !(1..=4).contains(&result.follow_up.len()) {
        return Err(api_error(
            503,
            "Ringkasan AI belum dapat dibaca. Silakan coba lagi.",
        ));
    }
    result.observations = result
        .observations
        .into_iter()
        .map(|item| clean_model_text(item, 260))
        .collect::<ApiResult<Vec<_>>>()?;
    result.follow_up = result
        .follow_up
        .into_iter()
        .map(|item| clean_model_text(item, 260))
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(result)
}

async fn request_openai(
    env: &Env,
    payload: &GrowthSummaryRequest,
) -> ApiResult<(ModelSummary, String)> {
    let api_key = optional_secret(env, "OPENAI_API_KEY").ok_or_else(|| {
        api_error(
            503,
            "Fitur Ringkasan AI belum dikonfigurasi oleh administrator.",
        )
    })?;
    let model = optional_secret(env, "OPENAI_MODEL").unwrap_or_else(|| "gpt-5.6-luna".to_owned());
    let anonymous_input = serde_json::to_string(payload)
        .map_err(|_| api_error(500, "Data anonim tidak dapat diproses."))?;
    let body = json!({
        "model": model,
        "store": false,
        "reasoning": { "effort": "low" },
        "max_output_tokens": 700,
        "instructions": concat!(
            "Anda membantu petugas Posyandu di Indonesia membaca pola pertumbuhan balita. ",
            "Semua status dan z-score WHO pada input sudah dihitung secara deterministik oleh aplikasi. ",
            "Jangan menghitung ulang, mengubah, atau bertentangan dengan hasil tersebut. ",
            "Jelaskan tren, jeda penimbangan, dan data yang belum lengkap dengan bahasa sederhana. ",
            "Jangan membuat diagnosis, resep, identitas, atau kepastian medis. ",
            "Jika ada hasil tidak normal, sarankan konfirmasi pengukuran dan penilaian tenaga kesehatan. ",
            "Kode gapBefore atau status O berarti garis pertumbuhan terputus karena bulan sebelumnya tidak ditimbang."
        ),
        "input": anonymous_input,
        "text": {
            "verbosity": "low",
            "format": {
                "type": "json_schema",
                "name": "growth_summary",
                "strict": true,
                "schema": output_schema()
            }
        }
    });

    let headers = Headers::new();
    headers
        .set("Authorization", &format!("Bearer {api_key}"))
        .map_err(|_| api_error(503, "Layanan Ringkasan AI belum tersedia."))?;
    headers
        .set("Content-Type", "application/json")
        .map_err(|_| api_error(503, "Layanan Ringkasan AI belum tersedia."))?;
    let encoded = serde_json::to_string(&body)
        .map_err(|_| api_error(500, "Permintaan Ringkasan AI tidak dapat diproses."))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&encoded)));
    let request = Request::new_with_init("https://api.openai.com/v1/responses", &init)
        .map_err(|_| api_error(503, "Layanan Ringkasan AI sementara tidak tersedia."))?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|_| api_error(503, "Layanan Ringkasan AI sementara tidak tersedia."))?;
    if !(200..300).contains(&response.status_code()) {
        return Err(api_error(
            503,
            "Layanan Ringkasan AI sementara tidak tersedia. Silakan coba lagi.",
        ));
    }
    let response_payload = response
        .json::<Value>()
        .await
        .map_err(|_| api_error(503, "Respons Ringkasan AI belum dapat dibaca."))?;
    let summary = validated_model_summary(response_payload)?;
    Ok((summary, model))
}

pub(crate) async fn growth_summary(mut request: Request, env: &Env) -> ApiResult<Value> {
    let scope = require_scope(&request, env).await?;
    enforce_rate_limit(env, &scope.user_id).await?;
    let body = request
        .text()
        .await
        .map_err(|_| api_error(400, "Permintaan Ringkasan AI tidak dapat dibaca."))?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(api_error(
            413,
            "Riwayat pertumbuhan terlalu besar untuk diringkas.",
        ));
    }
    let payload: GrowthSummaryRequest = serde_json::from_str(&body).map_err(|_| {
        api_error(
            422,
            "Data Ringkasan AI tidak valid atau masih memuat kolom yang tidak diizinkan.",
        )
    })?;
    validate_payload(&payload)?;
    let (summary, model) = request_openai(env, &payload).await?;
    Ok(json!({
        "overview": summary.overview,
        "observations": summary.observations,
        "followUp": summary.follow_up,
        "disclaimer": DISCLAIMER,
        "anonymous": true,
        "stored": false,
        "provider": "OpenAI",
        "model": model
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_payload() -> GrowthSummaryRequest {
        serde_json::from_value(json!({
            "sex": "P",
            "measurements": [{
                "ageMonths": 3,
                "weightKg": 5.2,
                "lengthHeightCm": 57.1,
                "lilaCm": 13.0,
                "headCircumferenceCm": 39.0,
                "measurementMethod": "Terlentang",
                "weightTrend": "N",
                "gapBefore": false,
                "statuses": {"bbu":"Berat Normal","tbu":"Normal","bbtb":"Gizi Baik","imtu":"Gizi Baik","lilau":"Normal","lku":"Normal"},
                "zScores": {"bbu":0.1,"tbu":0.2,"bbtb":0.0,"imtu":0.0,"lilau":0.1,"lku":0.2}
            }]
        }))
        .expect("valid anonymous payload")
    }

    #[test]
    fn accepts_anonymous_growth_payload() {
        validate_payload(&valid_payload()).expect("payload should be valid");
    }

    #[test]
    fn rejects_identity_fields_and_infant_lila() {
        let with_identity = serde_json::from_value::<GrowthSummaryRequest>(json!({
            "sex": "L",
            "nama": "Tidak boleh dikirim",
            "measurements": []
        }));
        assert!(with_identity.is_err());

        let mut payload = valid_payload();
        payload.measurements[0].age_months = 2;
        assert!(validate_payload(&payload).is_err());
    }

    #[test]
    fn reads_structured_output_text() {
        let payload = json!({
            "output": [{"content": [{
                "type": "output_text",
                "text": "{\"overview\":\"Pertumbuhan terpantau.\",\"observations\":[\"BB/U normal.\"],\"followUp\":[\"Lanjutkan pemantauan.\"]}"
            }]}]
        });
        let result = validated_model_summary(payload).expect("structured summary");
        assert_eq!(result.observations.len(), 1);
    }
}
