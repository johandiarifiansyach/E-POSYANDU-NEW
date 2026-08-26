use std::{
    convert::Infallible,
    env,
    net::{SocketAddr, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{any, get, patch},
};
use futures_util::stream;
use reqwest::{Client, Url, redirect::Policy};
use serde::Serialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tower_http::{
    limit::RequestBodyLimitLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};
use tracing::{error, info, warn};

mod native_api;
mod native_auth;
mod native_cache;
mod native_db;
mod nutrition_client;
mod platform_client;
mod realtime;
mod system_metrics;

use native_api::NativeApi;
use native_auth::NativeAuth;
use native_cache::{DASHBOARD_CACHE_TTL_SECONDS, DYNAMIC_CACHE_TTL_SECONDS};
use native_db::NativeDatabase;
use nutrition_client::NutritionGrpcClient;
use platform_client::PlatformGrpcClients;
use realtime::{RealtimeEvent, RealtimeHub};
use system_metrics::SystemMetricsSampler;

const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:8081";
const DEFAULT_MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_ID_HEADER: &str = "x-request-id";
const ORACLE_ORIGIN_HEADER: &str = "x-e-posyandu-origin";
const OPERATIONAL_CHECK_TIMEOUT: Duration = Duration::from_secs(8);
const ADMIN_MONITORING_INTERVAL: Duration = Duration::from_secs(5);
const ADMIN_MONITORING_CONNECTION_LIMIT: usize = 4;
const REALTIME_CONNECTION_LIMIT: usize = 100;
const RETENTION_CLEANUP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const GRAPHQL_SCHEMA: &str = include_str!("../../../backend/graphql-schema.graphql");
const OPENAPI_DOCUMENT: &str = include_str!("../../../backend/openapi.json");

#[derive(Clone)]
struct AppState {
    client: Client,
    legacy_origin: Url,
    legacy_readiness_url: Url,
    nutrition_grpc: NutritionGrpcClient,
    microservices: Option<Arc<PlatformGrpcClients>>,
    public_origin: Url,
    migration_proxy_enabled: bool,
    health_database: Option<Arc<NativeDatabase>>,
    native_database: Option<Arc<NativeDatabase>>,
    native_auth: Option<Arc<NativeAuth>>,
    native_api: Option<Arc<NativeApi>>,
    monitoring_connections: Arc<AtomicUsize>,
    realtime: RealtimeHub,
    realtime_connections: Arc<AtomicUsize>,
}

struct MonitoringConnectionGuard {
    active: Arc<AtomicUsize>,
}

impl Drop for MonitoringConnectionGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_monitoring_connection(active: Arc<AtomicUsize>) -> Option<MonitoringConnectionGuard> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < ADMIN_MONITORING_CONNECTION_LIMIT).then_some(current + 1)
        })
        .ok()?;
    Some(MonitoringConnectionGuard { active })
}

struct RealtimeConnectionGuard {
    active: Arc<AtomicUsize>,
}

impl Drop for RealtimeConnectionGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_realtime_connection(active: Arc<AtomicUsize>) -> Option<RealtimeConnectionGuard> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < REALTIME_CONNECTION_LIMIT).then_some(current + 1)
        })
        .ok()?;
    Some(RealtimeConnectionGuard { active })
}

struct MonitoringStreamState {
    app: Arc<AppState>,
    sampler: SystemMetricsSampler,
    sequence: u64,
    first: bool,
    _connection: MonitoringConnectionGuard,
}

struct RealtimeStreamState {
    receiver: tokio::sync::broadcast::Receiver<RealtimeEvent>,
    scope: native_auth::AccessScope,
    sequence: u64,
    _connection: RealtimeConnectionGuard,
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
    match tokio::time::timeout(
        OPERATIONAL_CHECK_TIMEOUT,
        state.nutrition_grpc.health_check(),
    )
    .await
    {
        Ok(Ok(())) => OperationalCheck {
            reachable: true,
            ok: true,
            status: "healthy".into(),
            latency_ms: started_at.elapsed().as_millis(),
            payload: None,
        },
        Ok(Err(error_value)) => {
            error!(error = %error_value, "worker nutrisi gRPC tidak sehat");
            OperationalCheck {
                reachable: true,
                ok: false,
                status: "unhealthy".into(),
                latency_ms: started_at.elapsed().as_millis(),
                payload: None,
            }
        }
        Err(error_value) => {
            error!(error = %error_value, "worker nutrisi gRPC tidak dapat dijangkau");
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

async fn check_oracle_database(state: &AppState) -> OperationalCheck {
    let started_at = Instant::now();
    let Some(database) = state.health_database.as_ref() else {
        return OperationalCheck {
            reachable: false,
            ok: false,
            status: "unconfigured".into(),
            latency_ms: 0,
            payload: None,
        };
    };
    let reachable = tokio::time::timeout(OPERATIONAL_CHECK_TIMEOUT, database.ready())
        .await
        .unwrap_or(false);
    OperationalCheck {
        reachable,
        ok: reachable,
        status: if reachable { "healthy" } else { "unavailable" }.into(),
        latency_ms: started_at.elapsed().as_millis(),
        payload: None,
    }
}

async fn check_redis_cache(state: &AppState) -> OperationalCheck {
    let started_at = Instant::now();
    let Some(url) = env::var("ORACLE_REDIS_URL")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return OperationalCheck {
            reachable: false,
            ok: false,
            status: "unconfigured".into(),
            latency_ms: 0,
            payload: None,
        };
    };
    let result = async {
        let client = redis::Client::open(url).map_err(|_| ())?;
        let mut connection = redis::aio::ConnectionManager::new(client)
            .await
            .map_err(|_| ())?;
        redis::cmd("PING")
            .query_async::<String>(&mut connection)
            .await
            .map_err(|_| ())
    };
    let healthy = tokio::time::timeout(OPERATIONAL_CHECK_TIMEOUT, result)
        .await
        .ok()
        .and_then(Result::ok)
        .is_some_and(|value| value == "PONG");
    OperationalCheck {
        reachable: healthy,
        ok: healthy,
        status: if healthy { "healthy" } else { "unavailable" }.into(),
        latency_ms: started_at.elapsed().as_millis(),
        payload: None,
    }
}

async fn check_platform_services(state: &AppState) -> OperationalCheck {
    let Some(platform) = state.microservices.as_ref() else {
        return OperationalCheck {
            reachable: false,
            ok: true,
            status: "disabled".into(),
            latency_ms: 0,
            payload: None,
        };
    };
    let started_at = Instant::now();
    let statuses = match tokio::time::timeout(
        OPERATIONAL_CHECK_TIMEOUT,
        platform.health_statuses(),
    )
    .await
    {
        Ok(statuses) => statuses,
        Err(error_value) => {
            error!(error = %error_value, "domain microservices gRPC tidak dapat dijangkau");
            return OperationalCheck {
                reachable: false,
                ok: false,
                status: "unavailable".into(),
                latency_ms: started_at.elapsed().as_millis(),
                payload: None,
            };
        }
    };
    let mut details = serde_json::Map::new();
    let mut all_reachable = true;
    let mut all_healthy = true;
    let mut max_latency = 0;
    for (name, reachable, healthy, latency_ms) in statuses {
        all_reachable &= reachable;
        all_healthy &= healthy;
        max_latency = max_latency.max(latency_ms);
        details.insert(
            name.to_owned(),
            json!({
                "reachable": reachable,
                "status": if healthy { "healthy" } else if reachable { "unhealthy" } else { "unavailable" },
                "latencyMs": latency_ms,
                "protocol": "grpc"
            }),
        );
    }
    OperationalCheck {
        reachable: all_reachable,
        ok: all_reachable && all_healthy,
        status: if !all_reachable {
            "unavailable"
        } else if !all_healthy {
            "unhealthy"
        } else {
            "healthy"
        }
        .into(),
        latency_ms: max_latency,
        payload: Some(Value::Object(details)),
    }
}

async fn readiness(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let cache_check = async {
        match state.native_api.as_ref() {
            Some(api) if api.cache_configured() => api.cache_ready().await,
            _ => false,
        }
    };
    let (legacy, nutrition, microservices, oracle_database, redis_cache, native_cache_ready) = tokio::join!(
        check_legacy_readiness(state.as_ref()),
        check_nutrition_worker(state.as_ref()),
        check_platform_services(state.as_ref()),
        check_oracle_database(state.as_ref()),
        check_redis_cache(state.as_ref()),
        cache_check
    );
    let oracle_database_ready = oracle_database.ok;
    let native_database_ready = oracle_database_ready;
    let checked_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into());
    let database_configured = component_configured(legacy.payload.as_ref(), "database");
    let legacy_cache_configured = component_configured(legacy.payload.as_ref(), "cache");
    let queue_configured = component_configured(legacy.payload.as_ref(), "queue");
    let storage_configured = component_configured(legacy.payload.as_ref(), "storage");
    let neon_configured = component_configured(legacy.payload.as_ref(), "readReplica");
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
    let core_ok = if state.microservices.is_some() {
        microservices.ok
    } else if native_mode_configured {
        native_auth_configured && native_database_ready
    } else {
        legacy.ok
    };
    let optional_ok = nutrition.ok
        && (!state.migration_proxy_enabled || legacy.ok)
        && (!native_cache_configured || native_cache_ready);
    let status = readiness_state(core_ok, optional_ok);

    let mut oracle_services = serde_json::Map::new();
    oracle_services.insert(
        "oracle-api".into(),
        json!({
            "reachable": true,
            "status": "healthy",
            "provider": "oracle",
            "protocol": "http"
        }),
    );
    if let Some(details) = microservices.payload.as_ref().and_then(Value::as_object) {
        for (name, value) in details {
            oracle_services.insert(name.clone(), value.clone());
        }
    }
    oracle_services.insert(
        "nutrition-worker".into(),
        json!({
            "reachable": nutrition.reachable,
            "status": nutrition.status,
            "latencyMs": nutrition.latency_ms,
            "provider": "oracle",
            "protocol": "grpc"
        }),
    );
    oracle_services.insert(
        "redis-cache".into(),
        json!({
            "configured": redis_cache.status != "unconfigured",
            "reachable": redis_cache.reachable,
            "status": redis_cache.status,
            "latencyMs": redis_cache.latency_ms,
            "provider": "oracle-redis",
            "protocol": "redis"
        }),
    );
    oracle_services.insert(
        "health-proxy".into(),
        json!({
            "reachable": true,
            "status": "healthy",
            "provider": "caddy"
        }),
    );
    let supabase_online = legacy.reachable && database_configured;
    let via_pages = request.headers().contains_key("x-e-posyandu-proxy");
    let database_services = json!({
        "oracle-database": {
            "configured": state.health_database.is_some(),
            "reachable": oracle_database.reachable,
            "status": oracle_database.status,
            "latencyMs": oracle_database.latency_ms,
            "provider": "oracle-postgresql"
        },
        "supabase-database": {
            "configured": database_configured,
            "reachable": supabase_online,
            "status": if supabase_online { "healthy" } else { "unavailable" },
            "latencyMs": legacy.latency_ms,
            "provider": "supabase",
            "source": "cloudflare-api-readiness"
        },
        "neon-database": {
            "configured": neon_configured,
            "reachable": neon_configured,
            "status": if neon_configured { "healthy" } else { "unconfigured" },
            "provider": "neon-read-replica"
        }
    });
    let frontend_services = json!({
        "edge-api": {
            "configured": true,
            "reachable": legacy.reachable,
            "status": if legacy.reachable { "healthy" } else { "unavailable" },
            "provider": "cloudflare-edge-api",
            "latencyMs": legacy.latency_ms
        },
        "cloudflare-pages": {
            "configured": via_pages,
            "reachable": via_pages,
            "status": if via_pages { "healthy" } else { "unconfigured" },
            "provider": "cloudflare-pages"
        },
        "cloudflare-queue": {
            "configured": queue_configured,
            "reachable": queue_configured,
            "status": if queue_configured { "healthy" } else { "unconfigured" },
            "provider": "cloudflare-queues"
        }
    });

    native_json(
        json!({
            "ok": core_ok,
            "status": status,
            "checkedAt": checked_at,
            "environment": "production-microservices-oracle",
            "components": {
                "api": {
                    "status": "healthy",
                    "origin": "oracle-native"
                },
                "microservices": {
                    "enabled": state.microservices.is_some(),
                    "reachable": microservices.reachable,
                    "status": microservices.status,
                    "latencyMs": microservices.latency_ms,
                    "protocol": "grpc"
                },
                "oracleServices": Value::Object(oracle_services),
                "databases": database_services,
                "frontendServices": frontend_services,
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
                    "dynamicTtlSeconds": if native_cache_configured { Some(DYNAMIC_CACHE_TTL_SECONDS) } else { None },
                    "dashboardTtlSeconds": if native_cache_configured { Some(DASHBOARD_CACHE_TTL_SECONDS) } else { None }
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
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.login(request).await,
        None => migration_proxy(State(state), request).await,
    }
}

async fn auth_mfa_enroll(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.mfa_enroll(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "mfa_unavailable",
            "Verifikasi administrator hanya tersedia pada API utama.",
        ),
    }
}

async fn auth_complete_invite(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.complete_invite(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "invite_unavailable",
            "Aktivasi administrator hanya tersedia pada API utama.",
        ),
    }
}

async fn auth_mfa_challenge(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.mfa_challenge(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "mfa_unavailable",
            "Verifikasi administrator hanya tersedia pada API utama.",
        ),
    }
}

async fn auth_mfa_verify(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.mfa_verify(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "mfa_unavailable",
            "Verifikasi administrator hanya tersedia pada API utama.",
        ),
    }
}

async fn auth_passkey_registration_options(
    State(state): State<Arc<AppState>>,
    request: Request,
) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.passkey_registration_options(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "passkey_unavailable",
            "Passkey hanya tersedia pada API utama.",
        ),
    }
}

async fn auth_passkey_registration_verify(
    State(state): State<Arc<AppState>>,
    request: Request,
) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.passkey_registration_verify(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "passkey_unavailable",
            "Passkey hanya tersedia pada API utama.",
        ),
    }
}

async fn auth_passkey_authentication_options(
    State(state): State<Arc<AppState>>,
    request: Request,
) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.passkey_authentication_options(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "passkey_unavailable",
            "Passkey hanya tersedia pada API utama.",
        ),
    }
}

async fn auth_passkey_authentication_verify(
    State(state): State<Arc<AppState>>,
    request: Request,
) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.passkey_authentication_verify(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "passkey_unavailable",
            "Passkey hanya tersedia pada API utama.",
        ),
    }
}

async fn auth_logout(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.logout(request).await,
        None => migration_proxy(State(state), request).await,
    }
}

async fn auth_session(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.session(request).await,
        None => migration_proxy(State(state), request).await,
    }
}

async fn auth_presence(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.presence(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "presence_unavailable",
            "Pemantauan status akun hanya tersedia pada API utama.",
        ),
    }
}

async fn admin_accounts(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    let headers = request.headers().clone();
    drop(request);
    match state.native_auth.as_ref() {
        Some(auth) => match auth.admin_accounts(headers).await {
            Ok(payload) => native_json(payload, "no-store"),
            Err(response) => response,
        },
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "admin_unavailable",
            "Administrasi backend hanya tersedia pada API utama.",
        ),
    }
}

async fn monitoring_stream_payload(
    state: &AppState,
    sampler: &mut SystemMetricsSampler,
    sequence: u64,
) -> Value {
    let system = sampler.sample();
    let database_check = async {
        match state.native_database.as_ref() {
            Some(database) => database.ready().await,
            None => false,
        }
    };
    let cache_check = async {
        match state.native_api.as_ref() {
            Some(api) if api.cache_configured() => api.cache_ready().await,
            _ => false,
        }
    };
    let (database_online, cache_online, nutrition) =
        tokio::join!(database_check, cache_check, check_nutrition_worker(state));
    json!({
        "sequence": sequence,
        "timestamp": system.timestamp.clone(),
        "intervalSeconds": system.interval_seconds,
        "system": system,
        "services": {
            "api": "online",
            "database": if database_online { "online" } else { "offline" },
            "redis": if cache_online { "online" } else { "offline" },
            "nutritionWorker": if nutrition.ok { "online" } else { "offline" }
        }
    })
}

/// The monitoring domain returns the system payload, while the public SSE
/// contract also carries the gateway sequence and service health summary.
/// Keep that contract identical for the native and gRPC paths so the browser
/// can validate samples without a service-specific branch.
fn complete_monitoring_payload(
    mut payload: Value,
    sequence: u64,
    nutrition_online: bool,
) -> Value {
    let Some(object) = payload.as_object_mut() else {
        return payload;
    };
    object.insert("sequence".to_owned(), json!(sequence));
    let interval = object
        .get("intervalSeconds")
        .cloned()
        .or_else(|| {
            object
                .get("system")
                .and_then(Value::as_object)
                .and_then(|system| system.get("intervalSeconds"))
                .cloned()
        })
        .unwrap_or_else(|| json!(ADMIN_MONITORING_INTERVAL.as_secs_f64()));
    object.entry("intervalSeconds".to_owned()).or_insert(interval);
    let services = object
        .entry("services".to_owned())
        .or_insert_with(|| json!({}));
    if let Some(services) = services.as_object_mut() {
        // Reaching this gateway endpoint proves the API path is online. The
        // nutrition worker is checked through its existing gRPC health probe.
        services.insert("api".to_owned(), json!("online"));
        services.insert(
            "nutritionWorker".to_owned(),
            json!(if nutrition_online { "online" } else { "offline" }),
        );
    }
    payload
}

async fn admin_monitoring_stream(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let mut headers = request.headers().clone();
    drop(request);
    if let Some(platform) = state.microservices.as_ref() {
        // The monitoring service authenticates every snapshot independently.
        // Convert the gateway's secure browser session to a short-lived
        // bearer header once so the session remains valid across the gRPC/UDS
        // boundary. The original cookie is retained for compatibility with
        // older service images and is never exposed to the browser.
        if let Some(auth) = state.native_auth.as_ref() {
            match auth.legacy_authorization(headers.clone()).await {
                Ok(Some(value)) => {
                    headers.insert(header::AUTHORIZATION, value);
                }
                Ok(None) => {}
                Err(response) => return response,
            }
        }
        let Some(connection) = acquire_monitoring_connection(state.monitoring_connections.clone())
        else {
            return failure(
                StatusCode::TOO_MANY_REQUESTS,
                "monitoring_connection_limit",
                "Terlalu banyak koneksi monitoring aktif. Tutup tab monitoring lain lalu coba kembali.",
            );
        };
        let events = stream::unfold(
            (platform.clone(), headers, 0_u64, true, connection, state.clone()),
            |(platform, headers, mut sequence, first, connection, state)| async move {
                tokio::time::sleep(if first {
                    Duration::from_secs(1)
                } else {
                    ADMIN_MONITORING_INTERVAL
                })
                .await;
                sequence = sequence.saturating_add(1);
                let (payload_result, nutrition) = tokio::join!(
                    platform.monitoring_snapshot(headers.clone()),
                    check_nutrition_worker(state.as_ref())
                );
                let payload = payload_result
                    .map(|payload| complete_monitoring_payload(payload, sequence, nutrition.ok))
                    .unwrap_or_else(|error| {
                        json!({
                            "sequence": sequence,
                            "services": {"api": "online", "monitoring": "offline"},
                            "error": error
                        })
                    });
                let event = Event::default()
                    .event("metrics")
                    .id(sequence.to_string())
                    .retry(Duration::from_secs(3))
                    .data(payload.to_string());
                Some((
                    Ok::<Event, Infallible>(event),
                    (platform, headers, sequence, false, connection, state),
                ))
            },
        );
        let mut response = Sse::new(events)
            .keep_alive(
                KeepAlive::new()
                    .interval(Duration::from_secs(15))
                    .text("monitoring-keepalive"),
            )
            .into_response();
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, must-revalidate"),
        );
        response.headers_mut().insert(
            HeaderName::from_static("x-accel-buffering"),
            HeaderValue::from_static("no"),
        );
        return response;
    }
    let Some(auth) = state.native_auth.as_ref() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "monitoring_unavailable",
            "Monitoring realtime hanya tersedia pada API utama.",
        );
    };
    if let Err(response) = auth.require_verified_admin(headers).await {
        return response;
    }
    let Some(connection) = acquire_monitoring_connection(state.monitoring_connections.clone())
    else {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "monitoring_connection_limit",
            "Terlalu banyak koneksi monitoring aktif. Tutup tab monitoring lain lalu coba kembali.",
        );
    };
    let stream_state = MonitoringStreamState {
        app: state,
        sampler: SystemMetricsSampler::new(),
        sequence: 0,
        first: true,
        _connection: connection,
    };
    let events = stream::unfold(stream_state, |mut current| async move {
        tokio::time::sleep(if current.first {
            Duration::from_secs(1)
        } else {
            ADMIN_MONITORING_INTERVAL
        })
        .await;
        current.first = false;
        current.sequence = current.sequence.saturating_add(1);
        let payload =
            monitoring_stream_payload(current.app.as_ref(), &mut current.sampler, current.sequence)
                .await;
        let event = Event::default()
            .event("metrics")
            .id(current.sequence.to_string())
            .retry(Duration::from_secs(3))
            .data(payload.to_string());
        Some((Ok::<Event, Infallible>(event), current))
    });
    let mut response = Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("monitoring-keepalive"),
        )
        .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    response
}

async fn realtime_data_stream(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.realtime(request).await;
    }
    let Some(auth) = state.native_auth.as_ref() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "realtime_unavailable",
            "Realtime data hanya tersedia pada API utama.",
        );
    };
    let session = match auth.authorize(request.headers().clone()).await {
        Ok(session) => session,
        Err(response) => return response,
    };
    let Some(connection) = acquire_realtime_connection(state.realtime_connections.clone()) else {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "realtime_connection_limit",
            "Terlalu banyak koneksi realtime aktif. Tutup tab aplikasi lain lalu coba kembali.",
        );
    };
    let stream_state = RealtimeStreamState {
        receiver: state.realtime.subscribe(),
        scope: session.scope,
        sequence: 0,
        _connection: connection,
    };
    let events = stream::unfold(stream_state, |mut current| async move {
        loop {
            match tokio::time::timeout(Duration::from_secs(30), current.receiver.recv()).await {
                Ok(Ok(event)) if event.visible_to(&current.scope) => {
                    current.sequence = current.sequence.saturating_add(1);
                    let payload = event.public_payload().to_string();
                    let output = Event::default()
                        .event("data")
                        .id(current.sequence.to_string())
                        .retry(Duration::from_secs(3))
                        .data(payload);
                    return Some((Ok::<Event, Infallible>(output), current));
                }
                Ok(Ok(_)) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                    current.sequence = current.sequence.saturating_add(1);
                    let output = Event::default()
                        .event("resync")
                        .id(current.sequence.to_string())
                        .retry(Duration::from_secs(3))
                        .data(r#"{"reason":"lagged"}"#);
                    return Some((Ok::<Event, Infallible>(output), current));
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return None,
                Err(_) => {
                    return Some((
                        Ok::<Event, Infallible>(Event::default().comment("realtime-keepalive")),
                        current,
                    ));
                }
            }
        }
    });
    let mut response = Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("realtime-keepalive"),
        )
        .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    response
}

async fn admin_account_create(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.create_admin_account(request).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "admin_unavailable",
            "Administrasi akun hanya tersedia pada API utama.",
        ),
    }
}

async fn admin_account_update(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<String>,
    request: Request,
) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.update_admin_account(request, user_id).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "admin_unavailable",
            "Administrasi akun hanya tersedia pada API utama.",
        ),
    }
}

async fn admin_account_delete(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<String>,
    request: Request,
) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
    match state.native_auth.as_ref() {
        Some(auth) => auth.delete_admin_account(request, user_id).await,
        None => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "admin_unavailable",
            "Administrasi akun hanya tersedia pada API utama.",
        ),
    }
}

async fn current_profile(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if let Some(platform) = state.microservices.as_ref() {
        return platform.identity(request).await;
    }
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
    if let Some(platform) = state.microservices.as_ref() {
        return platform.operations(request).await;
    }
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
    let realtime = RealtimeHub::new();
    let native_database = if native_auth_enabled || native_reads_enabled || native_writes_enabled {
        Some(Arc::new(
            NativeDatabase::from_env().expect("konfigurasi PostgreSQL native Oracle tidak valid"),
        ))
    } else {
        None
    };
    // Keep a read-only probe available for the admin status page even when
    // the gateway itself is still using the legacy Cloudflare auth path.
    // Domain services remain responsible for application reads and writes.
    let health_database = native_database.clone().or_else(|| {
        NativeDatabase::from_env().ok().map(Arc::new)
    });
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
                realtime.clone(),
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
        nutrition_grpc: NutritionGrpcClient::from_env()
            .expect("konfigurasi URL gRPC worker nutrisi tidak valid"),
        microservices: PlatformGrpcClients::from_env()
            .expect("konfigurasi microservices Oracle tidak valid")
            .map(Arc::new),
        public_origin: public_origin().expect("konfigurasi public origin tidak valid"),
        migration_proxy_enabled: env_flag("ORACLE_API_MIGRATION_PROXY_ENABLED", true),
        health_database,
        native_database,
        native_auth,
        native_api,
        monitoring_connections: Arc::new(AtomicUsize::new(0)),
        realtime: realtime.clone(),
        realtime_connections: Arc::new(AtomicUsize::new(0)),
    });

    if let Some(database) = state.native_database.clone() {
        let hub = realtime.clone();
        tokio::spawn(async move {
            database.listen_realtime(hub).await;
        });
    }

    if let Some(database) = state.native_database.clone() {
        let cache_api = state.native_api.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(RETENTION_CLEANUP_INTERVAL);
            loop {
                interval.tick().await;
                match database.cleanup_retention().await {
                    Ok(result) => {
                        if let Some(api) = cache_api.as_ref() {
                            api.invalidate_dynamic_cache().await;
                        }
                        info!(?result, "pembersihan retensi data balita selesai");
                    }
                    Err(_) => warn!("pembersihan retensi data balita gagal"),
                }
            }
        });
    }

    let request_id_header = HeaderName::from_static(REQUEST_ID_HEADER);
    let app = Router::new()
        .route("/health", get(liveness))
        .route("/api/health", get(api_health))
        .route("/api/v1/health", get(api_health))
        .route("/api/v1/health/ready", get(readiness))
        .route("/api/v1/openapi.json", get(openapi_document))
        .route("/api/v1/graphql/schema", get(graphql_schema))
        .route("/api/v1/auth/login", axum::routing::post(auth_login))
        .route(
            "/api/v1/auth/invite/complete",
            axum::routing::post(auth_complete_invite),
        )
        .route(
            "/api/v1/auth/mfa/enroll",
            axum::routing::post(auth_mfa_enroll),
        )
        .route(
            "/api/v1/auth/mfa/challenge",
            axum::routing::post(auth_mfa_challenge),
        )
        .route(
            "/api/v1/auth/mfa/verify",
            axum::routing::post(auth_mfa_verify),
        )
        .route(
            "/api/v1/auth/passkey/registration/options",
            axum::routing::post(auth_passkey_registration_options),
        )
        .route(
            "/api/v1/auth/passkey/registration/verify",
            axum::routing::post(auth_passkey_registration_verify),
        )
        .route(
            "/api/v1/auth/passkey/authentication/options",
            axum::routing::post(auth_passkey_authentication_options),
        )
        .route(
            "/api/v1/auth/passkey/authentication/verify",
            axum::routing::post(auth_passkey_authentication_verify),
        )
        .route("/api/v1/auth/logout", axum::routing::post(auth_logout))
        .route("/api/v1/auth/session", get(auth_session))
        .route("/api/v1/auth/presence", axum::routing::post(auth_presence))
        .route(
            "/api/v1/admin/accounts",
            get(admin_accounts).post(admin_account_create),
        )
        .route(
            "/api/v1/admin/accounts/{user_id}",
            patch(admin_account_update).delete(admin_account_delete),
        )
        .route(
            "/api/v1/admin/monitoring/stream",
            get(admin_monitoring_stream),
        )
        .route("/api/v1/realtime/stream", get(realtime_data_stream))
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
    info!(%address, "E-Posyandu Oracle API gateway microservices aktif");
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

    #[test]
    fn completes_microservice_monitoring_contract() {
        let payload = complete_monitoring_payload(
            json!({
                "timestamp": "2026-08-26T14:00:00Z",
                "system": { "intervalSeconds": 5.0, "cpuPercent": 2.0, "memoryPercent": 40.0 },
                "services": { "database": "online", "redis": "online" }
            }),
            7,
            true,
        );
        assert_eq!(payload["sequence"], 7);
        assert_eq!(payload["intervalSeconds"], 5.0);
        assert_eq!(payload["services"]["api"], "online");
        assert_eq!(payload["services"]["nutritionWorker"], "online");
    }

    #[test]
    fn realtime_monitoring_connections_are_bounded_and_released() {
        let active = Arc::new(AtomicUsize::new(0));
        let guards: Vec<_> = (0..ADMIN_MONITORING_CONNECTION_LIMIT)
            .map(|_| acquire_monitoring_connection(active.clone()).expect("connection slot"))
            .collect();
        assert_eq!(
            active.load(Ordering::Acquire),
            ADMIN_MONITORING_CONNECTION_LIMIT
        );
        assert!(acquire_monitoring_connection(active.clone()).is_none());
        drop(guards);
        assert_eq!(active.load(Ordering::Acquire), 0);
    }
}
