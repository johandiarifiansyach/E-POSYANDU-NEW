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
use e_posyandu_proto::proto::platform::v1::{HttpHeader, ServiceRequest, ServiceResponse};
use reqwest::{Client, redirect::Policy};
use serde_json::{Value, json};

use native_api::NativeApi;
use native_auth::NativeAuth;
use native_db::NativeDatabase;
use realtime::{RealtimeEvent, RealtimeHub};
use system_metrics::SystemMetricsSampler;

const MAX_SERVICE_BODY_BYTES: usize = 16 * 1024 * 1024;

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
}

impl OperationsDomain {
    pub async fn from_env() -> Result<Self, String> {
        let database = required_database()?;
        let auth = NativeAuth::from_env(client()?, Some(database.clone()))?.ok_or_else(|| {
            "ORACLE_API_NATIVE_AUTH_ENABLED wajib true pada operations-service.".to_owned()
        })?;
        let realtime = RealtimeHub::new();
        let api = NativeApi::from_env(
            client()?,
            Arc::new(auth),
            database.clone(),
            realtime,
            true,
            true,
        )
        .await?;
        Ok(Self {
            database,
            api: Arc::new(api),
        })
    }

    pub async fn handle(&self, request: Request) -> Response {
        if self.api.handles(&request) {
            self.api.handle(request).await
        } else {
            not_found()
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
