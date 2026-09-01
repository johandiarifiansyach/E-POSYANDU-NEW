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

use std::{sync::Arc, time::Duration};

use axum::{
    body::{Body, to_bytes},
    extract::Request,
    http::{HeaderName, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use e_posyandu_proto::analysis::{
    CalculateBatchRequest, GrowthChartPoint, NutritionItem, RenderGrowthChartRequest,
    analysis_service_client::AnalysisServiceClient,
};
use e_posyandu_proto::proto::platform::v1::{HttpHeader, ServiceRequest, ServiceResponse};
use reqwest::{Client, redirect::Policy};
use serde::Deserialize;
use serde_json::{Value, json};
use tonic::{
    Request as GrpcRequest,
    metadata::{Ascii, MetadataValue},
    service::Interceptor,
    transport::{Channel, Endpoint},
};

use native_api::NativeApi;
use native_auth::NativeAuth;
use native_db::NativeDatabase;
use realtime::{RealtimeEvent, RealtimeHub};
use system_metrics::SystemMetricsSampler;

const MAX_SERVICE_BODY_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_ANALYSIS_GRPC_URL: &str = "unix:///run/e-posyandu/analysis.sock";
const ANALYSIS_TOKEN_HEADER: &str = "x-eposyandu-service-token";
const MAX_ANALYSIS_ITEMS: usize = 10_000;

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
        );
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
        );
        client
            .render_growth_chart(GrpcRequest::new(request))
            .await
            .map(|response| response.into_inner())
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
}

impl OperationsDomain {
    pub async fn from_env() -> Result<Self, String> {
        let database = required_database()?;
        let auth = NativeAuth::from_env(client()?, Some(database.clone()))?.ok_or_else(|| {
            "ORACLE_API_NATIVE_AUTH_ENABLED wajib true pada operations-service.".to_owned()
        })?;
        let realtime = RealtimeHub::new();
        let auth = Arc::new(auth);
        let api = NativeApi::from_env(
            client()?,
            auth.clone(),
            database.clone(),
            realtime,
            true,
            true,
        )
        .await?;
        Ok(Self {
            database,
            api: Arc::new(api),
            auth,
            analysis: AnalysisClient::from_env()?,
        })
    }

    pub async fn handle(&self, request: Request) -> Response {
        let (method, path) = method_path(&request);
        if method == Method::POST && path == "/api/v1/analysis/anthropometry" {
            return self.calculate_anthropometry(request).await;
        }
        if method == Method::POST && path == "/api/v1/analysis/growth-chart" {
            return self.render_growth_chart(request).await;
        }
        if self.api.handles(&request) {
            self.api.handle(request).await
        } else {
            not_found()
        }
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
        tokio::spawn(async move { database.listen_realtime(hub).await });
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
