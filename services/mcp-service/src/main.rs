//! E-Posyandu MCP adapter.
//!
//! This process is deliberately a thin, policy-enforcing adapter.  It never
//! opens PostgreSQL, Redis, or the analysis runtime directly.  Read tools are
//! translated to the private ReadService envelope and approved mutations are
//! translated to WriteService.  Python remains the authority for all
//! anthropometry, risk, education, and growth-chart calculations.

use std::{collections::HashSet, env, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use e_posyandu_proto::proto::platform::v1::{
    HttpHeader, ServiceRequest, read_service_client::ReadServiceClient,
    write_service_client::WriteServiceClient,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use subtle::ConstantTimeEq;
use tonic::{
    Request as GrpcRequest,
    metadata::{Ascii, MetadataValue},
    service::Interceptor,
    transport::{Channel, Endpoint},
};
use tracing::{info, warn};
use url::form_urlencoded;
use uuid::Uuid;

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_TOOL_ARGUMENT_BYTES: usize = 256 * 1024;
const DEFAULT_ADDR: &str = "127.0.0.1:5160";
const DEFAULT_READ_URL: &str = "unix:///run/e-posyandu/read.sock";
const DEFAULT_WRITE_URL: &str = "unix:///run/e-posyandu/write.sock";
const SERVICE_TOKEN_HEADER: &str = "x-eposyandu-service-token";
const MCP_TOKEN_HEADER: &str = "x-eposyandu-mcp-token";

#[derive(Clone)]
struct AppState {
    read: Channel,
    write: Channel,
    service_token: MetadataValue<Ascii>,
    mcp_secret: Arc<Vec<u8>>,
    allowed_origins: Arc<HashSet<String>>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[serde(default)]
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Clone)]
struct ServiceTokenInterceptor {
    token: MetadataValue<Ascii>,
}

impl Interceptor for ServiceTokenInterceptor {
    fn call(&mut self, mut request: GrpcRequest<()>) -> Result<GrpcRequest<()>, tonic::Status> {
        request
            .metadata_mut()
            .insert(SERVICE_TOKEN_HEADER, self.token.clone());
        Ok(request)
    }
}

#[derive(Debug)]
struct UpstreamError {
    status: u16,
    message: String,
    payload: Value,
}

struct TransportError {
    status: StatusCode,
    message: &'static str,
}

impl AppState {
    fn from_env() -> Result<Self, String> {
        let secret = env::var("MCP_SHARED_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "MCP_SHARED_SECRET wajib diisi.".to_owned())?;
        if secret.len() < 24 {
            return Err("MCP_SHARED_SECRET minimal 24 karakter.".to_owned());
        }
        let service_token = env::var("RUST_WORKER_SHARED_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "RUST_WORKER_SHARED_SECRET wajib diisi.".to_owned())?
            .parse()
            .map_err(|_| "RUST_WORKER_SHARED_SECRET harus ASCII.".to_owned())?;
        let origins = env::var("MCP_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| {
                "http://127.0.0.1:5160,http://localhost:5160,http://localhost:5175".to_owned()
            })
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect();
        Ok(Self {
            read: endpoint("MCP_READ_GRPC_URL", DEFAULT_READ_URL)?,
            write: endpoint("MCP_WRITE_GRPC_URL", DEFAULT_WRITE_URL)?,
            service_token,
            mcp_secret: Arc::new(secret.into_bytes()),
            allowed_origins: Arc::new(origins),
        })
    }

    async fn call_read(
        &self,
        inbound_headers: &HeaderMap,
        method: Method,
        path_and_query: String,
        body: Vec<u8>,
    ) -> Result<Value, UpstreamError> {
        let request = service_request(inbound_headers, method, path_and_query, body);
        let mut client = ReadServiceClient::with_interceptor(
            self.read.clone(),
            ServiceTokenInterceptor {
                token: self.service_token.clone(),
            },
        );
        let result = tokio::time::timeout(
            Duration::from_secs(35),
            client.handle(GrpcRequest::new(request)),
        )
        .await
        .map_err(|_| UpstreamError::timeout("ReadService timeout."))?
        .map_err(|error| {
            UpstreamError::unavailable(format!("ReadService tidak tersedia: {error}"))
        })?
        .into_inner();
        response_value(result.status as u16, result.body)
    }

    async fn call_write(
        &self,
        inbound_headers: &HeaderMap,
        method: Method,
        path_and_query: String,
        body: Vec<u8>,
    ) -> Result<Value, UpstreamError> {
        let request = service_request(inbound_headers, method, path_and_query, body);
        let mut client = WriteServiceClient::with_interceptor(
            self.write.clone(),
            ServiceTokenInterceptor {
                token: self.service_token.clone(),
            },
        );
        let result = tokio::time::timeout(
            Duration::from_secs(35),
            client.handle(GrpcRequest::new(request)),
        )
        .await
        .map_err(|_| UpstreamError::timeout("WriteService timeout."))?
        .map_err(|error| {
            UpstreamError::unavailable(format!("WriteService tidak tersedia: {error}"))
        })?
        .into_inner();
        response_value(result.status as u16, result.body)
    }
}

impl UpstreamError {
    fn unavailable(message: String) -> Self {
        Self {
            status: 503,
            message,
            payload: json!({}),
        }
    }

    fn timeout(message: &str) -> Self {
        Self {
            status: 504,
            message: message.to_owned(),
            payload: json!({}),
        }
    }
}

fn endpoint(name: &str, fallback: &str) -> Result<Channel, String> {
    let url = env::var(name).unwrap_or_else(|_| fallback.to_owned());
    Endpoint::from_shared(url.trim().to_owned())
        .map_err(|_| format!("{name} bukan URL gRPC valid."))
        .map(|endpoint| {
            endpoint
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(35))
                .connect_lazy()
        })
}

fn service_request(
    inbound_headers: &HeaderMap,
    method: Method,
    path_and_query: String,
    body: Vec<u8>,
) -> ServiceRequest {
    ServiceRequest {
        request_id: inbound_headers
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        method: method.to_string(),
        path_and_query,
        headers: forward_headers(inbound_headers),
        body,
    }
}

fn forward_headers(headers: &HeaderMap) -> Vec<HttpHeader> {
    [
        "cookie",
        "authorization",
        "origin",
        "x-e-posyandu-origin",
        "x-request-id",
        "user-agent",
    ]
    .into_iter()
    .filter_map(|name| {
        let value = headers.get(name)?.to_str().ok()?;
        Some(HttpHeader {
            name: name.to_owned(),
            value: value.to_owned(),
        })
    })
    .collect()
}

fn response_value(status: u16, body: Vec<u8>) -> Result<Value, UpstreamError> {
    let payload = serde_json::from_slice::<Value>(&body)
        .unwrap_or_else(|_| json!({"text": String::from_utf8_lossy(&body)}));
    if status >= 400 {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Permintaan service ditolak.")
            .to_owned();
        return Err(UpstreamError {
            status,
            message,
            payload,
        });
    }
    Ok(payload)
}

async fn health() -> impl IntoResponse {
    Json(json!({"ok": true, "service": "mcp-service"}))
}

async fn handle_mcp(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return rpc_error_response(None, -32600, "Payload MCP terlalu besar.");
    }
    if let Err(error) = authorize_transport(&state, &headers) {
        return (error.status, Json(json!({"error": error.message}))).into_response();
    }
    let request: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return rpc_error_response(None, -32700, "JSON MCP tidak valid."),
    };
    if request.jsonrpc != "2.0" || request.method.trim().is_empty() {
        return rpc_error_response(request.id, -32600, "Request JSON-RPC tidak valid.");
    }
    let id = request.id.clone();
    let is_notification = id.is_none();
    let result = dispatch(&state, &headers, &request).await;
    if is_notification {
        return StatusCode::ACCEPTED.into_response();
    }
    match result {
        Ok(value) => rpc_success_response(id, value),
        Err(error) => rpc_tool_or_rpc_error(id, error),
    }
}

fn authorize_transport(state: &AppState, headers: &HeaderMap) -> Result<(), TransportError> {
    let supplied = headers
        .get(MCP_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .as_bytes();
    if supplied.len() != state.mcp_secret.len()
        || supplied.ct_eq(state.mcp_secret.as_slice()).unwrap_u8() != 1
    {
        return Err(TransportError {
            status: StatusCode::UNAUTHORIZED,
            message: "MCP token tidak valid.",
        });
    }
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        && !state.allowed_origins.contains(origin)
    {
        return Err(TransportError {
            status: StatusCode::FORBIDDEN,
            message: "Origin MCP tidak diizinkan.",
        });
    }
    Ok(())
}

async fn dispatch(
    state: &AppState,
    headers: &HeaderMap,
    request: &JsonRpcRequest,
) -> Result<Value, UpstreamError> {
    match request.method.as_str() {
        "initialize" => Ok(json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "e-posyandu-mcp", "version": "3.8.1"},
            "instructions": "Gunakan hasil Python sebagai sumber analitik; MCP tidak mendiagnosis."
        })),
        "ping" => Ok(json!({})),
        "tools/list" | "server/discover" => Ok(json!({"tools": tool_definitions()})),
        "notifications/initialized" => Ok(json!({})),
        "tools/call" => call_tool(state, headers, request.params.clone()).await,
        _ => Err(UpstreamError {
            status: 400,
            message: format!("Metode MCP tidak didukung: {}", request.method),
            payload: json!({"code":"method_not_found"}),
        }),
    }
}

async fn call_tool(
    state: &AppState,
    headers: &HeaderMap,
    params: Value,
) -> Result<Value, UpstreamError> {
    let object = params
        .as_object()
        .ok_or_else(|| invalid("params tools/call harus object."))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Nama tool wajib diisi."))?;
    let arguments = object
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    validate_arguments(&arguments)?;
    let result = match name {
        "list_children" => list_children(state, headers, arguments).await?,
        "get_child_summary" => get_child_summary(state, headers, arguments).await?,
        "get_measurement_analysis" | "get_education" => {
            analysis_call(state, headers, arguments).await?
        }
        "get_dashboard_summary" => {
            post_read(
                state,
                headers,
                "/api/v1/analysis/dashboard-stats",
                arguments,
            )
            .await?
        }
        "get_growth_chart" => {
            post_read(state, headers, "/api/v1/analysis/growth-chart", arguments).await?
        }
        "get_breastfeeding_status" => breastfeeding(state, headers, arguments).await?,
        "get_mpasi_status" => children_view(state, headers, "mpasi", arguments).await?,
        "get_pmt_status" => collection_list(state, headers, "pmt_programs", arguments).await?,
        "get_recommendation_history" | "get_follow_up_history" => {
            collection_item(state, headers, "pmt_programs", arguments).await?
        }
        // Recommendation selection is intentionally not exposed to cadres.
        // The analysis service supplies structured signals and this adapter
        // maps them to an audited, non-diagnostic recommendation template.
        // Keep the old option/Follow-up names as compatibility aliases, but
        // return the automatic result rather than a menu of codes.
        "get_recommendation"
        | "get_recommendation_preview"
        | "get_recommendation_options"
        | "get_follow_up_options" => automatic_recommendation(&arguments),
        "record_recommendation" | "record_follow_up" => {
            record_recommendation(state, headers, arguments).await?
        }
        "record_education_delivery" => record_education_delivery(state, headers, arguments).await?,
        _ => return Err(invalid("Tool MCP tidak dikenal.")),
    };
    // The assistant does not need raw NIK, family-card, phone, or address
    // fields.  Redact them at the MCP boundary even when an upstream read
    // endpoint legitimately returns them to an authenticated human user.
    let result = redact_sensitive(result);
    Ok(json!({
        "content": [{"type":"text", "text": serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_owned())}],
        "structuredContent": result,
        "isError": false
    }))
}

fn invalid(message: &str) -> UpstreamError {
    UpstreamError {
        status: 422,
        message: message.to_owned(),
        payload: json!({"code":"invalid_arguments"}),
    }
}

fn validate_arguments(value: &Value) -> Result<(), UpstreamError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| invalid("Argumen tool tidak dapat dibaca."))?;
    if bytes.len() > MAX_TOOL_ARGUMENT_BYTES {
        return Err(invalid("Argumen tool terlalu besar."));
    }
    fn walk(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(key, value)| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "diagnosis" | "diagnoses" | "prescription" | "treatment"
                ) || walk(value)
            }),
            Value::Array(items) => items.iter().any(walk),
            _ => false,
        }
    }
    if walk(value) {
        return Err(invalid(
            "MCP tidak menerima atau membuat diagnosis, resep, maupun terapi.",
        ));
    }
    Ok(())
}

async fn list_children(
    state: &AppState,
    headers: &HeaderMap,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    children_view(state, headers, "data", arguments).await
}

async fn children_view(
    state: &AppState,
    headers: &HeaderMap,
    view: &str,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    let object = arguments
        .as_object()
        .ok_or_else(|| invalid("Argumen halaman balita harus object."))?;
    let mut query = common_period_query(object).await?;
    query.insert("view".to_owned(), Value::String(view.to_owned()));
    query.insert(
        "page".to_owned(),
        Value::String(bounded_string(object, "page", 1, 1_000_000, 1)?),
    );
    query.insert(
        "size".to_owned(),
        Value::String(bounded_string(object, "size", 1, 50, 20)?),
    );
    query.insert(
        "ageGroup".to_owned(),
        Value::String(
            object
                .get("age_group")
                .and_then(Value::as_str)
                .unwrap_or(if view == "mpasi" { "6-23" } else { "0-59" })
                .to_owned(),
        ),
    );
    for (arg, query_name) in [
        ("search", "search"),
        ("village", "village"),
        ("posyandu", "posyandu"),
        ("sort", "sort"),
    ] {
        if let Some(value) = object
            .get(arg)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            query.insert(query_name.to_owned(), Value::String(value.to_owned()));
        }
    }
    let path = format!("/api/v1/children/page?{}", encode_query(&query));
    state
        .call_read(headers, Method::GET, path, Vec::new())
        .await
}

async fn common_period_query(
    object: &Map<String, Value>,
) -> Result<Map<String, Value>, UpstreamError> {
    let mut result = Map::new();
    for (arg, query_name) in [
        ("as_of", "asOf"),
        ("measurement_start", "measurementStart"),
        ("measurement_end", "measurementEnd"),
    ] {
        let value = object
            .get(arg)
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() == 10 && value.bytes().filter(|byte| *byte == b'-').count() == 2
            })
            .ok_or_else(|| {
                invalid("as_of, measurement_start, dan measurement_end wajib berupa tanggal ISO.")
            })?;
        result.insert(query_name.to_owned(), Value::String(value.to_owned()));
    }
    result.insert(
        "historyStart".to_owned(),
        Value::String(
            object
                .get("history_start")
                .and_then(Value::as_str)
                .unwrap_or("1900-01-01")
                .to_owned(),
        ),
    );
    Ok(result)
}

fn encode_query(query: &Map<String, Value>) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in query {
        if let Some(value) = value.as_str() {
            serializer.append_pair(key, value);
        }
    }
    serializer.finish()
}

fn bounded_string(
    object: &Map<String, Value>,
    name: &str,
    min: usize,
    max: usize,
    default: usize,
) -> Result<String, UpstreamError> {
    let value = object
        .get(name)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default);
    if !(min..=max).contains(&value) {
        return Err(invalid("Nilai pagination di luar batas."));
    }
    Ok(value.to_string())
}

async fn get_child_summary(
    state: &AppState,
    headers: &HeaderMap,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    let id = arguments
        .get("child_id")
        .and_then(Value::as_str)
        .filter(|value| valid_path_id(value))
        .ok_or_else(|| invalid("child_id wajib diisi."))?;
    state
        .call_read(
            headers,
            Method::GET,
            format!("/api/v1/collections/children/{id}"),
            Vec::new(),
        )
        .await
}

async fn analysis_call(
    state: &AppState,
    headers: &HeaderMap,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    if arguments.get("items").and_then(Value::as_array).is_none() {
        return Err(invalid("Tool analisis memerlukan items dari pengukuran."));
    }
    post_read(state, headers, "/api/v1/analysis/anthropometry", arguments).await
}

async fn post_read(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    let body =
        serde_json::to_vec(&arguments).map_err(|_| invalid("Payload analisis tidak valid."))?;
    state
        .call_read(headers, Method::POST, path.to_owned(), body)
        .await
}

async fn breastfeeding(
    state: &AppState,
    headers: &HeaderMap,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    let object = arguments
        .as_object()
        .ok_or_else(|| invalid("Argumen ASI harus object."))?;
    let age = object
        .get("age_group")
        .and_then(Value::as_str)
        .unwrap_or("0-5");
    if age != "0-5" && age != "6" {
        return Err(invalid("age_group ASI hanya 0-5 atau 6."));
    }
    let mut query = common_period_query(object).await?;
    query.insert("ageGroup".to_owned(), Value::String(age.to_owned()));
    query.insert(
        "page".to_owned(),
        Value::String(bounded_string(object, "page", 1, 1_000_000, 1)?),
    );
    query.insert(
        "size".to_owned(),
        Value::String(bounded_string(object, "size", 1, 50, 20)?),
    );
    state
        .call_read(
            headers,
            Method::GET,
            format!(
                "/api/v1/exclusive-breastfeeding/page?{}",
                encode_query(&query)
            ),
            Vec::new(),
        )
        .await
}

async fn collection_list(
    state: &AppState,
    headers: &HeaderMap,
    collection: &str,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    let object = arguments
        .as_object()
        .ok_or_else(|| invalid("Argumen koleksi harus object."))?;
    let page = bounded_string(object, "page", 1, 1_000_000, 1)?;
    let size = bounded_string(object, "size", 1, 50, 20)?;
    state
        .call_read(
            headers,
            Method::GET,
            format!("/api/v1/collections/{collection}?page={page}&size={size}"),
            Vec::new(),
        )
        .await
}

async fn collection_item(
    state: &AppState,
    headers: &HeaderMap,
    collection: &str,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    let id = arguments
        .get("program_id")
        .and_then(Value::as_str)
        .filter(|value| valid_path_id(value))
        .ok_or_else(|| invalid("program_id wajib diisi."))?;
    state
        .call_read(
            headers,
            Method::GET,
            format!("/api/v1/collections/{collection}/{id}"),
            Vec::new(),
        )
        .await
}

async fn record_recommendation(
    state: &AppState,
    headers: &HeaderMap,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    require_confirmation(&arguments)?;
    let object = arguments
        .as_object()
        .ok_or_else(|| invalid("Argumen rekomendasi tindak lanjut harus object."))?;
    let program_id = object
        .get("program_id")
        .and_then(Value::as_str)
        .filter(|value| valid_path_id(value))
        .ok_or_else(|| invalid("program_id wajib diisi."))?;
    // Kader hanya mengonfirmasi dan mengisi periode.  Sinyal status, tren,
    // dan risiko berasal dari hasil Python (biasanya di dalam `signals`).
    // Kode maupun teks rekomendasi yang dikirim klien sengaja diabaikan agar
    // keputusan tetap konsisten dan tidak dapat dipilih manual.
    let automatic = automatic_recommendation(&arguments);
    let recommendation_code = automatic
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("monitoring");
    let recommendation = automatic
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_else(|| recommendation_template("monitoring").expect("monitoring template"));
    let manual_code_ignored = ["recommendation_code", "follow_up_code", "follow_up"]
        .iter()
        .any(|key| object.contains_key(*key));
    let week = object
        .get("week_number")
        .and_then(Value::as_u64)
        .filter(|value| (1..=52).contains(value))
        .ok_or_else(|| invalid("week_number harus 1-52."))?;
    let date = object.get("date").and_then(Value::as_str).unwrap_or("");
    let body = json!({"id": program_id, "data": {"monitorings": {week.to_string(): {"tindakLanjut": recommendation, "tgl": date}}}});
    warn!(
        tool = "record_recommendation",
        program_id, "MCP recommendation write diteruskan melalui WriteService"
    );
    let saved = state
        .call_write(
            headers,
            Method::PATCH,
            format!("/api/v1/collections/pmt_programs/{program_id}"),
            serde_json::to_vec(&body)
                .map_err(|_| invalid("Payload rekomendasi tindak lanjut tidak valid."))?,
        )
        .await?;
    Ok(json!({
        "saved": saved,
        "recommendationCode": recommendation_code,
        "generatedRecommendation": recommendation,
        "reason": automatic.get("reason").cloned().unwrap_or(Value::Null),
        "automatic": true,
        "manualCodeIgnored": manual_code_ignored,
        "message": "Rekomendasi tindak lanjut dipilih otomatis dari sinyal analisis Python dan disimpan melalui WriteService."
    }))
}

fn automatic_recommendation(arguments: &Value) -> Value {
    let (code, reason) = infer_recommendation(arguments);
    json!({
        "code": code,
        "text": recommendation_template(code).expect("inferred recommendation template"),
        "reason": reason,
        "automatic": true,
        "source": "python-analysis-signals",
        "note": "Kode dan teks dipilih sistem dari sinyal analisis; kader tidak memilih rekomendasi. Ini bukan diagnosis atau resep."
    })
}

fn signal_value<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    if let Some(value) = keys.iter().find_map(|key| object.get(*key)) {
        return Some(value);
    }
    if let Some(value) = object
        .get("signals")
        .and_then(Value::as_object)
        .and_then(|signals| keys.iter().find_map(|key| signals.get(*key)))
    {
        return Some(value);
    }
    object
        .values()
        .find_map(|value| nested_signal_value(value, keys))
}

fn nested_signal_value<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    match value {
        Value::Object(map) => keys.iter().find_map(|key| map.get(*key)).or_else(|| {
            map.values()
                .find_map(|child| nested_signal_value(child, keys))
        }),
        Value::Array(items) => items
            .iter()
            .find_map(|item| nested_signal_value(item, keys)),
        _ => None,
    }
}

fn signal_text(object: &Map<String, Value>, keys: &[&str]) -> String {
    signal_value(object, keys)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn signal_number(object: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    signal_value(object, keys).and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().replace(',', ".").parse::<f64>().ok(),
        _ => None,
    })
}

fn value_contains_status(value: &Value, wanted: &str) -> bool {
    match value {
        Value::String(text) => {
            let normalized = text.trim().to_ascii_lowercase();
            normalized == wanted
                || (wanted == "t" && ["tidak naik", "tidak_naik"].contains(&normalized.as_str()))
        }
        Value::Array(items) => items.iter().any(|item| value_contains_status(item, wanted)),
        Value::Object(map) => map.values().any(|item| value_contains_status(item, wanted)),
        _ => false,
    }
}

fn status_blob(object: &Map<String, Value>) -> String {
    [
        "status_gizi",
        "statusGizi",
        "statuses",
        "latest_statuses",
        "latestStatuses",
        "nutrition_status",
        "nutritionStatus",
        "problem",
        "category",
    ]
    .iter()
    .filter_map(|key| signal_value(object, &[*key]))
    .map(|value| value.to_string().to_ascii_lowercase())
    .collect::<Vec<_>>()
    .join(" ")
}

/// Select a recommendation from signals already produced by Python.
///
/// This function is deliberately a small routing table, not an anthropometry
/// or risk model.  It never calculates WHO/z-scores and falls back to routine
/// monitoring when the analysis worker has not supplied a signal yet.
fn infer_recommendation(arguments: &Value) -> (&'static str, &'static str) {
    let object = match arguments.as_object() {
        Some(object) => object,
        None => {
            return (
                "monitoring",
                "Sinyal analisis belum tersedia; lanjutkan pemantauan rutin.",
            );
        }
    };
    let attendance = signal_text(object, &["attendance", "kehadiran", "attendance_status"]);
    let gain_status = signal_text(
        object,
        &[
            "statusNaik",
            "status_naik",
            "weightGainStatus",
            "weight_gain_status",
            "current",
        ],
    );
    let status_blob = status_blob(object);
    let risk_level = signal_text(object, &["riskLevel", "risk_level", "level"]);
    let not_rising_count = signal_number(
        object,
        &[
            "notRisingCount",
            "not_rising_count",
            "trailingNotRising",
            "trailing_not_rising",
        ],
    )
    .unwrap_or(0.0);
    let not_rising_rate =
        signal_number(object, &["notRisingRate", "not_rising_rate"]).unwrap_or(0.0);
    let t_in_statuses = signal_value(
        object,
        &[
            "statuses",
            "weightGainStatuses",
            "weight_gain_statuses",
            "recent",
        ],
    )
    .is_some_and(|value| value_contains_status(value, "t"));

    let absent = ["tidak hadir", "tidak_hadir", "absen"]
        .iter()
        .any(|term| attendance.contains(term) || status_blob.contains(term));
    if absent || gain_status == "o" || status_blob.contains("tidak ditimbang") || attendance == "o"
    {
        return (
            "tidak_hadir",
            "Balita tidak hadir atau tidak ditimbang; sistem menjadwalkan konfirmasi dan kunjungan ulang.",
        );
    }

    let severe = [
        "gizi buruk",
        "berat sangat kurang",
        "sangat pendek",
        "severe",
        "buruk",
    ]
    .iter()
    .any(|term| status_blob.contains(term));
    let high_risk = ["tinggi", "high", "sangat tinggi"]
        .iter()
        .any(|term| risk_level.contains(term));
    if severe || high_risk {
        return (
            "rujuk_tenaga_kesehatan",
            "Sinyal masalah atau risiko tinggi dari Python memerlukan konfirmasi tenaga kesehatan.",
        );
    }

    if gain_status == "t"
        || gain_status.contains("tidak naik")
        || not_rising_count >= 1.0
        || not_rising_rate > 0.0
        || t_in_statuses
    {
        return (
            "tidak_naik",
            "Status kenaikan berat menunjukkan T; sistem menambahkan edukasi khusus dan pemantauan lebih dekat.",
        );
    }

    let nutrition_problem = [
        "kurang",
        "pendek",
        "stunting",
        "wasting",
        "underweight",
        "gizi lebih",
        "berisiko",
    ]
    .iter()
    .any(|term| status_blob.contains(term));
    if nutrition_problem {
        return (
            "edukasi_gizi",
            "Status gizi dari Python memerlukan edukasi sesuai usia dan pemantauan terjadwal.",
        );
    }

    if signal_text(object, &["program_type", "programType"]).contains("pmt") {
        return (
            "lanjut_pmt",
            "Program PMT aktif tanpa sinyal masalah baru; sistem melanjutkan pemantauan penerimaan PMT.",
        );
    }
    (
        "monitoring",
        "Tidak ada sinyal masalah baru; sistem menetapkan pemantauan rutin.",
    )
}

fn recommendation_template(code: &str) -> Option<&'static str> {
    match code {
        "monitoring" => Some(
            "Pemantauan rutin dilakukan; lanjutkan pemantauan pertumbuhan dan penimbangan berikutnya.",
        ),
        "tidak_hadir" => Some(
            "Balita tidak hadir; kader melakukan konfirmasi kepada keluarga dan menjadwalkan kunjungan ulang.",
        ),
        "kunjungan_rumah" => Some(
            "Kader menjadwalkan kunjungan rumah untuk memantau kondisi balita dan mengingatkan penimbangan berikutnya.",
        ),
        "lanjut_pmt" => Some(
            "Pemberian PMT dilanjutkan sesuai jadwal; kader memantau penerimaan dan konsumsi balita.",
        ),
        "edukasi_gizi" => Some(
            "Kader memberikan edukasi pemberian makan sesuai usia dan mengingatkan keluarga untuk memantau pertumbuhan.",
        ),
        "jadwal_ulang" => Some(
            "Kader dan keluarga menyepakati jadwal pemantauan atau penimbangan ulang pada periode berikutnya.",
        ),
        "rujuk_tenaga_kesehatan" => Some(
            "Kader mengarahkan keluarga untuk berkonsultasi dengan tenaga kesehatan dan mencatat tindak lanjutnya.",
        ),
        "tidak_naik" => Some(
            "Berat balita tidak naik pada pengukuran terakhir; berikan edukasi pola makan sesuai usia, periksa kembali cara ukur, dan jadwalkan pemantauan lebih dekat. Bila pola berlanjut, arahkan keluarga berkonsultasi dengan tenaga kesehatan.",
        ),
        _ => None,
    }
}

async fn record_education_delivery(
    state: &AppState,
    headers: &HeaderMap,
    arguments: Value,
) -> Result<Value, UpstreamError> {
    require_confirmation(&arguments)?;
    let object = arguments
        .as_object()
        .ok_or_else(|| invalid("Argumen edukasi harus object."))?;
    let child_id = object
        .get("child_id")
        .and_then(Value::as_str)
        .filter(|value| valid_path_id(value))
        .ok_or_else(|| invalid("child_id wajib diisi."))?;
    let note = object
        .get("note")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.chars().count() <= 2_000)
        .ok_or_else(|| invalid("note wajib diisi dan maksimal 2.000 karakter."))?;
    // `change_logs` is the existing audited append-only resource.  The
    // domain service validates the child scope, stamps the actor, and writes
    // the detail rows in the same mutation path; MCP never writes a raw
    // `child_id` column or bypasses that audit logic.
    let body = json!({
        "id": Uuid::new_v4().to_string(),
        "data": {
            "childId": child_id,
            "changes": [{"field": "edukasi_diberikan", "oldValue": null, "newValue": note}],
            "changedBy": "MCP",
            "timestamp": object.get("date").and_then(Value::as_str).unwrap_or("")
        }
    });
    warn!(
        tool = "record_education_delivery",
        child_id, "MCP write edukasi diteruskan melalui WriteService dan audit domain"
    );
    state
        .call_write(
            headers,
            Method::POST,
            "/api/v1/collections/change_logs".to_owned(),
            serde_json::to_vec(&body)
                .map_err(|_| invalid("Payload pencatatan edukasi tidak valid."))?,
        )
        .await
}

fn require_confirmation(arguments: &Value) -> Result<(), UpstreamError> {
    if arguments.get("confirmed").and_then(Value::as_bool) != Some(true) {
        return Err(invalid(
            "Operasi tulis memerlukan confirmed=true setelah pengguna mengonfirmasi.",
        ));
    }
    Ok(())
}

fn valid_path_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn redact_sensitive(value: Value) -> Value {
    const PRIVATE_KEYS: &[&str] = &[
        "nik",
        "nikortu",
        "nokartu",
        "nokk",
        "nohp",
        "nohportu",
        "nationalid",
        "parentnationalid",
        "parentphone",
        "familycardnumber",
        "address",
        "alamat",
    ];
    match value {
        Value::Object(mut map) => {
            map.retain(|key, value| {
                let normalized = key
                    .bytes()
                    .filter(|byte| byte.is_ascii_alphanumeric())
                    .map(|byte| byte.to_ascii_lowercase() as char)
                    .collect::<String>();
                if PRIVATE_KEYS.iter().any(|private| normalized == *private) {
                    return false;
                }
                if matches!(normalized.as_str(), "childid" | "legacychildid")
                    && value.as_str().is_some_and(is_national_id)
                    && let Some(raw) = value.as_str()
                {
                    *value = Value::String(mask_national_id(raw));
                }
                true
            });
            for child in map.values_mut() {
                let replacement = redact_sensitive(std::mem::take(child));
                *child = replacement;
            }
            Value::Object(map)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact_sensitive).collect()),
        other => other,
    }
}

fn is_national_id(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn mask_national_id(value: &str) -> String {
    if !is_national_id(value) {
        return value.to_owned();
    }
    format!("{}********{}", &value[..4], &value[12..])
}

fn tool_definitions() -> Value {
    json!([
        tool(
            "list_children",
            "Membaca halaman balita terfilter dari ReadService.",
            json!({"type":"object","required":["as_of","measurement_start","measurement_end"],"properties":{"as_of":{"type":"string"},"measurement_start":{"type":"string"},"measurement_end":{"type":"string"},"history_start":{"type":"string"},"age_group":{"type":"string"},"page":{"type":"integer"},"size":{"type":"integer"},"search":{"type":"string"},"village":{"type":"string"},"posyandu":{"type":"string"}}})
        ),
        tool(
            "get_child_summary",
            "Membaca identitas dan ringkasan balita.",
            json!({"type":"object","required":["child_id"],"properties":{"child_id":{"type":"string"}}})
        ),
        tool(
            "get_measurement_analysis",
            "Meminta penghitungan antropometri/z-score/status kepada Python.",
            json!({"type":"object","required":["items"],"properties":{"items":{"type":"array"}}})
        ),
        tool(
            "get_education",
            "Mengambil edukasi berbasis hasil analisis Python; bukan diagnosis.",
            json!({"type":"object","required":["items"],"properties":{"items":{"type":"array"}}})
        ),
        tool(
            "get_dashboard_summary",
            "Membaca agregasi dashboard yang dihitung oleh Python/SQL.",
            json!({"type":"object"})
        ),
        tool(
            "get_growth_chart",
            "Meminta grafik pertumbuhan dari Python.",
            json!({"type":"object","required":["child_name","sex","chart_type","points"],"properties":{"child_name":{"type":"string"},"sex":{"type":"string"},"chart_type":{"type":"string"},"points":{"type":"array"}}})
        ),
        tool(
            "get_breastfeeding_status",
            "Membaca halaman ASI eksklusif usia 0-5 atau 6 bulan.",
            json!({"type":"object","required":["measurement_start","measurement_end","as_of"],"properties":{"age_group":{"type":"string"}}})
        ),
        tool(
            "get_mpasi_status",
            "Membaca halaman MPASI tetap usia 6-23 bulan.",
            json!({"type":"object","required":["as_of","measurement_start","measurement_end"],"properties":{}})
        ),
        tool(
            "get_pmt_status",
            "Membaca daftar program PMT secara paginasi.",
            json!({"type":"object","properties":{"page":{"type":"integer"},"size":{"type":"integer"}}})
        ),
        tool(
            "get_recommendation_history",
            "Membaca riwayat rekomendasi tindak lanjut program PMT.",
            json!({"type":"object","required":["program_id"],"properties":{"program_id":{"type":"string"}}})
        ),
        tool(
            "get_recommendation",
            "Menghasilkan rekomendasi tindak lanjut secara otomatis dari sinyal hasil analisis Python; kader tidak memilih kode.",
            json!({"type":"object","properties":{"signals":{"type":"object","description":"Sinyal terstruktur dari Python, misalnya statusNaik, notRisingCount, riskLevel, statusGizi, dan kehadiran."},"statusNaik":{"type":"string","description":"Sinyal dari hasil Python; bukan pilihan rekomendasi."},"notRisingCount":{"type":"number","description":"Jumlah status T dari hasil Python."},"notRisingRate":{"type":"number","description":"Proporsi status T dari hasil Python."},"riskLevel":{"type":"string","description":"Tingkat risiko hasil Python."}}})
        ),
        tool(
            "record_recommendation",
            "Mencatat rekomendasi tindak lanjut terkonfirmasi melalui WriteService; sistem memilih rekomendasi dari sinyal hasil analisis Python, tanpa kode pilihan kader.",
            json!({"type":"object","required":["confirmed","program_id","week_number"],"properties":{"confirmed":{"type":"boolean"},"program_id":{"type":"string"},"week_number":{"type":"integer"},"date":{"type":"string"},"signals":{"type":"object","description":"Sinyal hasil Python; diisi otomatis oleh sistem."},"statusNaik":{"type":"string","description":"Sinyal hasil Python; bukan kode rekomendasi."},"notRisingCount":{"type":"number","description":"Jumlah status T hasil Python."},"notRisingRate":{"type":"number","description":"Proporsi status T hasil Python."},"riskLevel":{"type":"string","description":"Tingkat risiko hasil Python."},"statusGizi":{"type":"object","description":"Status gizi hasil Python; bukan diagnosis."}}})
        ),
        tool(
            "record_education_delivery",
            "Mencatat edukasi yang sudah diberikan melalui audit WriteService.",
            json!({"type":"object","required":["confirmed","child_id","note"],"properties":{"confirmed":{"type":"boolean"},"child_id":{"type":"string"},"note":{"type":"string"}}})
        )
    ])
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name": name, "description": description, "inputSchema": input_schema})
}

fn rpc_success_response(id: Option<Value>, result: Value) -> Response {
    let mut response = Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response.headers_mut().insert(
        "MCP-Protocol-Version",
        HeaderValue::from_static(MCP_PROTOCOL_VERSION),
    );
    response
}

fn rpc_error_response(id: Option<Value>, code: i64, message: &str) -> Response {
    Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})).into_response()
}

fn rpc_tool_or_rpc_error(id: Option<Value>, error: UpstreamError) -> Response {
    let content = json!({"content":[{"type":"text","text":error.message}],"isError":true,"structuredContent":error.payload,"_meta":{"upstreamStatus":error.status}});
    Json(json!({"jsonrpc":"2.0","id":id,"result":content})).into_response()
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
    let state = AppState::from_env().map_err(std::io::Error::other)?;
    let address: SocketAddr = env::var("MCP_HTTP_ADDR")
        .unwrap_or_else(|_| DEFAULT_ADDR.to_owned())
        .parse()?;
    if !address.ip().is_loopback() {
        info!(
            "MCP bind bukan loopback; pastikan service hanya berada di jaringan internal dan Origin allowlist aktif"
        );
    }
    let router = Router::new()
        .route("/mcp", post(handle_mcp))
        .route("/health", get(health))
        .with_state(state);
    info!(%address, "MCP service listening");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_registry_contains_read_and_write_boundaries() {
        let registry = tool_definitions();
        let tools = registry.as_array().expect("array");
        assert!(tools.iter().any(|item| item["name"] == "list_children"));
        assert!(
            tools
                .iter()
                .any(|item| item["name"] == "get_recommendation")
        );
        assert!(
            tools
                .iter()
                .any(|item| item["name"] == "record_recommendation")
        );
    }

    #[test]
    fn recommendation_is_generated_automatically_from_python_signals() {
        let text = recommendation_template("tidak_hadir").expect("known code");
        assert!(text.contains("tidak hadir"));
        let not_rising = automatic_recommendation(&json!({
            "signals": {"statusNaik": "T", "notRisingCount": 3, "notRisingRate": 1.0}
        }));
        assert_eq!(not_rising["code"], "tidak_naik");
        assert!(not_rising["text"].as_str().unwrap().contains("tidak naik"));
        assert_eq!(not_rising["automatic"], true);
        let nested_not_rising = automatic_recommendation(&json!({
            "analysis": {"historySignals": {"weightGain": {"current": "T", "notRisingCount": 2}}}
        }));
        assert_eq!(nested_not_rising["code"], "tidak_naik");

        let severe = automatic_recommendation(&json!({
            "signals": {"statusGizi": {"BB/U": "Berat sangat kurang"}, "riskLevel": "tinggi"}
        }));
        assert_eq!(severe["code"], "rujuk_tenaga_kesehatan");

        let default_recommendation = automatic_recommendation(&json!({}));
        assert_eq!(default_recommendation["code"], "monitoring");
        let normal = automatic_recommendation(&json!({
            "signals": {"statusGizi": {"BB/U": "Berat normal"}, "statusNaik": "N"}
        }));
        assert_eq!(normal["code"], "monitoring");
        let manual_code = automatic_recommendation(&json!({
            "recommendation_code": "rujuk_tenaga_kesehatan",
            "signals": {"statusNaik": "N"}
        }));
        assert_eq!(manual_code["code"], "monitoring");
        assert!(recommendation_template("unknown").is_none());
    }

    #[test]
    fn diagnosis_keys_are_rejected() {
        let error =
            validate_arguments(&json!({"items":[{"diagnosis":"x"}]})).expect_err("must reject");
        assert!(error.message.contains("diagnosis"));
    }

    #[test]
    fn writes_require_confirmation() {
        let error = require_confirmation(&json!({})).expect_err("must reject");
        assert!(error.message.contains("confirmed=true"));
        require_confirmation(&json!({"confirmed":true})).expect("confirmed");
    }

    #[test]
    fn sensitive_identity_fields_are_redacted() {
        let value = redact_sensitive(json!({
            "nik": "3509000000000001",
            "childId": "3509000000000001",
            "name": "Anak"
        }));
        assert!(value.get("nik").is_none());
        assert_eq!(value["childId"], "3509********0001");
        assert_eq!(value["name"], "Anak");
    }

    #[test]
    fn path_ids_cannot_escape_collection_route() {
        assert!(valid_path_id("6a2b-uuid_1"));
        assert!(!valid_path_id("../secrets"));
        assert!(!valid_path_id("id/with/slash"));
    }
}
