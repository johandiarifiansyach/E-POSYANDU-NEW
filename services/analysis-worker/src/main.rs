use axum::{Router, routing::get};
use e_posyandu_proto::analysis::{
    AnalyzeDatasetRequest, AnalyzeDatasetResponse, CalculateBatchRequest, CalculateBatchResponse,
    GrowthChartPoint, NutritionAssessment, NutritionItem, RenderGrowthChartRequest,
    RenderGrowthChartResponse,
    analysis_service_server::{AnalysisService, AnalysisServiceServer},
};
use e_posyandu_proto::transport::{ListenAddress, bind_unix, parse_listen_address};
use pyo3::prelude::*;
use serde_json::{Map, Value, json};
use std::{env, io, time::Duration};
use tokio_stream::wrappers::UnixListenerStream;
use tonic::{
    Request, Response, Status,
    metadata::{Ascii, MetadataValue},
    service::Interceptor,
    transport::Server,
};

const TOKEN_HEADER: &str = "x-eposyandu-service-token";
const DEFAULT_GRPC_ADDR: &str = "unix:///run/e-posyandu/analysis.sock";
const DEFAULT_HTTP_PORT: u16 = 8082;
const DEFAULT_PERSISTENCE_INTERVAL: Duration = Duration::from_secs(1);
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
struct AuthInterceptor {
    token: MetadataValue<Ascii>,
}

impl Interceptor for AuthInterceptor {
    fn call(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
        let supplied = request
            .metadata()
            .get(TOKEN_HEADER)
            .ok_or_else(|| Status::unauthenticated("Token service analisis tidak ditemukan."))?;
        if supplied != &self.token {
            return Err(Status::unauthenticated(
                "Token service analisis tidak valid.",
            ));
        }
        Ok(request)
    }
}

fn service_auth() -> Result<AuthInterceptor, io::Error> {
    let value = env::var("RUST_WORKER_SHARED_SECRET")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| io::Error::other("RUST_WORKER_SHARED_SECRET wajib diisi."))?;
    let token = value
        .parse()
        .map_err(|_| io::Error::other("RUST_WORKER_SHARED_SECRET harus ASCII."))?;
    Ok(AuthInterceptor { token })
}

fn field_f64(item: &NutritionItem, name: &str) -> Option<f64> {
    match name {
        "height_cm" => item.height_cm,
        "lila_cm" => item.lila_cm,
        "head_circumference_cm" => item.head_circumference_cm,
        _ => None,
    }
}

fn point_field_f64(point: &GrowthChartPoint, name: &str) -> Option<f64> {
    match name {
        "height_cm" => point.height_cm,
        "lila_cm" => point.lila_cm,
        "head_circumference_cm" => point.head_circumference_cm,
        _ => None,
    }
}

fn json_number(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn item_payload(item: &NutritionItem) -> Result<Value, Status> {
    let history = if item.history_json.trim().is_empty() {
        Value::Array(Vec::new())
    } else {
        serde_json::from_str::<Value>(&item.history_json)
            .map_err(|_| Status::invalid_argument("Riwayat pengukuran tidak valid."))?
    };
    if !history.is_array() {
        return Err(Status::invalid_argument(
            "Riwayat pengukuran harus berupa array.",
        ));
    }
    let mut payload = Map::new();
    payload.insert("weight_kg".into(), json_number(item.weight_kg));
    payload.insert("age_months".into(), json!(item.age_months));
    payload.insert("sex".into(), json!(item.sex));
    payload.insert("row_number".into(), json!(item.row_number));
    payload.insert("record_id".into(), json!(item.record_id));
    payload.insert("nik".into(), json!(item.nik));
    payload.insert("history".into(), history);
    for (name, value) in [
        ("height_cm", field_f64(item, "height_cm")),
        ("lila_cm", field_f64(item, "lila_cm")),
        (
            "head_circumference_cm",
            field_f64(item, "head_circumference_cm"),
        ),
    ] {
        if let Some(value) = value {
            payload.insert(name.into(), json_number(value));
        }
    }
    if let Some(value) = item.measurement_method.as_ref() {
        payload.insert("measurement_method".into(), json!(value));
    }
    if let Some(value) = item.measurement_date.as_ref() {
        payload.insert("measurement_date".into(), json!(value));
    }
    if let Some(value) = item.exclusive_breastfeeding.as_ref() {
        payload.insert("exclusive_breastfeeding".into(), json!(value));
    }
    Ok(Value::Object(payload))
}

fn chart_point_payload(point: &GrowthChartPoint) -> Value {
    let mut payload = Map::new();
    payload.insert("age_months".into(), json!(point.age_months));
    payload.insert("weight_kg".into(), json_number(point.weight_kg));
    for (name, value) in [
        ("height_cm", point_field_f64(point, "height_cm")),
        ("lila_cm", point_field_f64(point, "lila_cm")),
        (
            "head_circumference_cm",
            point_field_f64(point, "head_circumference_cm"),
        ),
    ] {
        if let Some(value) = value {
            payload.insert(name.into(), json_number(value));
        }
    }
    if let Some(value) = point.measurement_method.as_ref() {
        payload.insert("measurement_method".into(), json!(value));
    }
    if let Some(value) = point.measurement_date.as_ref() {
        payload.insert("measurement_date".into(), json!(value));
    }
    if let Some(value) = point.weight_gain_status.as_ref() {
        payload.insert("weight_gain_status".into(), json!(value));
    }
    Value::Object(payload)
}

fn python_json(function: &'static str, payload: String) -> Result<String, String> {
    Python::attach(|py| {
        let module =
            PyModule::import(py, "analysis_service.embedded").map_err(|error| error.to_string())?;
        let result = module
            .getattr(function)
            .map_err(|error| error.to_string())?
            .call1((payload,))
            .map_err(|error| error.to_string())?;
        result
            .extract::<String>()
            .map_err(|error| error.to_string())
    })
}

async fn call_python(function: &'static str, payload: Value) -> Result<Value, Status> {
    let encoded = serde_json::to_string(&payload)
        .map_err(|error| Status::internal(format!("Payload Python tidak valid: {error}")))?;
    let output = tokio::task::spawn_blocking(move || python_json(function, encoded))
        .await
        .map_err(|error| Status::internal(format!("Worker Python berhenti: {error}")))?
        .map_err(|error| Status::internal(format!("Analisis Python gagal: {error}")))?;
    serde_json::from_str(&output)
        .map_err(|error| Status::internal(format!("Respons Python tidak valid: {error}")))
}

fn string_field(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional_number(value: &Value, name: &str) -> Option<f64> {
    value.get(name).and_then(Value::as_f64)
}

fn assessment_json(value: &Value) -> String {
    let mut analysis = Map::new();
    for (source, target) in [
        ("anomaly", "anomaly"),
        ("risk", "risk"),
        ("nutrition_concern", "nutritionConcern"),
        ("nutrition_education", "nutritionEducation"),
        ("weight_gain_status", "weightGainStatus"),
        ("weight_gain_minimum_grams", "weightGainMinimumGrams"),
        (
            "exclusive_breastfeeding_status",
            "exclusiveBreastfeedingStatus",
        ),
        ("exclusive_breastfeeding_context", "exclusiveBreastfeeding"),
        ("graph_analysis", "graphAnalysis"),
    ] {
        analysis.insert(
            target.into(),
            value.get(source).cloned().unwrap_or(Value::Null),
        );
    }
    serde_json::to_string(&Value::Object(analysis)).unwrap_or_else(|_| "{}".to_owned())
}

fn calculate_response(value: Value) -> Result<CalculateBatchResponse, Status> {
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| Status::internal("Respons batch Python tidak memiliki items."))?;
    let mut response = CalculateBatchResponse {
        underweight: value
            .get("underweight")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        stunting: value
            .get("stunting")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        wasting: value
            .get("wasting")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        total: value
            .get("total")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        items: Vec::with_capacity(items.len()),
        standards_version: string_field(&value, "standards_version"),
        calculator: string_field(&value, "calculator"),
    };
    for item in items {
        response.items.push(NutritionAssessment {
            row_number: item
                .get("row_number")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            record_id: string_field(item, "record_id"),
            nik: string_field(item, "nik"),
            bbu_status: string_field(item, "bbu_status"),
            tbu_status: string_field(item, "tbu_status"),
            bbtb_status: string_field(item, "bbtb_status"),
            imtu_status: string_field(item, "imtu_status"),
            lila_status: string_field(item, "lila_status"),
            lk_status: string_field(item, "lk_status"),
            bbu_z_score: optional_number(item, "bbu_z_score"),
            tbu_z_score: optional_number(item, "tbu_z_score"),
            bbtb_z_score: optional_number(item, "bbtb_z_score"),
            imtu_z_score: optional_number(item, "imtu_z_score"),
            lila_z_score: optional_number(item, "lila_z_score"),
            lk_z_score: optional_number(item, "lk_z_score"),
            analysis_json: assessment_json(item),
        });
    }
    Ok(response)
}

#[derive(Clone, Default)]
struct AnalysisGrpc;

#[tonic::async_trait]
impl AnalysisService for AnalysisGrpc {
    async fn calculate_batch(
        &self,
        request: Request<CalculateBatchRequest>,
    ) -> Result<Response<CalculateBatchResponse>, Status> {
        let items = request.into_inner().items;
        let mut payload_items = Vec::with_capacity(items.len());
        for item in &items {
            payload_items.push(item_payload(item)?);
        }
        let result = call_python("calculate_batch_json", json!({"items": payload_items})).await?;
        Ok(Response::new(calculate_response(result)?))
    }

    async fn analyze_dataset(
        &self,
        request: Request<AnalyzeDatasetRequest>,
    ) -> Result<Response<AnalyzeDatasetResponse>, Status> {
        let payload: Value = serde_json::from_str(&request.into_inner().dataset_json)
            .map_err(|_| Status::invalid_argument("Dataset analisis tidak valid."))?;
        if !payload.is_object() {
            return Err(Status::invalid_argument(
                "Dataset analisis harus berupa objek JSON.",
            ));
        }
        let result = call_python("analyze_dataset_json", payload).await?;
        let analytics_version = result
            .get("analytics")
            .and_then(Value::as_str)
            .unwrap_or("python-dashboard-analytics-v1")
            .to_owned();
        Ok(Response::new(AnalyzeDatasetResponse {
            result_json: serde_json::to_string(&result)
                .map_err(|error| Status::internal(error.to_string()))?,
            analytics_version,
        }))
    }

    async fn render_growth_chart(
        &self,
        request: Request<RenderGrowthChartRequest>,
    ) -> Result<Response<RenderGrowthChartResponse>, Status> {
        let input = request.into_inner();
        let payload = json!({
            "chart_type": input.chart_type,
            "sex": input.sex,
            "points": input.points.iter().map(chart_point_payload).collect::<Vec<_>>(),
            "child_name": input.child_name.clone().unwrap_or_default(),
            "language": input.language,
        });
        let result = call_python("render_growth_chart_json", payload).await?;
        Ok(Response::new(RenderGrowthChartResponse {
            chart_type: string_field(&result, "chart_type"),
            svg: string_field(&result, "svg"),
            standards_version: string_field(&result, "standards_version"),
            renderer: string_field(&result, "renderer"),
        }))
    }
}

fn persistence_workers() -> usize {
    env::var("ANALYSIS_PERSISTENCE_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.clamp(1, 8))
        .unwrap_or(2)
}

async fn persistence_loop(worker_index: usize) {
    let enabled = env::var("ANALYSIS_PERSISTENCE_ENABLED")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if !enabled {
        tracing::info!(worker_index, "Python outbox worker dinonaktifkan");
        return;
    }
    let interval = env::var("ANALYSIS_PERSISTENCE_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.25)
        .map(Duration::from_secs_f64)
        .unwrap_or(DEFAULT_PERSISTENCE_INTERVAL);
    loop {
        match tokio::task::spawn_blocking(|| {
            python_json("process_outbox_once_json", "{}".to_owned())
        })
        .await
        {
            Ok(Ok(result)) => {
                if let Ok(value) = serde_json::from_str::<Value>(&result) {
                    let processed = value
                        .get("processed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let failed = value
                        .get("failed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if processed {
                        tracing::debug!(worker_index, result = %result, "job analisis Python diproses");
                        // Drain successful jobs without an artificial delay,
                        // but back off after a failed job so a transient DB or
                        // malformed row cannot turn the scheduler into a
                        // tight retry loop.
                        if !failed {
                            continue;
                        }
                    }
                }
            }
            Ok(Err(error)) => tracing::error!(worker_index, %error, "worker outbox Python gagal"),
            Err(error) => tracing::error!(worker_index, %error, "thread worker outbox berhenti"),
        }
        tokio::time::sleep(interval).await;
    }
}

async fn health_server(port: u16) -> Result<(), io::Error> {
    async fn health() -> &'static str {
        "E-Posyandu analysis worker aktif\n"
    }
    let app = Router::new()
        .route("/", get(health))
        .route("/health", get(health))
        .route("/ready", get(health));
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, app).await.map_err(io::Error::other)
}

fn grpc_address() -> Result<ListenAddress, io::Error> {
    parse_listen_address(
        &env::var("ANALYSIS_GRPC_ADDR").unwrap_or_default(),
        DEFAULT_GRPC_ADDR,
        "ANALYSIS_GRPC_ADDR",
    )
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let address = grpc_address()?;
    let health_port = env::var("ANALYSIS_HTTP_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_HTTP_PORT);
    let service_auth = service_auth()?;
    let mut service = Server::builder();
    let (reporter, health) = tonic_health::server::health_reporter();
    reporter
        .set_serving::<AnalysisServiceServer<AnalysisGrpc>>()
        .await;
    let analysis_service = AnalysisServiceServer::new(AnalysisGrpc)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let analysis_service = tonic::codegen::InterceptedService::new(analysis_service, service_auth);
    let service = service.add_service(health).add_service(analysis_service);
    for worker_index in 0..persistence_workers() {
        tokio::spawn(persistence_loop(worker_index));
    }
    tokio::spawn(async move {
        if let Err(error) = health_server(health_port).await {
            tracing::error!(%error, "HTTP health worker gagal");
        }
    });
    match address {
        ListenAddress::Tcp(address) => {
            service
                .serve_with_shutdown(address, shutdown_signal())
                .await?
        }
        ListenAddress::Unix(path) => {
            let listener = bind_unix(&path)?;
            service
                .serve_with_incoming_shutdown(UnixListenerStream::new(listener), shutdown_signal())
                .await?;
        }
    }
    Ok(())
}
