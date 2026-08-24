use std::{
    env,
    net::{SocketAddr, TcpStream},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use reqwest::{Client, Url, redirect::Policy};
use serde::Serialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tower_http::{
    limit::RequestBodyLimitLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};
use tracing::{error, info};

mod native_api;
mod native_auth;
mod native_cache;
mod native_db;

use native_api::NativeApi;
use native_auth::NativeAuth;
use native_db::NativeDatabase;

const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:8081";
const DEFAULT_MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_ID_HEADER: &str = "x-request-id";
const ORACLE_ORIGIN_HEADER: &str = "x-e-posyandu-origin";
const OPERATIONAL_CHECK_TIMEOUT: Duration = Duration::from_secs(8);
const GRAPHQL_SCHEMA: &str = include_str!("../../../backend/graphql-schema.graphql");
const OPENAPI_DOCUMENT: &str = include_str!("../../../backend/openapi.json");

#[derive(Clone)]
struct AppState {
    client: Client,
    legacy_origin: Url,
    legacy_readiness_url: Url,
    nutrition_health_url: Url,
    public_origin: Url,
    migration_proxy_enabled: bool,
    native_database: Option<Arc<NativeDatabase>>,
    native_auth: Option<Arc<NativeAuth>>,
    native_api: Option<Arc<NativeApi>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthPayload<'a> {
    ok: bool,
    service: &'a str,
    database: &'a str,
    mode: &'a str,
    version: &'a str,
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    error: ErrorBody<'a>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
}

struct OperationalCheck {
    reachable: bool,
    ok: bool,
    status: String,
    latency_ms: u128,
    payload: Option<Value>,
}

fn env_flag(name: &str, fallback: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(fallback)
}

fn legacy_origin() -> Result<Url, String> {
    let configured = env::var("ORACLE_API_LEGACY_ORIGIN")
        .map_err(|_| "ORACLE_API_LEGACY_ORIGIN wajib diisi selama migrasi.".to_string())?;
    let mut parsed = Url::parse(configured.trim())
        .map_err(|_| "ORACLE_API_LEGACY_ORIGIN bukan URL valid.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("ORACLE_API_LEGACY_ORIGIN wajib memakai HTTPS.".into());
    }
    if parsed.username() != "" || parsed.password().is_some() || parsed.query().is_some() {
        return Err("ORACLE_API_LEGACY_ORIGIN tidak boleh memiliki kredensial atau query.".into());
    }
    parsed.set_path("");
    parsed.set_fragment(None);
    Ok(parsed)
}

fn public_origin() -> Result<Url, String> {
    let configured = env::var("ORACLE_API_PUBLIC_ORIGIN")
        .unwrap_or_else(|_| "https://api.eposyandu.app".to_string());
    let mut parsed = Url::parse(configured.trim())
        .map_err(|_| "ORACLE_API_PUBLIC_ORIGIN bukan URL valid.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("ORACLE_API_PUBLIC_ORIGIN wajib memakai HTTPS.".into());
    }
    if parsed.username() != "" || parsed.password().is_some() || parsed.query().is_some() {
        return Err("ORACLE_API_PUBLIC_ORIGIN tidak boleh memiliki kredensial atau query.".into());
    }
    parsed.set_path("");
    parsed.set_fragment(None);
    Ok(parsed)
}

fn operational_url(name: &str, fallback: &str) -> Result<Url, String> {
    let configured = env::var(name).unwrap_or_else(|_| fallback.to_string());
    let parsed = Url::parse(configured.trim()).map_err(|_| format!("{name} bukan URL valid."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("{name} wajib memakai HTTP atau HTTPS."));
    }
    if parsed.username() != "" || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err(format!(
            "{name} tidak boleh memiliki kredensial atau fragment."
        ));
    }
    Ok(parsed)
}

fn allowed_proxy_path(path: &str) -> bool {
    path == "/api/health" || path.starts_with("/api/v1/") || path.starts_with("/internal/v1/")
}

fn hop_by_hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "proxy-connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    )
}

async fn liveness(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let native_writes = state
        .native_api
        .as_ref()
        .is_some_and(|api| api.writes_enabled());
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        axum::Json(HealthPayload {
            ok: true,
            service: "e-posyandu-oracle-api",
            database: if native_writes {
                "oracle-postgresql"
            } else {
                "supabase"
            },
            mode: if native_writes {
                "oracle-native-core"
            } else {
                "hybrid-native-proxy"
            },
            version: env!("CARGO_PKG_VERSION"),
        }),
    )
}

fn native_json(payload: Value, cache_control: &'static str) -> Response {
    let mut response = (
        StatusCode::OK,
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

async fn api_health(State(state): State<Arc<AppState>>) -> Response {
    let native_reads = state
        .native_api
        .as_ref()
        .is_some_and(|api| api.reads_enabled());
    let native_writes = state
        .native_api
        .as_ref()
        .is_some_and(|api| api.writes_enabled());
    native_json(
        json!({
            "ok": true,
            "service": "e-posyandu-oracle-api",
            "database": if native_writes { "oracle-postgresql" } else { "supabase" },
            "mode": if native_reads && native_writes { "oracle-native-core" } else { "hybrid-native-proxy" },
            "version": env!("CARGO_PKG_VERSION")
        }),
        "public, max-age=60",
    )
}

async fn openapi_document(State(state): State<Arc<AppState>>) -> Response {
    let mut document: Value = match serde_json::from_str(OPENAPI_DOCUMENT) {
        Ok(document) => document,
        Err(_) => {
            return failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_openapi_document",
                "Dokumentasi API tidak valid.",
            );
        }
    };
    document["servers"] = json!([{ "url": state.public_origin.as_str() }]);
    native_json(document, "public, max-age=300")
}

async fn graphql_schema() -> Response {
    native_json(json!({ "schema": GRAPHQL_SCHEMA }), "public, max-age=300")
}

fn readiness_state(core_ok: bool, optional_ok: bool) -> &'static str {
    if !core_ok {
        "not-ready"
    } else if !optional_ok {
        "degraded"
    } else {
        "ready"
    }
}

fn component_configured(payload: Option<&Value>, component: &str) -> bool {
    payload
        .and_then(|value| value.pointer(&format!("/components/{component}/configured")))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

async fn check_legacy_readiness(state: &AppState) -> OperationalCheck {
    let started_at = Instant::now();
    let response = state
        .client
        .get(state.legacy_readiness_url.clone())
        .timeout(OPERATIONAL_CHECK_TIMEOUT)
        .send()
        .await;
    match response {
        Ok(response) => {
            let http_ok = response.status().is_success();
            match response.json::<Value>().await {
                Ok(payload) => {
                    let ready = http_ok && payload.get("ok").and_then(Value::as_bool) == Some(true);
                    let status = payload
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or(if ready { "ready" } else { "not-ready" })
                        .to_string();
                    OperationalCheck {
                        reachable: true,
                        ok: ready,
                        status,
                        latency_ms: started_at.elapsed().as_millis(),
                        payload: Some(payload),
                    }
                }
                Err(error_value) => {
                    error!(error = %error_value, "respons readiness legacy bukan JSON valid");
                    OperationalCheck {
                        reachable: true,
                        ok: false,
                        status: "invalid-response".into(),
                        latency_ms: started_at.elapsed().as_millis(),
                        payload: None,
                    }
                }
            }
        }
        Err(error_value) => {
            error!(error = %error_value, "readiness legacy tidak dapat dijangkau");
            OperationalCheck {
                reachable: false,
                ok: false,
                status: "unavailable".into(),
                latency_ms: started_at.elapsed().as_millis(),
                payload: None,
            }
        }
    }
}

async fn check_nutrition_worker(state: &AppState) -> OperationalCheck {
    let started_at = Instant::now();
    let response = state
        .client
        .get(state.nutrition_health_url.clone())
        .timeout(OPERATIONAL_CHECK_TIMEOUT)
        .send()
        .await;
    match response {
        Ok(response) => {
            let http_ok = response.status().is_success();
            let body = response.text().await.unwrap_or_default();
            let healthy = http_ok && body.to_ascii_lowercase().contains("nutrition worker aktif");
            OperationalCheck {
                reachable: true,
                ok: healthy,
                status: if healthy { "healthy" } else { "unhealthy" }.into(),
                latency_ms: started_at.elapsed().as_millis(),
                payload: None,
            }
        }
        Err(error_value) => {
            error!(error = %error_value, "worker nutrisi internal tidak dapat dijangkau");
            OperationalCheck {
                reachable: false,
                ok: false,
                status: "unavailable".into(),
                latency_ms: started_at.elapsed().as_millis(),
                payload: None,
            }
        }
    }
}

async fn readiness(State(state): State<Arc<AppState>>) -> Response {
    let database_check = async {
        match state.native_database.as_ref() {
            Some(database) => database.ready().await,
            _ => false,
        }
    };
    let cache_check = async {
        match state.native_api.as_ref() {
            Some(api) if api.cache_configured() => api.cache_ready().await,
            _ => false,
        }
    };
    let (legacy, nutrition, native_database_ready, native_cache_ready) = tokio::join!(
        check_legacy_readiness(state.as_ref()),
        check_nutrition_worker(state.as_ref()),
        database_check,
        cache_check
    );
    let checked_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into());
    let database_configured = component_configured(legacy.payload.as_ref(), "database");
    let legacy_cache_configured = component_configured(legacy.payload.as_ref(), "cache");
    let queue_configured = component_configured(legacy.payload.as_ref(), "queue");
    let storage_configured = component_configured(legacy.payload.as_ref(), "storage");
    let native_auth_configured = state
        .native_auth
        .as_ref()
        .is_some_and(|auth| auth.configured());
    let native_core_enabled = state
        .native_api
        .as_ref()
        .is_some_and(|api| api.native_core_enabled());
    let native_reads_enabled = state
        .native_api
        .as_ref()
        .is_some_and(|api| api.reads_enabled());
    let native_writes_enabled = state
        .native_api
        .as_ref()
        .is_some_and(|api| api.writes_enabled());
    let native_mode_configured =
        native_auth_configured || native_reads_enabled || native_writes_enabled;
    let native_queue_configured = state
        .native_api
        .as_ref()
        .is_some_and(|api| api.queue_configured());
    let native_cache_configured = state
        .native_api
        .as_ref()
        .is_some_and(|api| api.cache_configured());
    let core_ok = if native_mode_configured {
        native_auth_configured && native_database_ready
    } else {
        legacy.ok
    };
    let optional_ok = nutrition.ok
        && (!state.migration_proxy_enabled || legacy.ok)
        && (!native_cache_configured || native_cache_ready);
    let status = readiness_state(core_ok, optional_ok);

    native_json(
        json!({
            "ok": core_ok,
            "status": status,
            "checkedAt": checked_at,
            "environment": "production-hybrid-oracle",
            "components": {
                "api": {
                    "status": "healthy",
                    "origin": "oracle-native"
                },
                "database": {
                    "configured": if native_mode_configured { native_database_ready } else { database_configured },
                    "primary": if native_writes_enabled { "oracle-postgresql" } else { "supabase" },
                    "accessPath": if native_core_enabled { "oracle-native" } else if native_mode_configured { "oracle-native-and-legacy" } else { "legacy-cloudflare" }
                },
                "authentication": {
                    "configured": native_auth_configured,
                    "origin": if native_auth_configured { "oracle-native" } else { "legacy-cloudflare" },
                    "sessionStorage": if native_auth_configured { "oracle-encrypted-sqlite" } else { "cloudflare-kv" }
                },
                "readStandby": {
                    "configured": false,
                    "provider": null,
                    "mode": "removed-stage-2"
                },
                "cache": {
                    "configured": if native_mode_configured { native_cache_configured } else { legacy_cache_configured },
                    "reachable": if native_mode_configured { native_cache_ready } else { legacy_cache_configured },
                    "managedBy": if native_cache_configured { "oracle-redis" } else { "legacy-cloudflare-global-kv" },
                    "dynamicTtlSeconds": if native_cache_configured { Some(60) } else { None }
                },
                "queue": {
                    "configured": queue_configured || native_queue_configured,
                    "managedBy": "legacy-cloudflare"
                },
                "storage": {
                    "configured": storage_configured,
                    "managedBy": "legacy-cloudflare"
                },
                "migrationProxy": {
                    "enabled": state.migration_proxy_enabled,
                    "reachable": legacy.reachable,
                    "status": legacy.status,
                    "latencyMs": legacy.latency_ms
                },
                "nativeCore": {
                    "enabled": native_core_enabled,
                    "databaseReachable": native_database_ready,
                    "reads": native_reads_enabled,
                    "writes": native_writes_enabled
                },
                "nutritionWorker": {
                    "reachable": nutrition.reachable,
                    "status": nutrition.status,
                    "latencyMs": nutrition.latency_ms
                }
            }
        }),
        "no-store",
    )
}

async fn auth_login(State(state): State<Arc<AppState>>, request: Request) -> Response {
    match state.native_auth.as_ref() {
        Some(auth) => auth.login(request).await,
        None => migration_proxy(State(state), request).await,
    }
}

async fn auth_logout(State(state): State<Arc<AppState>>, request: Request) -> Response {
    match state.native_auth.as_ref() {
        Some(auth) => auth.logout(request).await,
        None => migration_proxy(State(state), request).await,
    }
}

async fn auth_session(State(state): State<Arc<AppState>>, request: Request) -> Response {
    match state.native_auth.as_ref() {
        Some(auth) => auth.session(request).await,
        None => migration_proxy(State(state), request).await,
    }
}

async fn current_profile(State(state): State<Arc<AppState>>, request: Request) -> Response {
    match state.native_auth.as_ref() {
        Some(auth) => auth.me(request).await,
        None => migration_proxy(State(state), request).await,
    }
}

fn failure(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        axum::Json(ErrorPayload {
            error: ErrorBody { code, message },
        }),
    )
        .into_response()
}

async fn migration_proxy(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if !state.migration_proxy_enabled {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "migration_proxy_disabled",
            "Rute ini belum tersedia pada API native Oracle.",
        );
    }

    let path = request.uri().path();
    if !allowed_proxy_path(path) {
        return failure(StatusCode::NOT_FOUND, "not_found", "Rute tidak ditemukan.");
    }

    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or(path);
    let upstream_url = match state
        .legacy_origin
        .join(path_and_query.trim_start_matches('/'))
    {
        Ok(url) => url,
        Err(_) => {
            return failure(
                StatusCode::BAD_REQUEST,
                "invalid_upstream_url",
                "URL permintaan tidak valid.",
            );
        }
    };

    let method = request.method().clone();
    let request_headers = request.headers().clone();
    let native_authorization = match state.native_auth.as_ref() {
        Some(auth) => match auth.legacy_authorization(request_headers).await {
            Ok(value) => value,
            Err(response) => return response,
        },
        None => None,
    };
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers() {
        if !hop_by_hop_header(name) {
            headers.append(name, value.clone());
        }
    }
    if let Some(authorization) = native_authorization {
        headers.insert(header::AUTHORIZATION, authorization);
        headers.remove(header::COOKIE);
    }
    headers.insert(
        HeaderName::from_static("x-e-posyandu-origin"),
        HeaderValue::from_static("oracle-migration"),
    );

    let body = request.into_body();
    let upstream = match state
        .client
        .request(method, upstream_url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error_value) => {
            error!(error = %error_value, "legacy API tidak dapat dijangkau");
            return failure(
                StatusCode::BAD_GATEWAY,
                "upstream_unavailable",
                "API sementara tidak dapat dijangkau.",
            );
        }
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    for (name, value) in &upstream_headers {
        if !hop_by_hop_header(name) {
            response.headers_mut().append(name, value.clone());
        }
    }
    response.headers_mut().insert(
        HeaderName::from_static("x-e-posyandu-origin"),
        HeaderValue::from_static("oracle-migration"),
    );
    response
}

async fn api_dispatch(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(api) = state.native_api.as_ref()
        && api.handles(&request)
    {
        return api.handle(request).await;
    }
    migration_proxy(State(state), request).await
}

async fn fallback(uri: Uri) -> Response {
    if allowed_proxy_path(uri.path()) {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "route_unavailable",
            "Rute migrasi tidak tersedia.",
        );
    }
    failure(StatusCode::NOT_FOUND, "not_found", "Rute tidak ditemukan.")
}

fn local_healthcheck() -> bool {
    let address =
        env::var("ORACLE_API_HEALTHCHECK_ADDR").unwrap_or_else(|_| "127.0.0.1:8081".to_string());
    TcpStream::connect_timeout(
        &address
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:8081".parse().unwrap()),
        Duration::from_secs(3),
    )
    .is_ok()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let terminate = async {
            if let Ok(mut stream) = signal(SignalKind::terminate()) {
                stream.recv().await;
            }
        };
        tokio::select! {
            () = ctrl_c => {},
            () = terminate => {},
        }
    }

    #[cfg(not(unix))]
    ctrl_c.await;
}

#[tokio::main]
async fn main() {
    if env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(if local_healthcheck() { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "e_posyandu_oracle_api=info,tower_http=info".into()),
        )
        .init();

    let address: SocketAddr = env::var("ORACLE_API_LISTEN_ADDR")
        .unwrap_or_else(|_| DEFAULT_LISTEN_ADDR.to_string())
        .parse()
        .expect("ORACLE_API_LISTEN_ADDR tidak valid");
    let legacy_origin = legacy_origin().expect("konfigurasi legacy origin tidak valid");
    let legacy_readiness_url = legacy_origin
        .join("api/v1/health/ready")
        .expect("URL readiness legacy tidak valid");
    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .expect("HTTP client tidak dapat dibuat");
    let native_auth_enabled = env_flag("ORACLE_API_NATIVE_AUTH_ENABLED", false);
    let native_reads_enabled = env_flag("ORACLE_API_NATIVE_READS_ENABLED", false);
    let native_writes_enabled = env_flag("ORACLE_API_NATIVE_WRITES_ENABLED", false);
    let native_database = if native_auth_enabled || native_reads_enabled || native_writes_enabled {
        Some(Arc::new(
            NativeDatabase::from_env().expect("konfigurasi PostgreSQL native Oracle tidak valid"),
        ))
    } else {
        None
    };
    let native_auth = NativeAuth::from_env(client.clone(), native_database.clone())
        .expect("konfigurasi autentikasi native Oracle tidak valid")
        .map(Arc::new);
    let native_api = if native_reads_enabled || native_writes_enabled {
        let auth = native_auth.as_ref().expect(
            "ORACLE_API_NATIVE_READS_ENABLED/WRITES_ENABLED membutuhkan ORACLE_API_NATIVE_AUTH_ENABLED=true",
        );
        let database = native_database
            .as_ref()
            .expect("PostgreSQL native wajib tersedia untuk API native Oracle");
        Some(Arc::new(
            NativeApi::from_env(
                client.clone(),
                auth.clone(),
                database.clone(),
                native_reads_enabled,
                native_writes_enabled,
            )
            .await
            .expect("konfigurasi endpoint baca native Oracle tidak valid"),
        ))
    } else {
        None
    };
    let state = Arc::new(AppState {
        client,
        legacy_origin,
        legacy_readiness_url,
        nutrition_health_url: operational_url(
            "ORACLE_API_NUTRITION_HEALTH_URL",
            "http://nutrition-worker:8080/health",
        )
        .expect("konfigurasi URL health worker nutrisi tidak valid"),
        public_origin: public_origin().expect("konfigurasi public origin tidak valid"),
        migration_proxy_enabled: env_flag("ORACLE_API_MIGRATION_PROXY_ENABLED", true),
        native_database,
        native_auth,
        native_api,
    });

    let request_id_header = HeaderName::from_static(REQUEST_ID_HEADER);
    let app = Router::new()
        .route("/health", get(liveness))
        .route("/api/health", get(api_health))
        .route("/api/v1/health", get(api_health))
        .route("/api/v1/health/ready", get(readiness))
        .route("/api/v1/openapi.json", get(openapi_document))
        .route("/api/v1/graphql/schema", get(graphql_schema))
        .route("/api/v1/auth/login", axum::routing::post(auth_login))
        .route("/api/v1/auth/logout", axum::routing::post(auth_logout))
        .route("/api/v1/auth/session", get(auth_session))
        .route("/api/v1/me", get(current_profile))
        .route("/api/{*path}", any(api_dispatch))
        .route("/internal/{*path}", any(migration_proxy))
        .fallback(fallback)
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(DEFAULT_MAX_BODY_BYTES))
        .layer(PropagateRequestIdLayer::new(request_id_header.clone()))
        .layer(SetRequestIdLayer::new(request_id_header, MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("port API Oracle tidak dapat dibuka");
    info!(%address, "E-Posyandu Oracle API migration gateway aktif");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server API Oracle berhenti tidak normal");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_only_allows_application_and_internal_api_paths() {
        assert!(allowed_proxy_path("/api/health"));
        assert!(allowed_proxy_path("/api/v1/health"));
        assert!(allowed_proxy_path("/internal/v1/jobs/example"));
        assert!(!allowed_proxy_path("/"));
        assert!(!allowed_proxy_path("/admin"));
        assert!(!allowed_proxy_path("/api/private"));
    }

    #[test]
    fn strips_hop_by_hop_and_length_headers() {
        for name in ["connection", "host", "content-length", "transfer-encoding"] {
            assert!(hop_by_hop_header(
                &HeaderName::from_bytes(name.as_bytes()).unwrap()
            ));
        }
        assert!(!hop_by_hop_header(&header::AUTHORIZATION));
        assert!(!hop_by_hop_header(&header::COOKIE));
    }

    #[test]
    fn native_documents_are_valid_and_shared() {
        let openapi: Value = serde_json::from_str(OPENAPI_DOCUMENT).expect("valid OpenAPI");
        assert_eq!(openapi["openapi"], "3.1.0");
        assert!(openapi["paths"]["/api/v1/health"].is_object());
        assert!(GRAPHQL_SCHEMA.contains("dashboardStats"));
        assert!(GRAPHQL_SCHEMA.contains("exclusiveBreastfeedingPage"));
    }

    #[test]
    fn readiness_requires_core_and_degrades_for_optional_components() {
        assert_eq!(readiness_state(true, true), "ready");
        assert_eq!(readiness_state(true, false), "degraded");
        assert_eq!(readiness_state(false, true), "not-ready");
    }

    #[test]
    fn reads_only_boolean_component_configuration() {
        let payload = json!({ "components": { "database": { "configured": true } } });
        assert!(component_configured(Some(&payload), "database"));
        assert!(!component_configured(Some(&payload), "queue"));
        assert!(!component_configured(None, "database"));
    }
}
