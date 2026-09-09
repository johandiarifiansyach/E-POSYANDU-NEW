//! Domain runtime shared by the independently deployable Oracle services.
//!
//! The HTTP gateway never owns these domains in production. The modules are
//! kept here during the migration so identity, operations, and realtime can
//! use the same audited implementation while running in separate processes.

#[path = "../../oracle-api/src/native_api.rs"]
mod native_api;
#[path = "../../oracle-api/src/native_auth.rs"]
mod native_auth;
#[path = "../../oracle-api/src/native_cache.rs"]
mod native_cache;
#[path = "../../oracle-api/src/native_db.rs"]
mod native_db;
#[path = "../../oracle-api/src/realtime.rs"]
mod realtime;
#[path = "../../oracle-api/src/system_metrics.rs"]
mod system_metrics;

use std::{collections::BTreeMap, future::Future, sync::Arc, time::Duration};

use axum::{
    body::{Body, to_bytes},
    extract::Request,
    http::{HeaderName, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use e_posyandu_proto::analysis::{
    AnalyzeDatasetRequest, CalculateBatchRequest, GrowthChartPoint, NutritionItem,
    RenderGrowthChartRequest, analysis_service_client::AnalysisServiceClient,
};
use e_posyandu_proto::proto::platform::v1::{HttpHeader, ServiceRequest, ServiceResponse};
use reqwest::{Client, redirect::Policy};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tonic::{
    Request as GrpcRequest,
    metadata::{Ascii, MetadataValue},
    service::Interceptor,
    transport::{Channel, Endpoint},
};

use native_api::NativeApi;
use native_auth::NativeAuth;
use native_cache::{DASHBOARD_CACHE_TTL_SECONDS, DYNAMIC_CACHE_TTL_SECONDS, NativeCache};
use native_db::NativeDatabase;
use realtime::{RealtimeEvent, RealtimeHub};
use system_metrics::SystemMetricsSampler;

const MAX_SERVICE_BODY_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_ANALYSIS_GRPC_URL: &str = "unix:///run/e-posyandu/analysis.sock";
const ANALYSIS_TOKEN_HEADER: &str = "x-eposyandu-service-token";
const MAX_ANALYSIS_ITEMS: usize = 10_000;
// Dataset-level table/dashboard analysis sends the scoped raw rows to the
// private Python service. Keep this in sync with grpcio's server options;
// the default gRPC limit is only a few MiB and causes an opaque 502 once the
// balita dataset grows beyond it.
const MAX_ANALYSIS_GRPC_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

// The page endpoint is intentionally split into two stages. Rust selects the
// requested page and loads only the history belonging to those children;
// Python then owns every status/risk/education calculation for that bounded
// dataset. Keep the projection narrow so slow kader connections never wait
// for unused identity/measurement columns.
const PAGE_MEASUREMENT_SELECT: &str = "id,child_id,legacy_child_id,legacy_child_name,legacy_village,legacy_posyandu,measurement_date,weight_kg,height_cm,head_circumference_cm,mid_upper_arm_circumference_cm,measurement_method,weight_gain_status,age_in_months,exclusive_breastfeeding,edema,mother_class_attendance,mbg,vitamin_a,created_at,updated_at,version";
const PAGE_MPASI_SELECT: &str = "id,child_id,legacy_child_id,legacy_child_name,monitoring_date,breastfeeding,staple_food,legumes,dairy,meat,eggs,vitamin_a_fruit_vegetable,other_fruit_vegetable,nutrition_intervention,created_at,updated_at,version";
// Dashboard input is deliberately narrower than the generic table projection.
// PostgreSQL performs the period/scope filtering, while Python remains the
// authority for every clinical/longitudinal calculation.
const DASHBOARD_CHILD_SELECT: &str =
    "id,name,national_id,birth_date,sex,village,posyandu,created_at,updated_at,deleted_at,version";
const DASHBOARD_MEASUREMENT_SELECT: &str = "id,child_id,legacy_child_id,legacy_child_name,legacy_village,legacy_posyandu,measurement_date,weight_kg,height_cm,head_circumference_cm,mid_upper_arm_circumference_cm,measurement_method,weight_gain_status,age_in_months,exclusive_breastfeeding,edema,mother_class_attendance,mbg,vitamin_a,created_at,updated_at,version";

fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("HTTP client tidak dapat dibuat: {error}"))
}

fn required_database() -> Result<Arc<NativeDatabase>, String> {
    NativeDatabase::from_env().map(Arc::new)
}

fn response_json(status: StatusCode, payload: Value) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        axum::Json(payload),
    )
        .into_response()
}

fn not_found() -> Response {
    response_json(
        StatusCode::NOT_FOUND,
        json!({"error":{"code":"not_found","message":"Rute domain service tidak ditemukan."}}),
    )
}

fn method_path(request: &Request) -> (Method, String) {
    (request.method().clone(), request.uri().path().to_owned())
}

fn dashboard_scope_key(village: Option<&str>, posyandu: Option<&str>) -> String {
    match (
        village.map(str::trim).filter(|value| !value.is_empty()),
        posyandu.map(str::trim).filter(|value| !value.is_empty()),
    ) {
        (None, None) => "global".to_owned(),
        (village, posyandu) => format!("{}/{}", village.unwrap_or("-"), posyandu.unwrap_or("-")),
    }
}

fn dashboard_cache_key(
    scope_key: &str,
    month_start: &str,
    month_end: &str,
    previous_month_start: &str,
    previous_month_end: &str,
    age_group: &str,
) -> String {
    format!(
        "dashboard:v3|{scope_key}|{month_start}|{month_end}|{previous_month_start}|{previous_month_end}|age:{age_group}"
    )
}

fn stale_snapshot_result(snapshot: &Value) -> Option<Value> {
    if snapshot.get("hit").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let mut result = snapshot.get("result").cloned()?;
    let Some(object) = result.as_object_mut() else {
        return Some(result);
    };
    object.insert("snapshotStale".to_owned(), Value::Bool(true));
    if let Some(value) = snapshot.get("sourceVersion") {
        object.insert("snapshotSourceVersion".to_owned(), value.clone());
    }
    if let Some(value) = snapshot.get("currentVersion") {
        object.insert("snapshotCurrentVersion".to_owned(), value.clone());
    }
    if let Some(value) = snapshot.get("calculatedAt") {
        object.insert("snapshotCalculatedAt".to_owned(), value.clone());
    }
    Some(result)
}

fn analysis_value_present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => {
            let value = value.trim();
            !value.is_empty() && value != "-"
        }
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
        Value::Bool(_) | Value::Number(_) => true,
    }
}

/// Return true when a measurement already has at least one persisted Python
/// result.  Read-replica fallbacks can contain the raw row (including the
/// legacy/default `statusNaik` value) while the materialized projection is
/// temporarily unavailable; that raw field must not be mistaken for a Python
/// result and hidden behind a loading skeleton.
fn has_persisted_analysis(data: &serde_json::Map<String, Value>) -> bool {
    [
        "bbuStatus",
        "tbuStatus",
        "bbtbStatus",
        "imtuStatus",
        "lilaStatus",
        "lkStatus",
        "exclusiveBreastfeedingStatus",
        "analysis",
    ]
    .into_iter()
    .any(|key| data.get(key).is_some_and(analysis_value_present))
}

/// Used by the dynamic Redis cache guard. A page with an unfinished analysis
/// is deliberately never cached: otherwise the read service could serve the
/// same skeleton for the whole TTL after Python has already committed the
/// result. Completed pages remain cacheable for fast kader reads.
fn has_pending_analysis(value: &Value) -> bool {
    match value {
        Value::Object(values) => {
            values.get("analysisPending").and_then(Value::as_bool) == Some(true)
                || values.values().any(has_pending_analysis)
        }
        Value::Array(values) => values.iter().any(has_pending_analysis),
        _ => false,
    }
}

/// Annotate a direct PostgreSQL page used during a rolling migration or a
/// temporary Python outage. The raw page remains read-only and keeps the
/// persisted values intact; only measurement rows without derived values are
/// marked pending so the UI does not present missing analysis as completed.
fn mark_page_read_fallback(mut page: Value) -> Value {
    let Some(object) = page.as_object_mut() else {
        return page;
    };
    object.insert("readFallback".to_owned(), json!("postgresql"));
    if let Some(rows) = object.get_mut("measurements").and_then(Value::as_array_mut) {
        for row in rows {
            if let Some(data) = row.get_mut("data").and_then(Value::as_object_mut) {
                // Preserve any values that were already persisted by Python.
                // Only a row with no derived result should remain pending.
                data.insert(
                    "analysisPending".to_owned(),
                    Value::Bool(!has_persisted_analysis(data)),
                );
            }
        }
    }
    page
}

fn valid_age_group(value: &str) -> bool {
    matches!(
        value,
        "0-59"
            | "newborn"
            | "newborn_premature"
            | "0-5"
            | "6"
            | "0-11"
            | "0-23"
            | "6-11"
            | "6-23"
            | "12-23"
            | "6-59"
            | "12-59"
            | "24-59"
    )
}

fn valid_exclusive_breastfeeding_age_group(value: &str) -> bool {
    matches!(value, "0-5" | "6")
}

fn default_age_group() -> String {
    "0-59".to_owned()
}

#[derive(Clone)]
struct AnalysisTokenInterceptor {
    token: MetadataValue<Ascii>,
}

impl Interceptor for AnalysisTokenInterceptor {
    fn call(&mut self, mut request: GrpcRequest<()>) -> Result<GrpcRequest<()>, tonic::Status> {
        request
            .metadata_mut()
            .insert(ANALYSIS_TOKEN_HEADER, self.token.clone());
        Ok(request)
    }
}

#[derive(Clone)]
struct AnalysisClient {
    channel: Channel,
    token: MetadataValue<Ascii>,
}

impl AnalysisClient {
    fn from_env() -> Result<Option<Self>, String> {
        let enabled = std::env::var("ANALYSIS_GRPC_ENABLED")
            .ok()
            .map(|value| {
                !matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "0" | "false" | "no"
                )
            })
            // Keep the gateway compatible with older environments during the
            // staged rollout. Compose enables this explicitly once the Python
            // service and shared secret are present.
            .unwrap_or(false);
        if !enabled {
            return Ok(None);
        }
        let secret = std::env::var("RUST_WORKER_SHARED_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "RUST_WORKER_SHARED_SECRET wajib diisi saat analisis Python aktif.".to_owned()
            })?;
        let token = secret
            .parse()
            .map_err(|_| "RUST_WORKER_SHARED_SECRET harus berupa metadata ASCII.".to_owned())?;
        let url = std::env::var("ANALYSIS_GRPC_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ANALYSIS_GRPC_URL.to_owned());
        let endpoint = Endpoint::from_shared(url.trim().to_owned())
            .map_err(|_| "ANALYSIS_GRPC_URL bukan URL gRPC valid.".to_owned())?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30));
        Ok(Some(Self {
            channel: endpoint.connect_lazy(),
            token,
        }))
    }

    async fn calculate_batch(
        &self,
        items: Vec<NutritionItem>,
    ) -> Result<e_posyandu_proto::analysis::CalculateBatchResponse, tonic::Status> {
        let mut client = AnalysisServiceClient::with_interceptor(
            self.channel.clone(),
            AnalysisTokenInterceptor {
                token: self.token.clone(),
            },
        )
        .max_decoding_message_size(MAX_ANALYSIS_GRPC_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_ANALYSIS_GRPC_MESSAGE_BYTES);
        client
            .calculate_batch(GrpcRequest::new(CalculateBatchRequest { items }))
            .await
            .map(|response| response.into_inner())
    }

    async fn render_growth_chart(
        &self,
        request: RenderGrowthChartRequest,
    ) -> Result<e_posyandu_proto::analysis::RenderGrowthChartResponse, tonic::Status> {
        let mut client = AnalysisServiceClient::with_interceptor(
            self.channel.clone(),
            AnalysisTokenInterceptor {
                token: self.token.clone(),
            },
        )
        .max_decoding_message_size(MAX_ANALYSIS_GRPC_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_ANALYSIS_GRPC_MESSAGE_BYTES);
        client
            .render_growth_chart(GrpcRequest::new(request))
            .await
            .map(|response| response.into_inner())
    }

    async fn analyze_dataset(&self, dataset: Value) -> Result<Value, tonic::Status> {
        let mut client = AnalysisServiceClient::with_interceptor(
            self.channel.clone(),
            AnalysisTokenInterceptor {
                token: self.token.clone(),
            },
        )
        .max_decoding_message_size(MAX_ANALYSIS_GRPC_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_ANALYSIS_GRPC_MESSAGE_BYTES);
        let dataset_json = serde_json::to_string(&dataset)
            .map_err(|error| tonic::Status::invalid_argument(error.to_string()))?;
        let response = client
            .analyze_dataset(GrpcRequest::new(AnalyzeDatasetRequest { dataset_json }))
            .await?
            .into_inner();
        serde_json::from_str(&response.result_json).map_err(|error| {
            tonic::Status::internal(format!("Respons analitik Python tidak valid: {error}"))
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisItemInput {
    #[serde(alias = "weight_kg")]
    weight_kg: Option<f64>,
    #[serde(alias = "height_cm")]
    height_cm: Option<f64>,
    age_months: Option<i32>,
    #[serde(default)]
    sex: String,
    #[serde(alias = "measurement_method")]
    measurement_method: Option<String>,
    row_number: Option<u64>,
    record_id: Option<String>,
    nik: Option<String>,
    #[serde(alias = "lila_cm")]
    lila_cm: Option<f64>,
    #[serde(alias = "head_circumference_cm")]
    head_circumference_cm: Option<f64>,
    measurement_date: Option<String>,
    weight_gain_status: Option<String>,
    exclusive_breastfeeding: Option<String>,
    #[serde(default)]
    history: Vec<Value>,
}

fn analysis_item_proto(input: AnalysisItemInput, index: usize) -> Result<NutritionItem, String> {
    let weight_kg = input
        .weight_kg
        .ok_or_else(|| format!("items[{index}].weightKg wajib diisi."))?;
    let age_months = input
        .age_months
        .ok_or_else(|| format!("items[{index}].ageMonths wajib diisi."))?;
    if !weight_kg.is_finite() || !age_months.ge(&0) || input.sex.trim().is_empty() {
        return Err(format!("items[{index}] memiliki angka yang tidak valid."));
    }
    Ok(NutritionItem {
        weight_kg,
        height_cm: input.height_cm,
        age_months,
        sex: input.sex,
        measurement_method: input.measurement_method,
        row_number: input.row_number.unwrap_or(index as u64 + 1),
        record_id: input.record_id.unwrap_or_default(),
        nik: input.nik.unwrap_or_default(),
        lila_cm: input.lila_cm,
        head_circumference_cm: input.head_circumference_cm,
        history_json: serde_json::to_string(&input.history)
            .map_err(|_| "Riwayat pengukuran tidak valid.".to_owned())?,
        measurement_date: input.measurement_date,
        exclusive_breastfeeding: input.exclusive_breastfeeding,
    })
}

fn analysis_response_payload(
    response: e_posyandu_proto::analysis::CalculateBatchResponse,
) -> Value {
    let items = response
        .items
        .into_iter()
        .map(|item| {
            let analysis =
                serde_json::from_str::<Value>(&item.analysis_json).unwrap_or_else(|_| json!({}));
            json!({
                "rowNumber": item.row_number,
                "recordId": item.record_id,
                "nik": item.nik,
                "bbuStatus": item.bbu_status,
                "tbuStatus": item.tbu_status,
                "bbtbStatus": item.bbtb_status,
                "imtuStatus": item.imtu_status,
                "lilaStatus": item.lila_status,
                "lkStatus": item.lk_status,
                "bbuZScore": item.bbu_z_score,
                "tbuZScore": item.tbu_z_score,
                "bbtbZScore": item.bbtb_z_score,
                "imtuZScore": item.imtu_z_score,
                "lilaZScore": item.lila_z_score,
                "lkZScore": item.lk_z_score,
                "analysis": analysis
            })
        })
        .collect::<Vec<_>>();
    json!({
        "underweight": response.underweight,
        "stunting": response.stunting,
        "wasting": response.wasting,
        "total": response.total,
        "items": items,
        "standardsVersion": response.standards_version,
        "calculator": response.calculator
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrowthChartInput {
    chart_type: String,
    sex: String,
    #[serde(default)]
    child_name: String,
    #[serde(default = "default_language")]
    language: String,
    #[serde(default)]
    points: Vec<AnalysisItemInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardAnalysisInput {
    month_start: String,
    month_end: String,
    previous_month_start: String,
    previous_month_end: String,
    #[serde(default = "default_age_group")]
    age_group: String,
    village: Option<String>,
    posyandu: Option<String>,
}

fn valid_iso_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn append_unique_rows(target: &mut Vec<Value>, rows: Value) {
    let Some(rows) = rows.as_array() else {
        return;
    };
    let mut seen = target
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<std::collections::BTreeSet<_>>();
    for row in rows {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        if seen.insert(id.to_owned()) {
            target.push(row.clone());
        }
    }
}

fn id_list_filter(ids: &[String]) -> Option<String> {
    (!ids.is_empty()).then(|| format!("in.({})", ids.join(",")))
}

fn is_full_access_role(role: &str) -> bool {
    matches!(role, "Ahli Gizi" | "super_admin")
}

fn default_language() -> String {
    "id".to_owned()
}

fn chart_request(input: GrowthChartInput) -> Result<RenderGrowthChartRequest, String> {
    if input.points.len() > MAX_ANALYSIS_ITEMS {
        return Err("Jumlah titik grafik melebihi batas 10.000.".to_owned());
    }
    let points = input
        .points
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let age_months = item
                .age_months
                .ok_or_else(|| format!("points[{index}].ageMonths wajib diisi."))?;
            if !(0..=60).contains(&age_months) {
                return Err(format!("points[{index}].ageMonths harus antara 0 dan 60."));
            }
            Ok(GrowthChartPoint {
                age_months,
                weight_kg: item.weight_kg.unwrap_or_default(),
                height_cm: item.height_cm,
                lila_cm: item.lila_cm,
                head_circumference_cm: item.head_circumference_cm,
                measurement_method: item.measurement_method,
                measurement_date: item.measurement_date,
                weight_gain_status: item.weight_gain_status,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(RenderGrowthChartRequest {
        chart_type: input.chart_type,
        sex: input.sex,
        points,
        child_name: Some(input.child_name),
        language: input.language,
    })
}

/// Converts the private protobuf envelope into the exact request shape used by
/// the existing, audited domain handlers.
pub fn request_from_proto(input: &ServiceRequest) -> Result<Request, StatusCode> {
    let method = input
        .method
        .parse::<Method>()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let uri = input
        .path_and_query
        .parse::<Uri>()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::from(input.body.clone()))
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    for item in &input.headers {
        let name = HeaderName::try_from(item.name.as_str()).map_err(|_| StatusCode::BAD_REQUEST)?;
        let value =
            HeaderValue::try_from(item.value.as_str()).map_err(|_| StatusCode::BAD_REQUEST)?;
        request.headers_mut().append(name, value);
    }
    Ok(request)
}

/// Converts an Axum response back to the private protobuf envelope. This is
/// deliberately generic so the public gateway preserves cookies and security
/// headers without exposing a second browser-facing HTTP API.
pub async fn response_to_proto(response: Response) -> ServiceResponse {
    let status = response.status().as_u16() as u32;
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            Some(HttpHeader {
                name: name.as_str().to_owned(),
                value: value.to_str().ok()?.to_owned(),
            })
        })
        .collect();
    let body = to_bytes(response.into_body(), MAX_SERVICE_BODY_BYTES)
        .await
        .map(|bytes| bytes.to_vec())
        .unwrap_or_default();
    ServiceResponse {
        status,
        headers,
        body,
    }
}

pub struct IdentityDomain {
    auth: Arc<NativeAuth>,
}

impl IdentityDomain {
    pub fn from_env() -> Result<Self, String> {
        let database = required_database()?;
        let auth = NativeAuth::from_env(client()?, Some(database))?.ok_or_else(|| {
            "ORACLE_API_NATIVE_AUTH_ENABLED wajib true pada identity-service.".to_owned()
        })?;
        Ok(Self {
            auth: Arc::new(auth),
        })
    }

    pub async fn handle(&self, request: Request) -> Response {
        let (method, path) = method_path(&request);
        match (method.clone(), path.as_str()) {
            (Method::POST, "/api/v1/auth/login") => self.auth.login(request).await,
            (Method::POST, "/api/v1/auth/invite/complete") => {
                self.auth.complete_invite(request).await
            }
            (Method::POST, "/api/v1/auth/mfa/enroll") => self.auth.mfa_enroll(request).await,
            (Method::POST, "/api/v1/auth/mfa/challenge") => self.auth.mfa_challenge(request).await,
            (Method::POST, "/api/v1/auth/mfa/verify") => self.auth.mfa_verify(request).await,
            (Method::POST, "/api/v1/auth/passkey/registration/options") => {
                self.auth.passkey_registration_options(request).await
            }
            (Method::POST, "/api/v1/auth/passkey/registration/verify") => {
                self.auth.passkey_registration_verify(request).await
            }
            (Method::POST, "/api/v1/auth/passkey/authentication/options") => {
                self.auth.passkey_authentication_options(request).await
            }
            (Method::POST, "/api/v1/auth/passkey/authentication/verify") => {
                self.auth.passkey_authentication_verify(request).await
            }
            (Method::POST, "/api/v1/auth/logout") => self.auth.logout(request).await,
            (Method::GET, "/api/v1/auth/session") => self.auth.session(request).await,
            (Method::POST, "/api/v1/auth/presence") => self.auth.presence(request).await,
            (Method::GET, "/api/v1/me") => self.auth.me(request).await,
            (Method::GET, "/api/v1/admin/accounts") => {
                let headers = request.headers().clone();
                match self.auth.admin_accounts(headers).await {
                    Ok(payload) => response_json(StatusCode::OK, payload),
                    Err(response) => response,
                }
            }
            (Method::POST, "/api/v1/admin/accounts") => {
                self.auth.create_admin_account(request).await
            }
            _ if path.starts_with("/api/v1/admin/accounts/") && method == Method::PATCH => {
                let user_id = path
                    .trim_start_matches("/api/v1/admin/accounts/")
                    .to_owned();
                self.auth.update_admin_account(request, user_id).await
            }
            _ if path.starts_with("/api/v1/admin/accounts/") && method == Method::DELETE => {
                let user_id = path
                    .trim_start_matches("/api/v1/admin/accounts/")
                    .to_owned();
                self.auth.delete_admin_account(request, user_id).await
            }
            _ => not_found(),
        }
    }
}

pub struct OperationsDomain {
    database: Arc<NativeDatabase>,
    api: Arc<NativeApi>,
    auth: Arc<NativeAuth>,
    analysis: Option<AnalysisClient>,
    cache: Option<NativeCache>,
}

impl OperationsDomain {
    pub async fn from_env() -> Result<Self, String> {
        Self::from_env_with_modes(true, true, "operations-service").await
    }

    async fn from_env_with_modes(
        reads_enabled: bool,
        writes_enabled: bool,
        service_name: &str,
    ) -> Result<Self, String> {
        let database = required_database()?;
        let auth = NativeAuth::from_env(client()?, Some(database.clone()))?.ok_or_else(|| {
            format!("ORACLE_API_NATIVE_AUTH_ENABLED wajib true pada {service_name}.")
        })?;
        let realtime = RealtimeHub::new();
        let auth = Arc::new(auth);
        let api = NativeApi::from_env(
            client()?,
            auth.clone(),
            database.clone(),
            realtime,
            reads_enabled,
            writes_enabled,
        )
        .await?;
        let cache = api.cache_handle();
        Ok(Self {
            database,
            api: Arc::new(api),
            auth,
            // Only the read-side owns synchronous analysis requests. Keeping
            // this absent in WriteService lets writes commit to PostgreSQL and
            // enqueue work even when the Python worker is restarting.
            analysis: if reads_enabled {
                AnalysisClient::from_env()?
            } else {
                None
            },
            cache,
        })
    }

    pub async fn handle(&self, request: Request) -> Response {
        self.handle_mode(request, true, true).await
    }

    async fn handle_read(&self, request: Request) -> Response {
        self.handle_mode(request, true, false).await
    }

    async fn handle_write(&self, request: Request) -> Response {
        self.handle_mode(request, false, true).await
    }

    async fn handle_mode(
        &self,
        request: Request,
        allow_reads: bool,
        allow_writes: bool,
    ) -> Response {
        let (method, path) = method_path(&request);
        // Analysis endpoints use POST for payload size and are still strictly
        // read-side operations: they never mutate the raw tables. Keep them
        // behind ReadService so WriteService cannot accidentally expose them.
        if allow_reads && method == Method::POST && path == "/api/v1/analysis/anthropometry" {
            return self.calculate_anthropometry(request).await;
        }
        if allow_reads && method == Method::POST && path == "/api/v1/analysis/dashboard-stats" {
            return self
                .cached_response(request, DASHBOARD_CACHE_TTL_SECONDS, |request| {
                    self.analyze_dashboard_stats(request)
                })
                .await;
        }
        if allow_reads && method == Method::POST && path == "/api/v1/analysis/growth-chart" {
            return self.render_growth_chart(request).await;
        }
        if allow_reads && method == Method::GET && path == "/api/v1/children/page" {
            return self
                .cached_response(request, DYNAMIC_CACHE_TTL_SECONDS, |request| {
                    self.children_page_python(request)
                })
                .await;
        }
        if allow_reads && method == Method::GET && path == "/api/v1/exclusive-breastfeeding/page" {
            return self
                .cached_response(request, DYNAMIC_CACHE_TTL_SECONDS, |request| {
                    self.exclusive_breastfeeding_page_python(request)
                })
                .await;
        }
        let mode_matches =
            (allow_reads && method == Method::GET) || (allow_writes && method != Method::GET);
        if mode_matches && self.api.handles(&request) {
            self.api.handle(request).await
        } else {
            not_found()
        }
    }

    /// Cache successful, scope-authorized operation reads in Redis. The
    /// handler still revalidates the session because it owns the complete
    /// request flow; a cache miss therefore cannot bypass authorization.
    async fn cached_response<F, Fut>(
        &self,
        request: Request,
        ttl_seconds: u64,
        handler: F,
    ) -> Response
    where
        F: FnOnce(Request) -> Fut,
        Fut: Future<Output = Response>,
    {
        let (cache, key, request) = if let Some(cache) = self.cache.as_ref() {
            // Dashboard filters arrive in the POST body, so include a digest
            // of that body in the cache target. Without it, two different
            // months/cohorts could share one Redis entry.
            let (parts, body) = request.into_parts();
            let body = match to_bytes(body, MAX_SERVICE_BODY_BYTES).await {
                Ok(body) => body,
                Err(_) => {
                    return response_json(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        json!({"error": {"code": "payload_too_large", "message": "Permintaan terlalu besar."}}),
                    );
                }
            };
            let mut target = parts
                .uri
                .path_and_query()
                .map(|value| value.as_str())
                .unwrap_or(parts.uri.path())
                .to_owned();
            if !body.is_empty() {
                target.push_str("|body:");
                target.push_str(&hex::encode(Sha256::digest(&body)));
            }
            let scope = match self.auth.authorize_scope(parts.headers.clone()).await {
                Ok(scope) => scope,
                Err(response) => return response,
            };
            let key = cache
                .request_key(
                    &scope.role,
                    scope.desa.as_deref(),
                    scope.posyandu.as_deref(),
                    &target,
                )
                .await;
            (
                Some(cache.clone()),
                key,
                Request::from_parts(parts, Body::from(body)),
            )
        } else {
            (None, None, request)
        };

        if let (Some(cache), Some(key)) = (cache.as_ref(), key.as_deref())
            && let Some(value) = cache.get(key).await
        {
            // Do not reuse a page captured while Python was still processing
            // a newly written measurement.  The next request must reach
            // PostgreSQL so it can observe the materialized result as soon
            // as the worker commits it.
            if !has_pending_analysis(&value) {
                return response_json(StatusCode::OK, value);
            }
        }

        let response = handler(request).await;
        if !response.status().is_success() {
            return response;
        }
        let (parts, body) = response.into_parts();
        let bytes = match to_bytes(body, MAX_SERVICE_BODY_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => return Response::from_parts(parts, Body::empty()),
        };
        if let (Some(cache), Some(key)) = (cache.as_ref(), key.as_deref())
            && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
            && !has_pending_analysis(&value)
        {
            cache.put(key, &value, ttl_seconds).await;
        }
        Response::from_parts(parts, Body::from(bytes))
    }

    async fn calculate_anthropometry(&self, request: Request) -> Response {
        let Some(client) = self.analysis.as_ref() else {
            return response_json(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "error": {"code": "analysis_unavailable", "message": "Analisis Python belum aktif."}
                }),
            );
        };
        if let Err(response) = self.auth.authorize_scope(request.headers().clone()).await {
            return response;
        }
        let body = match to_bytes(request.into_body(), MAX_SERVICE_BODY_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return response_json(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({
                        "error": {"code": "payload_too_large", "message": "Data analisis terlalu besar."}
                    }),
                );
            }
        };
        #[derive(Deserialize)]
        struct BatchInput {
            #[serde(default)]
            items: Vec<AnalysisItemInput>,
        }
        let input = match serde_json::from_slice::<BatchInput>(&body) {
            Ok(input) if input.items.len() <= MAX_ANALYSIS_ITEMS => input,
            Ok(_) => {
                return response_json(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({
                        "error": {"code": "too_many_items", "message": "Jumlah item analisis melebihi batas 10.000."}
                    }),
                );
            }
            Err(_) => {
                return response_json(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({
                        "error": {"code": "invalid_payload", "message": "Payload analisis tidak valid."}
                    }),
                );
            }
        };
        let items = match input
            .items
            .into_iter()
            .enumerate()
            .map(|(index, item)| analysis_item_proto(item, index))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(items) => items,
            Err(message) => {
                return response_json(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error": {"code": "invalid_payload", "message": message}}),
                );
            }
        };
        match client.calculate_batch(items).await {
            Ok(result) => response_json(StatusCode::OK, analysis_response_payload(result)),
            Err(error) => response_json(
                StatusCode::BAD_GATEWAY,
                json!({
                    "error": {"code": "analysis_unavailable", "message": format!("Analisis Python tidak dapat dijangkau: {error}")}
                }),
            ),
        }
    }

    async fn analyze_dashboard_stats(&self, request: Request) -> Response {
        let client = self.analysis.as_ref();
        let scope = match self.auth.authorize_scope(request.headers().clone()).await {
            Ok(scope) => scope,
            Err(response) => return response,
        };
        let body = match to_bytes(request.into_body(), MAX_SERVICE_BODY_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return response_json(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({"error": {"code": "payload_too_large", "message": "Dataset dashboard terlalu besar."}}),
                );
            }
        };
        let input = match serde_json::from_slice::<DashboardAnalysisInput>(&body) {
            Ok(input)
                if valid_iso_date(&input.month_start)
                    && valid_iso_date(&input.month_end)
                    && valid_iso_date(&input.previous_month_start)
                    && valid_iso_date(&input.previous_month_end)
                    && valid_age_group(&input.age_group) =>
            {
                input
            }
            _ => {
                return response_json(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error": {"code": "invalid_payload", "message": "Periode dashboard tidak valid."}}),
                );
            }
        };

        let scoped_village = scope.desa.clone().filter(|value| !value.trim().is_empty());
        let scoped_posyandu = scope
            .posyandu
            .clone()
            .filter(|value| !value.trim().is_empty());
        let village = if is_full_access_role(&scope.role) {
            input
                .village
                .clone()
                .filter(|value| !value.trim().is_empty())
        } else {
            scoped_village.clone()
        };
        let posyandu = if is_full_access_role(&scope.role) {
            input
                .posyandu
                .clone()
                .filter(|value| !value.trim().is_empty())
        } else if scope.role == "Kader Posyandu" {
            scoped_posyandu.clone()
        } else {
            input
                .posyandu
                .clone()
                .filter(|value| !value.trim().is_empty())
        };

        // A completed Python snapshot is the fast read path for dashboard
        // aggregates.  Its scope version is checked by PostgreSQL; after any
        // raw mutation the version changes and this intentionally falls
        // through to Python until the outbox worker publishes a fresh result.
        let snapshot_scope = dashboard_scope_key(village.as_deref(), posyandu.as_deref());
        let snapshot_request = json!({
            "p_cache_key": dashboard_cache_key(
                &snapshot_scope,
                &input.month_start,
                &input.month_end,
                &input.previous_month_start,
                &input.previous_month_end,
                &input.age_group,
            ),
            "p_scope_key": snapshot_scope,
            "p_month_start": input.month_start,
            "p_month_end": input.month_end,
            "p_previous_month_start": input.previous_month_start,
            "p_previous_month_end": input.previous_month_end,
            "p_age_group": input.age_group,
            "p_village": village,
            "p_posyandu": posyandu,
        });
        let snapshot = self
            .database
            .rpc("eposyandu_dashboard_snapshot", snapshot_request.clone())
            .await;
        if let Ok(value) = snapshot
            && value.get("hit").and_then(Value::as_bool) == Some(true)
            && let Some(result) = value.get("result").cloned()
        {
            return response_json(StatusCode::OK, result);
        }

        // Keep the last persisted result available while Python catches up
        // after a write or during a temporary analysis-service outage.  The
        // exact dashboard key and filter dates still match; only the scope
        // version check is relaxed by this fallback function.
        let stale_snapshot = self
            .database
            .rpc("eposyandu_dashboard_snapshot_latest", snapshot_request)
            .await
            .ok()
            .and_then(|value| stale_snapshot_result(&value));

        let input_request = json!({
            "p_month_start": input.month_start,
            "p_month_end": input.month_end,
            "p_previous_month_start": input.previous_month_start,
            "p_previous_month_end": input.previous_month_end,
            "p_age_group": input.age_group,
            "p_village": village,
            "p_posyandu": posyandu,
            "p_role": scope.role,
            "p_scope_village": scoped_village,
            "p_scope_posyandu": scoped_posyandu,
        });
        // The preferred path is one PostgreSQL snapshot.  It returns only the
        // fields needed by Python plus non-clinical input counts, avoiding two
        // sequential full-table reads and keeping the child/measurement view
        // internally consistent.
        let sourced = match self
            .database
            .rpc("eposyandu_dashboard_dataset", input_request)
            .await
        {
            Ok(value)
                if value.as_object().is_some_and(|object| {
                    object.get("children").is_some_and(Value::is_array)
                        && object.get("measurements").is_some_and(Value::is_array)
                }) =>
            {
                value
            }
            // Older databases may not have migration 036 yet.  Keep the
            // service usable during a rolling migration with narrow, parallel
            // projections; Python still performs the same calculations.
            _ => {
                let mut child_parameters = vec![
                    ("select".to_owned(), DASHBOARD_CHILD_SELECT.to_owned()),
                    ("birth_date".to_owned(), format!("lte.{}", input.month_end)),
                ];
                if let Some(value) = village.as_deref() {
                    child_parameters.push(("village".to_owned(), format!("eq.{value}")));
                }
                if let Some(value) = posyandu.as_deref() {
                    child_parameters.push(("posyandu".to_owned(), format!("eq.{value}")));
                }
                let mut measurement_parameters = vec![
                    ("select".to_owned(), DASHBOARD_MEASUREMENT_SELECT.to_owned()),
                    (
                        "measurement_date".to_owned(),
                        format!("gte.{}", input.previous_month_start),
                    ),
                    (
                        "measurement_date".to_owned(),
                        format!("lte.{}", input.month_end),
                    ),
                ];
                if let Some(value) = village.as_deref() {
                    measurement_parameters
                        .push(("legacy_village".to_owned(), format!("eq.{value}")));
                }
                if let Some(value) = posyandu.as_deref() {
                    measurement_parameters
                        .push(("legacy_posyandu".to_owned(), format!("eq.{value}")));
                }
                let (children, measurements) = tokio::join!(
                    self.database.get("children", &child_parameters, false),
                    self.database
                        .get("measurements", &measurement_parameters, false),
                );
                let children = match children {
                    Ok(result) => result.value,
                    Err(_) => {
                        if let Some(result) = stale_snapshot.clone() {
                            return response_json(StatusCode::OK, result);
                        }
                        return response_json(
                            StatusCode::SERVICE_UNAVAILABLE,
                            json!({"error": {"code": "database_unavailable", "message": "Data balita untuk analisis dashboard tidak tersedia."}}),
                        );
                    }
                };
                let measurements = match measurements {
                    Ok(result) => result.value,
                    Err(_) => {
                        if let Some(result) = stale_snapshot.clone() {
                            return response_json(StatusCode::OK, result);
                        }
                        return response_json(
                            StatusCode::SERVICE_UNAVAILABLE,
                            json!({"error": {"code": "database_unavailable", "message": "Data pengukuran untuk analisis dashboard tidak tersedia."}}),
                        );
                    }
                };
                json!({
                    "children": children,
                    "measurements": measurements,
                    "technical": {"source": "postgresql-projection-rust-fallback-v1"},
                })
            }
        };
        let sourced = sourced.as_object();
        let children = sourced
            .and_then(|value| value.get("children"))
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let measurements = sourced
            .and_then(|value| value.get("measurements"))
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let asi_children = sourced
            .and_then(|value| value.get("asiChildren"))
            .cloned()
            // Older dashboard projections do not expose the independent
            // six-month cohort. Python falls back to the selected cohort in
            // that rolling-migration case.
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let asi_measurements = sourced
            .and_then(|value| value.get("asiMeasurements"))
            .cloned()
            // Older dashboard projections do not expose the compact ASI
            // history. Python will safely use the period measurements in
            // that rolling-migration case.
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let technical = sourced
            .and_then(|value| value.get("technical"))
            .cloned()
            .unwrap_or_else(|| json!({"source": "postgresql-projection-v1"}));
        let dataset = json!({
            "operation": "dashboard_stats",
            "monthStart": input.month_start,
            "monthEnd": input.month_end,
            "previousMonthStart": input.previous_month_start,
            "previousMonthEnd": input.previous_month_end,
            "ageGroup": input.age_group,
            "village": village,
            "posyandu": posyandu,
            "role": scope.role,
            "scopeVillage": scoped_village,
            "scopePosyandu": scoped_posyandu,
            "children": children,
            "measurements": measurements,
            "asiChildren": asi_children,
            "asiMeasurements": asi_measurements,
            "technical": technical,
        });
        let Some(client) = client else {
            if let Some(result) = stale_snapshot {
                return response_json(StatusCode::OK, result);
            }
            return response_json(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "error": {"code": "analysis_unavailable", "message": "Analisis Python belum aktif."}
                }),
            );
        };
        match client.analyze_dataset(dataset).await {
            Ok(result) => response_json(StatusCode::OK, result),
            Err(error) => stale_snapshot.map_or_else(
                || {
                    response_json(
                        StatusCode::BAD_GATEWAY,
                        json!({"error": {"code": "analysis_unavailable", "message": format!("Analisis dashboard Python tidak dapat dijangkau: {error}")}}),
                    )
                },
                |result| response_json(StatusCode::OK, result),
            ),
        }
    }

    /// Select one page in PostgreSQL, then send only those children and their
    /// relevant measurement history to Python.  The database RPC is used only
    /// for scope/order/page selection; Python still recalculates every status
    /// and derived field before the response is returned.
    async fn page_limited_children_data(
        &self,
        as_of: &str,
        measurement_start: &str,
        measurement_end: &str,
        history_start: &str,
        age_group: &str,
        page: usize,
        size: usize,
        sort: &str,
        view: &str,
        search: Option<&str>,
        village: Option<&str>,
        posyandu: Option<&str>,
        scope_role: &str,
        scope_village: Option<&str>,
        scope_posyandu: Option<&str>,
    ) -> Result<(Value, Value, Value, i64), String> {
        let page_request = json!({
            "p_as_of": as_of,
            "p_measurement_start": measurement_start,
            "p_measurement_end": measurement_end,
            "p_page": page,
            "p_size": size,
            "p_sort": sort,
            "p_view": view,
            "p_search": search,
            "p_village": village,
            "p_posyandu": posyandu,
            // The SQL RPC treats Ahli Gizi as the full-access role;
            // super_admin is normalized here after Rust auth checks.
            "p_role": if is_full_access_role(scope_role) { "Ahli Gizi" } else { scope_role },
            "p_scope_village": scope_village,
            "p_scope_posyandu": scope_posyandu,
            "p_age_group": age_group,
        });
        // Migration 039 adds the age-aware 14-argument overload. During a
        // rolling deployment an older database may still expose only the
        // 13-argument function; its MPASI branch already applies the fixed
        // 6–23-month cohort, so retry that legacy signature rather than
        // falling back to a full-table Python request.
        let selected = match self
            .database
            .rpc("eposyandu_replica_children_page", page_request)
            .await
        {
            Ok(value) => value,
            Err(new_error) => self
                .database
                .rpc(
                    "eposyandu_replica_children_page",
                    json!({
                        "p_as_of": as_of,
                        "p_measurement_start": measurement_start,
                        "p_measurement_end": measurement_end,
                        "p_page": page,
                        "p_size": size,
                        "p_sort": sort,
                        "p_view": view,
                        "p_search": search,
                        "p_village": village,
                        "p_posyandu": posyandu,
                        "p_role": if is_full_access_role(scope_role) { "Ahli Gizi" } else { scope_role },
                        "p_scope_village": scope_village,
                        "p_scope_posyandu": scope_posyandu,
                    }),
                )
                .await
                .map_err(|legacy_error| {
                    format!(
                        "Pemilihan halaman database gagal (age-aware: {new_error:?}; legacy: {legacy_error:?})"
                    )
                })?,
        };
        let selected = selected
            .as_object()
            .ok_or_else(|| "Respons halaman database tidak valid.".to_owned())?;
        let selected_items = selected
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let total = selected
            .get("total")
            .and_then(Value::as_i64)
            .or_else(|| {
                selected
                    .get("total")
                    .and_then(Value::as_u64)
                    .map(|value| value as i64)
            })
            .unwrap_or(selected_items.len() as i64);

        let mut child_rows = Vec::with_capacity(selected_items.len());
        let mut child_ids = Vec::with_capacity(selected_items.len());
        for item in selected_items {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let mut child = item.get("data").cloned().unwrap_or_else(|| json!({}));
            let Some(child_object) = child.as_object_mut() else {
                continue;
            };
            child_object.insert("id".to_owned(), Value::String(id.to_owned()));
            child_rows.push(Value::Object(child_object.clone()));
            child_ids.push(id.to_owned());
        }

        let mut measurement_rows = Vec::new();
        let date_parameters = [
            (
                "measurement_date".to_owned(),
                format!("gte.{history_start}"),
            ),
            (
                "measurement_date".to_owned(),
                format!("lte.{measurement_end}"),
            ),
            ("select".to_owned(), PAGE_MEASUREMENT_SELECT.to_owned()),
        ];
        if let Some(ids) = id_list_filter(&child_ids) {
            let mut child_parameters = date_parameters.to_vec();
            child_parameters.push(("child_id".to_owned(), ids.clone()));
            let mut legacy_parameters = date_parameters.to_vec();
            legacy_parameters.push(("legacy_child_id".to_owned(), ids));
            let (child_result, legacy_result) = tokio::join!(
                self.database.get("measurements", &child_parameters, false),
                self.database.get("measurements", &legacy_parameters, false),
            );
            for result in [child_result, legacy_result] {
                let result = result
                    .map_err(|error| format!("Riwayat pengukuran database gagal: {error:?}"))?;
                append_unique_rows(&mut measurement_rows, result.value);
            }
        }

        let mut mpasi_rows = Vec::new();
        if view == "mpasi" {
            if let Some(ids) = id_list_filter(&child_ids) {
                let date_parameters = [
                    (
                        "monitoring_date".to_owned(),
                        format!("gte.{measurement_start}"),
                    ),
                    (
                        "monitoring_date".to_owned(),
                        format!("lte.{measurement_end}"),
                    ),
                    ("select".to_owned(), PAGE_MPASI_SELECT.to_owned()),
                ];
                let mut child_parameters = date_parameters.to_vec();
                child_parameters.push(("child_id".to_owned(), ids.clone()));
                let mut legacy_parameters = date_parameters.to_vec();
                legacy_parameters.push(("legacy_child_id".to_owned(), ids));
                let (child_result, legacy_result) = tokio::join!(
                    self.database.get("mpasi_logs", &child_parameters, false),
                    self.database.get("mpasi_logs", &legacy_parameters, false),
                );
                for result in [child_result, legacy_result] {
                    let result = result
                        .map_err(|error| format!("Riwayat MPASI database gagal: {error:?}"))?;
                    append_unique_rows(&mut mpasi_rows, result.value);
                }
            }
        }

        Ok((
            Value::Array(child_rows),
            Value::Array(measurement_rows),
            Value::Array(mpasi_rows),
            total,
        ))
    }

    async fn children_page_python(&self, request: Request) -> Response {
        let scope = match self.auth.authorize_scope(request.headers().clone()).await {
            Ok(scope) => scope,
            Err(response) => return response,
        };
        let query =
            url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
                .into_owned()
                .collect::<BTreeMap<_, _>>();
        let as_of = query.get("asOf").map(String::as_str).unwrap_or_default();
        let measurement_start = query
            .get("measurementStart")
            .map(String::as_str)
            .unwrap_or_default();
        let history_start = query
            .get("historyStart")
            .map(String::as_str)
            .unwrap_or("1900-01-01");
        let measurement_end = query
            .get("measurementEnd")
            .map(String::as_str)
            .unwrap_or_default();
        let requested_age_group = query.get("ageGroup").map(String::as_str).unwrap_or("0-59");
        if !valid_iso_date(as_of)
            || !valid_iso_date(measurement_start)
            || !valid_iso_date(measurement_end)
            || !valid_iso_date(history_start)
            || !valid_age_group(requested_age_group)
        {
            return response_json(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": {"code": "invalid_query", "message": "Periode halaman balita tidak valid."}}),
            );
        }
        let previous_start = query
            .get("previousMonthStart")
            .map(String::as_str)
            .unwrap_or(measurement_start);
        let previous_end = query
            .get("previousMonthEnd")
            .map(String::as_str)
            .unwrap_or(measurement_start);
        if !valid_iso_date(previous_start) || !valid_iso_date(previous_end) {
            return response_json(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": {"code": "invalid_query", "message": "Periode riwayat halaman balita tidak valid."}}),
            );
        }
        let page = query
            .get("page")
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(1);
        let size = query
            .get("size")
            .and_then(|value| value.parse::<usize>().ok())
            .map(|value| value.clamp(1, 50))
            .unwrap_or(10);
        let view = query.get("view").map(String::as_str).unwrap_or("data");
        let allowed_views = [
            "data",
            "recent",
            "recycle",
            "mpasi",
            "problem_underweight",
            "problem_stunting",
            "problem_wasting",
            "problem_tidak_naik",
        ];
        if !allowed_views.contains(&view) {
            return response_json(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": {"code": "invalid_query", "message": "Filter halaman balita tidak dikenal."}}),
            );
        }
        // MPASI is a fixed 6–23-month programme cohort; the frontend hides
        // the age selector, and the API enforces the same rule for callers
        // that bypass the UI.
        let age_group = if view == "mpasi" {
            "6-23"
        } else {
            requested_age_group
        };
        let sort = query.get("sort").map(String::as_str).unwrap_or("recent");
        let allowed_sorts = [
            "recent",
            "oldest_input",
            "name_asc",
            "name_desc",
            "age_oldest",
            "age_youngest",
        ];
        if !allowed_sorts.contains(&sort) {
            return response_json(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": {"code": "invalid_query", "message": "Urutan halaman balita tidak dikenal."}}),
            );
        }
        if query
            .get("search")
            .map(|value| value.chars().count() > 80)
            .unwrap_or(false)
        {
            return response_json(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": {"code": "invalid_query", "message": "Pencarian terlalu panjang."}}),
            );
        }
        let requested_village = query
            .get("village")
            .cloned()
            .filter(|value| !value.trim().is_empty());
        let requested_posyandu = query
            .get("posyandu")
            .cloned()
            .filter(|value| !value.trim().is_empty());
        let scoped_village = scope.desa.clone().filter(|value| !value.trim().is_empty());
        let scoped_posyandu = scope
            .posyandu
            .clone()
            .filter(|value| !value.trim().is_empty());
        let village = if is_full_access_role(&scope.role) {
            requested_village
        } else {
            scoped_village.clone()
        };
        let posyandu = if is_full_access_role(&scope.role) {
            requested_posyandu
        } else if scope.role == "Kader Posyandu" {
            scoped_posyandu.clone()
        } else {
            requested_posyandu
        };

        // The materialized SQL projection applies every named age cohort
        // before pagination. MPASI is always page-limited because its only
        // supported cohort is 6–23 months; this prevents a rolling migration
        // or a temporary materialized-read miss from sending the entire
        // child population to Python.
        let page_limited = (age_group == "0-59" && matches!(view, "data" | "recent" | "recycle"))
            || view == "mpasi";
        // Once migration 037 is present, reads use the PostgreSQL materialized
        // projection directly.  Python has already populated each row after
        // the raw write; a pending row is explicitly marked by SQL rather than
        // blocking a kader request on a full re-analysis.  During a rolling
        // migration an absent function falls back to the Python path below.
        let materialized = {
            self
            .database
            .rpc(
                "eposyandu_materialized_children_page",
                json!({
                    "p_as_of": as_of,
                    "p_measurement_start": measurement_start,
                    "p_measurement_end": measurement_end,
                    "p_page": page,
                    "p_size": size,
                    "p_sort": sort,
                    "p_view": view,
                    "p_search": query.get("search"),
                    "p_village": village,
                    "p_posyandu": posyandu,
                    "p_role": if is_full_access_role(&scope.role) { "Ahli Gizi" } else { scope.role.as_str() },
                    "p_scope_village": scoped_village,
                    "p_scope_posyandu": scoped_posyandu,
                    "p_age_group": age_group,
                }),
            )
            .await
        };
        if let Ok(value) = materialized
            && value
                .as_object()
                .is_some_and(|object| object.get("items").is_some())
        {
            return response_json(StatusCode::OK, value);
        }

        // If the materialized projection is unavailable, keep table reads
        // independent from Python. PostgreSQL still performs scope, age,
        // ordering, status filtering, and page selection. Problem tabs have
        // their own RPC; normal tabs use the read-replica RPC. The legacy
        // arities are tried only during a rolling migration.
        let read_fallback = if view.starts_with("problem_") {
            let problem_payload = json!({
                "p_month_start": measurement_start,
                "p_month_end": measurement_end,
                "p_problem": view,
                "p_page": page,
                "p_size": size,
                "p_search": query.get("search"),
                "p_sort": sort,
                "p_village": village,
                "p_posyandu": posyandu,
                "p_role": if is_full_access_role(&scope.role) { "Ahli Gizi" } else { scope.role.as_str() },
                "p_scope_village": scoped_village,
                "p_scope_posyandu": scoped_posyandu,
                "p_age_group": age_group,
            });
            match self
                .database
                .rpc("eposyandu_problem_children_page", problem_payload.clone())
                .await
            {
                Ok(value) => Some(value),
                Err(_) => self
                    .database
                    .rpc("eposyandu_problem_children_page_legacy", problem_payload)
                    .await
                    .ok(),
            }
        } else {
            let replica_payload = json!({
                "p_as_of": as_of,
                "p_measurement_start": measurement_start,
                "p_measurement_end": measurement_end,
                "p_page": page,
                "p_size": size,
                "p_sort": sort,
                "p_view": view,
                "p_search": query.get("search"),
                "p_village": village,
                "p_posyandu": posyandu,
                "p_role": if is_full_access_role(&scope.role) { "Ahli Gizi" } else { scope.role.as_str() },
                "p_scope_village": scoped_village,
                "p_scope_posyandu": scoped_posyandu,
                "p_age_group": age_group,
            });
            match self
                .database
                .rpc("eposyandu_replica_children_page", replica_payload.clone())
                .await
            {
                Ok(value) => Some(value),
                Err(_) if age_group == "0-59" => self
                    .database
                    .rpc("eposyandu_replica_children_page_legacy", replica_payload)
                    .await
                    .ok(),
                Err(_) => None,
            }
        };
        if let Some(value) = read_fallback.filter(|value| {
            value
                .as_object()
                .is_some_and(|object| object.get("items").is_some())
        }) {
            return if view.starts_with("problem_") {
                response_json(StatusCode::OK, value)
            } else {
                response_json(StatusCode::OK, mark_page_read_fallback(value))
            };
        }

        // A materialized read does not require a live Python connection.  Only
        // the rolling-migration fallback below needs the analysis client.
        let Some(client) = self.analysis.as_ref() else {
            return response_json(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "error": {"code": "analysis_unavailable", "message": "Analisis Python belum aktif dan proyeksi database belum tersedia."}
                }),
            );
        };
        let (children, measurements, mpasi_logs, total_hint) = if page_limited {
            match self
                .page_limited_children_data(
                    as_of,
                    measurement_start,
                    measurement_end,
                    history_start,
                    age_group,
                    page,
                    size,
                    sort,
                    view,
                    query.get("search").map(String::as_str),
                    village.as_deref(),
                    posyandu.as_deref(),
                    &scope.role,
                    scoped_village.as_deref(),
                    scoped_posyandu.as_deref(),
                )
                .await
            {
                Ok(data) => data,
                Err(message) => {
                    return response_json(
                        StatusCode::SERVICE_UNAVAILABLE,
                        json!({"error": {"code": "database_unavailable", "message": message}}),
                    );
                }
            }
        } else {
            // Problem tabs need the complete scoped history so Python can
            // determine which children match the requested status.  The
            // regular data/recent/recycle/mpasi tabs above remain page-limited.
            let mut child_parameters = vec![
                ("select".to_owned(), "*".to_owned()),
                ("birth_date".to_owned(), format!("lte.{as_of}")),
            ];
            if let Some(value) = village.as_deref() {
                child_parameters.push(("village".to_owned(), format!("eq.{value}")));
            }
            if let Some(value) = posyandu.as_deref() {
                child_parameters.push(("posyandu".to_owned(), format!("eq.{value}")));
            }
            let mut measurement_parameters = vec![
                ("select".to_owned(), "*".to_owned()),
                (
                    "measurement_date".to_owned(),
                    format!("gte.{history_start}"),
                ),
                (
                    "measurement_date".to_owned(),
                    format!("lte.{measurement_end}"),
                ),
            ];
            if let Some(value) = village.as_deref() {
                measurement_parameters.push(("legacy_village".to_owned(), format!("eq.{value}")));
            }
            if let Some(value) = posyandu.as_deref() {
                measurement_parameters.push(("legacy_posyandu".to_owned(), format!("eq.{value}")));
            }
            let children = match self
                .database
                .get("children", &child_parameters, false)
                .await
            {
                Ok(result) => result.value,
                Err(_) => {
                    return response_json(
                        StatusCode::SERVICE_UNAVAILABLE,
                        json!({"error": {"code": "database_unavailable", "message": "Data balita untuk analisis Python tidak tersedia."}}),
                    );
                }
            };
            let measurements = match self
                .database
                .get("measurements", &measurement_parameters, false)
                .await
            {
                Ok(result) => result.value,
                Err(_) => {
                    return response_json(
                        StatusCode::SERVICE_UNAVAILABLE,
                        json!({"error": {"code": "database_unavailable", "message": "Data pengukuran untuk analisis Python tidak tersedia."}}),
                    );
                }
            };
            let mpasi_parameters = vec![
                ("select".to_owned(), "*".to_owned()),
                (
                    "monitoring_date".to_owned(),
                    format!("gte.{measurement_start}"),
                ),
                (
                    "monitoring_date".to_owned(),
                    format!("lte.{measurement_end}"),
                ),
            ];
            let mpasi_logs = match self
                .database
                .get("mpasi_logs", &mpasi_parameters, false)
                .await
            {
                Ok(result) => result.value,
                Err(_) => Value::Array(Vec::new()),
            };
            (children, measurements, mpasi_logs, -1)
        };
        let dataset = json!({
            "operation": "children_page",
            "asOf": as_of,
            "measurementStart": measurement_start,
            "historyStart": history_start,
            "measurementEnd": measurement_end,
            "ageGroup": age_group,
            "previousMonthStart": previous_start,
            "previousMonthEnd": previous_end,
            "page": page,
            "size": size,
            "sort": sort,
            "view": view,
            "search": query.get("search"),
            "village": village,
            "posyandu": posyandu,
            "role": scope.role,
            "scopeVillage": scoped_village,
            "scopePosyandu": scoped_posyandu,
            "children": children,
            "measurements": measurements,
            "mpasiLogs": mpasi_logs,
            "pageLimited": page_limited,
            "totalHint": (total_hint >= 0).then_some(total_hint),
        });
        match client.analyze_dataset(dataset).await {
            Ok(result) => response_json(StatusCode::OK, result),
            Err(error) => response_json(
                StatusCode::BAD_GATEWAY,
                json!({"error": {"code": "analysis_unavailable", "message": format!("Analisis tabel Python tidak dapat dijangkau: {error}")}}),
            ),
        }
    }

    async fn exclusive_breastfeeding_page_python(&self, request: Request) -> Response {
        let scope = match self.auth.authorize_scope(request.headers().clone()).await {
            Ok(scope) => scope,
            Err(response) => return response,
        };
        let query =
            url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
                .into_owned()
                .collect::<BTreeMap<_, _>>();
        let start = query
            .get("measurementStart")
            .map(String::as_str)
            .unwrap_or_default();
        let end = query
            .get("measurementEnd")
            .map(String::as_str)
            .unwrap_or_default();
        let history_start = query
            .get("historyStart")
            .map(String::as_str)
            .unwrap_or("1900-01-01");
        let age_group = query
            .get("ageGroup")
            .map(String::as_str)
            .unwrap_or_default();
        if !valid_iso_date(start)
            || !valid_iso_date(end)
            || !valid_iso_date(history_start)
            || !valid_exclusive_breastfeeding_age_group(age_group)
        {
            return response_json(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": {"code": "invalid_query", "message": "Parameter ASI eksklusif tidak valid."}}),
            );
        }
        let page = query
            .get("page")
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(1);
        let size = query
            .get("size")
            .and_then(|value| value.parse::<usize>().ok())
            .map(|value| value.clamp(1, 50))
            .unwrap_or(10);
        let scoped_village = scope.desa.clone().filter(|value| !value.trim().is_empty());
        let scoped_posyandu = scope
            .posyandu
            .clone()
            .filter(|value| !value.trim().is_empty());
        let village = if is_full_access_role(&scope.role) {
            query
                .get("village")
                .cloned()
                .filter(|value| !value.trim().is_empty())
        } else {
            scoped_village.clone()
        };
        let posyandu = if is_full_access_role(&scope.role) {
            query
                .get("posyandu")
                .cloned()
                .filter(|value| !value.trim().is_empty())
        } else if scope.role == "Kader Posyandu" {
            scoped_posyandu.clone()
        } else {
            query
                .get("posyandu")
                .cloned()
                .filter(|value| !value.trim().is_empty())
        };
        if let Ok(value) = self
            .database
            .rpc(
                "eposyandu_materialized_exclusive_breastfeeding_page",
                json!({
                    "p_measurement_start": start,
                    "p_measurement_end": end,
                    "p_age_group": age_group,
                    "p_page": page,
                    "p_size": size,
                    "p_village": village,
                    "p_posyandu": posyandu,
                    "p_role": if is_full_access_role(&scope.role) { "Ahli Gizi" } else { scope.role.as_str() },
                    "p_scope_village": scoped_village,
                    "p_scope_posyandu": scoped_posyandu,
                }),
            )
            .await
            && value.as_object().is_some_and(|object| object.get("items").is_some())
        {
            return response_json(StatusCode::OK, value);
        }

        // Keep the ASI page readable from PostgreSQL during a rolling
        // migration or while Python is restarting. The legacy SQL function
        // is read-only; once the materialized projection is available it is
        // still the preferred path above.
        if let Ok(value) = self
            .database
            .rpc(
                "eposyandu_exclusive_breastfeeding_page",
                json!({
                    "p_measurement_start": start,
                    "p_measurement_end": end,
                    "p_age_group": age_group,
                    "p_page": page,
                    "p_size": size,
                    "p_village": village,
                    "p_posyandu": posyandu,
                    "p_role": if is_full_access_role(&scope.role) { "Ahli Gizi" } else { scope.role.as_str() },
                    "p_scope_village": scoped_village,
                    "p_scope_posyandu": scoped_posyandu,
                }),
            )
            .await
            && value
                .as_object()
                .is_some_and(|object| object.get("items").is_some())
        {
            return response_json(StatusCode::OK, mark_page_read_fallback(value));
        }

        let Some(client) = self.analysis.as_ref() else {
            return response_json(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": {"code": "analysis_unavailable", "message": "Analisis Python belum aktif dan proyeksi ASI belum tersedia."}}),
            );
        };
        let mut child_parameters = vec![
            ("select".to_owned(), "*".to_owned()),
            ("birth_date".to_owned(), format!("lte.{end}")),
        ];
        if let Some(value) = village.as_deref() {
            child_parameters.push(("village".to_owned(), format!("eq.{value}")));
        }
        if let Some(value) = posyandu.as_deref() {
            child_parameters.push(("posyandu".to_owned(), format!("eq.{value}")));
        }
        let mut measurement_parameters = vec![
            ("select".to_owned(), "*".to_owned()),
            (
                "measurement_date".to_owned(),
                format!("gte.{history_start}"),
            ),
            ("measurement_date".to_owned(), format!("lte.{end}")),
        ];
        if let Some(value) = village.as_deref() {
            measurement_parameters.push(("legacy_village".to_owned(), format!("eq.{value}")));
        }
        if let Some(value) = posyandu.as_deref() {
            measurement_parameters.push(("legacy_posyandu".to_owned(), format!("eq.{value}")));
        }
        let children = match self
            .database
            .get("children", &child_parameters, false)
            .await
        {
            Ok(result) => result.value,
            Err(_) => {
                return response_json(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error": {"code": "database_unavailable", "message": "Data balita untuk analisis ASI tidak tersedia."}}),
                );
            }
        };
        let measurements = match self
            .database
            .get("measurements", &measurement_parameters, false)
            .await
        {
            Ok(result) => result.value,
            Err(_) => {
                return response_json(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error": {"code": "database_unavailable", "message": "Data pengukuran untuk analisis ASI tidak tersedia."}}),
                );
            }
        };
        let dataset = json!({
            "operation": "exclusive_breastfeeding_page",
            "measurementStart": start,
            "historyStart": history_start,
            "measurementEnd": end,
            "ageGroup": age_group,
            "page": page,
            "size": size,
            "village": village,
            "posyandu": posyandu,
            "role": scope.role,
            "scopeVillage": scoped_village,
            "scopePosyandu": scoped_posyandu,
            "children": children,
            "measurements": measurements,
        });
        match client.analyze_dataset(dataset).await {
            Ok(result) => response_json(StatusCode::OK, result),
            Err(error) => response_json(
                StatusCode::BAD_GATEWAY,
                json!({"error": {"code": "analysis_unavailable", "message": format!("Analisis ASI Python tidak dapat dijangkau: {error}")}}),
            ),
        }
    }

    async fn render_growth_chart(&self, request: Request) -> Response {
        let Some(client) = self.analysis.as_ref() else {
            return response_json(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "error": {"code": "analysis_unavailable", "message": "Analisis Python belum aktif."}
                }),
            );
        };
        if let Err(response) = self.auth.authorize_scope(request.headers().clone()).await {
            return response;
        }
        let body = match to_bytes(request.into_body(), MAX_SERVICE_BODY_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return response_json(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({
                        "error": {"code": "payload_too_large", "message": "Data grafik terlalu besar."}
                    }),
                );
            }
        };
        let input = match serde_json::from_slice::<GrowthChartInput>(&body) {
            Ok(input) => input,
            Err(_) => {
                return response_json(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({
                        "error": {"code": "invalid_payload", "message": "Payload grafik tidak valid."}
                    }),
                );
            }
        };
        let chart = match chart_request(input) {
            Ok(chart) => chart,
            Err(message) => {
                return response_json(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error": {"code": "invalid_payload", "message": message}}),
                );
            }
        };
        match client.render_growth_chart(chart).await {
            Ok(result) => response_json(
                StatusCode::OK,
                json!({
                    "chartType": result.chart_type,
                    "svg": result.svg,
                    "standardsVersion": result.standards_version,
                    "renderer": result.renderer
                }),
            ),
            Err(error) => response_json(
                StatusCode::BAD_GATEWAY,
                json!({
                    "error": {"code": "analysis_unavailable", "message": format!("Renderer Python tidak dapat dijangkau: {error}")}
                }),
            ),
        }
    }

    pub async fn cleanup_retention(&self) -> bool {
        let cleaned = self.database.cleanup_retention().await.is_ok();
        if cleaned {
            self.api.invalidate_dynamic_cache().await;
        }
        cleaned
    }
}

/// Read-only domain used by the gateway's read service. It shares the audited
/// handlers with the legacy operations domain but constructs NativeApi with
/// writes disabled, making the boundary enforceable in-process as well as at
/// the gRPC level.
pub struct ReadDomain {
    inner: OperationsDomain,
}

impl ReadDomain {
    pub async fn from_env() -> Result<Self, String> {
        Ok(Self {
            inner: OperationsDomain::from_env_with_modes(true, false, "read-service").await?,
        })
    }

    /// Keep the read service's Redis version in sync with PostgreSQL writes
    /// and Python materialization commits.  ReadService is intentionally
    /// write-free, so it needs its own LISTEN connection for cache invalidation
    /// when it runs as a separate process.
    pub fn start_cache_invalidation_listener(&self) {
        let database = self.inner.database.clone();
        let cache = self.inner.api.cache_handle();
        tokio::spawn(async move {
            database.listen_realtime(RealtimeHub::new(), cache).await;
        });
    }

    pub async fn handle(&self, request: Request) -> Response {
        self.inner.handle_read(request).await
    }
}

/// Write-only domain used by the gateway's write service. Read routes are
/// rejected before reaching NativeApi; writes still use the same transactional
/// outbox and realtime invalidation path as the legacy operations service.
pub struct WriteDomain {
    inner: OperationsDomain,
}

impl WriteDomain {
    pub async fn from_env() -> Result<Self, String> {
        Ok(Self {
            inner: OperationsDomain::from_env_with_modes(false, true, "write-service").await?,
        })
    }

    pub async fn handle(&self, request: Request) -> Response {
        self.inner.handle_write(request).await
    }

    pub async fn cleanup_retention(&self) -> bool {
        self.inner.cleanup_retention().await
    }
}

pub struct MonitoringDomain {
    auth: Arc<NativeAuth>,
    database: Arc<NativeDatabase>,
    api: Arc<NativeApi>,
    sampler: tokio::sync::Mutex<SystemMetricsSampler>,
}

impl MonitoringDomain {
    pub async fn from_env() -> Result<Self, String> {
        let database = required_database()?;
        let auth = Arc::new(
            NativeAuth::from_env(client()?, Some(database.clone()))?.ok_or_else(|| {
                "ORACLE_API_NATIVE_AUTH_ENABLED wajib true pada monitoring-service.".to_owned()
            })?,
        );
        let api = NativeApi::from_env(
            client()?,
            auth.clone(),
            database.clone(),
            RealtimeHub::new(),
            true,
            true,
        )
        .await?;
        Ok(Self {
            auth,
            database,
            api: Arc::new(api),
            sampler: tokio::sync::Mutex::new(SystemMetricsSampler::new()),
        })
    }

    pub async fn snapshot(&self, headers: axum::http::HeaderMap) -> Result<Value, Response> {
        self.auth.require_verified_admin(headers).await?;
        let sample = self.sampler.lock().await.sample();
        let database = self.database.ready().await;
        let redis = self.api.cache_configured() && self.api.cache_ready().await;
        Ok(json!({
            "timestamp": sample.timestamp,
            "system": sample,
            "services": {
                "database": if database { "online" } else { "offline" },
                "redis": if redis { "online" } else { "offline" },
            }
        }))
    }
}

pub struct RealtimeDomain {
    auth: Arc<NativeAuth>,
    database: Arc<NativeDatabase>,
    hub: RealtimeHub,
}

#[cfg(test)]
mod analysis_contract_tests {
    use super::*;

    #[test]
    fn read_fallback_preserves_completed_analysis() {
        let result = mark_page_read_fallback(json!({
            "items": [{"id": "child-1", "data": {"nama": "Balita Uji"}}],
            "measurements": [{
                "id": "measurement-1",
                "data": {
                    "childId": "child-1",
                    "bbuStatus": "Berat Normal",
                    "analysisPending": false
                }
            }]
        }));
        assert_eq!(result["measurements"][0]["data"]["analysisPending"], false);
    }

    #[test]
    fn read_fallback_marks_only_unanalysed_rows_pending() {
        let result = mark_page_read_fallback(json!({
            "items": [],
            "measurements": [{
                "id": "measurement-1",
                "data": {"childId": "child-1", "bb": 5.2, "statusNaik": "B"}
            }]
        }));
        assert_eq!(result["measurements"][0]["data"]["analysisPending"], true);
    }

    #[test]
    fn pending_pages_are_not_eligible_for_dynamic_cache() {
        assert!(has_pending_analysis(&json!({
            "measurements": [{"data": {"analysisPending": true}}]
        })));
        assert!(!has_pending_analysis(&json!({
            "measurements": [{"data": {"analysisPending": false}}]
        })));
    }

    #[test]
    fn stale_snapshot_is_marked_without_changing_metrics() {
        let result = stale_snapshot_result(&json!({
            "hit": true,
            "result": {"S": 10, "D": 9},
            "sourceVersion": 4,
            "currentVersion": 5,
            "calculatedAt": "2026-09-06T00:00:00Z"
        }))
        .expect("snapshot result");
        assert_eq!(result["S"], 10);
        assert_eq!(result["snapshotStale"], true);
        assert_eq!(result["snapshotSourceVersion"], 4);
        assert_eq!(result["snapshotCurrentVersion"], 5);
    }

    #[test]
    fn chart_request_accepts_camel_case_frontend_payload() {
        let input: GrowthChartInput = serde_json::from_value(json!({
            "chartType": "bbu",
            "sex": "P",
            "childName": "Balita Uji",
            "points": [{"ageMonths": 6, "weightKg": 6.8, "measurementDate": "2026-08-01"}]
        }))
        .expect("payload chart valid");
        let request = chart_request(input).expect("chart request valid");
        assert_eq!(request.chart_type, "bbu");
        assert_eq!(request.points.len(), 1);
        assert_eq!(request.points[0].age_months, 6);
    }

    #[test]
    fn analysis_item_rejects_missing_weight_before_python_call() {
        let input: AnalysisItemInput = serde_json::from_value(json!({
            "ageMonths": 12,
            "sex": "L"
        }))
        .expect("payload valid JSON");
        let error = analysis_item_proto(input, 0).expect_err("weight should be required");
        assert!(error.contains("weightKg"));
    }
}

pub struct RealtimeAccess {
    scope: native_auth::AccessScope,
}

impl RealtimeDomain {
    pub fn from_env() -> Result<Self, String> {
        let database = required_database()?;
        let auth = NativeAuth::from_env(client()?, Some(database.clone()))?.ok_or_else(|| {
            "ORACLE_API_NATIVE_AUTH_ENABLED wajib true pada realtime-service.".to_owned()
        })?;
        let hub = RealtimeHub::new();
        Ok(Self {
            auth: Arc::new(auth),
            database,
            hub,
        })
    }

    pub fn start_listener(&self) {
        let database = self.database.clone();
        let hub = self.hub.clone();
        tokio::spawn(async move { database.listen_realtime(hub, None).await });
    }

    pub async fn authorize(
        &self,
        headers: axum::http::HeaderMap,
    ) -> Result<RealtimeAccess, Response> {
        self.auth
            .authorize_scope(headers)
            .await
            .map(|scope| RealtimeAccess { scope })
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<RealtimeEvent> {
        self.hub.subscribe()
    }

    pub fn event_for(
        &self,
        access: &RealtimeAccess,
        event: &RealtimeEvent,
    ) -> Option<e_posyandu_proto::proto::platform::v1::RealtimeEvent> {
        event.visible_to(&access.scope).then(|| {
            e_posyandu_proto::proto::platform::v1::RealtimeEvent {
                id: event.id.clone(),
                resource: event.resource.clone(),
                operation: event.operation.clone(),
                changed_at: event.changed_at.clone(),
            }
        })
    }
}
