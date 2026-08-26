use std::{convert::Infallible, env, time::Duration};

use axum::{
    body::{Body, to_bytes},
    extract::Request,
    http::{HeaderName, HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use e_posyandu_proto::proto::platform::v1::{
    HttpHeader, RealtimeSubscribeRequest, ServiceRequest, ServiceResponse,
    identity_service_client::IdentityServiceClient,
    monitoring_service_client::MonitoringServiceClient,
    operations_service_client::OperationsServiceClient,
    realtime_service_client::RealtimeServiceClient,
};
use futures_util::stream;
use serde_json::Value;
use tonic::{
    Request as GrpcRequest,
    metadata::{Ascii, MetadataValue},
    service::Interceptor,
    transport::{Channel, Endpoint},
};
use tonic_health::pb::{
    HealthCheckRequest, health_check_response::ServingStatus, health_client::HealthClient,
};

const DEFAULT_IDENTITY_URL: &str = "unix:///run/e-posyandu/identity.sock";
const DEFAULT_OPERATIONS_URL: &str = "unix:///run/e-posyandu/operations.sock";
const DEFAULT_REALTIME_URL: &str = "unix:///run/e-posyandu/realtime.sock";
const DEFAULT_MONITORING_URL: &str = "unix:///run/e-posyandu/monitoring.sock";
const TOKEN_HEADER: &str = "x-eposyandu-service-token";
const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;
const IDENTITY_SERVICE_NAME: &str = "eposyandu.platform.v1.IdentityService";
const OPERATIONS_SERVICE_NAME: &str = "eposyandu.platform.v1.OperationsService";
const REALTIME_SERVICE_NAME: &str = "eposyandu.platform.v1.RealtimeService";
const MONITORING_SERVICE_NAME: &str = "eposyandu.platform.v1.MonitoringService";

#[derive(Clone)]
struct ServiceTokenInterceptor {
    token: MetadataValue<Ascii>,
}

impl Interceptor for ServiceTokenInterceptor {
    fn call(&mut self, mut request: GrpcRequest<()>) -> Result<GrpcRequest<()>, tonic::Status> {
        request
            .metadata_mut()
            .insert(TOKEN_HEADER, self.token.clone());
        Ok(request)
    }
}

#[derive(Clone)]
pub(crate) struct PlatformGrpcClients {
    identity: Channel,
    operations: Channel,
    realtime: Channel,
    monitoring: Channel,
    token: MetadataValue<Ascii>,
}

impl PlatformGrpcClients {
    pub(crate) fn from_env() -> Result<Option<Self>, String> {
        if !env_flag("ORACLE_API_MICROSERVICES_ENABLED", false) {
            return Ok(None);
        }
        let token = env::var("RUST_WORKER_SHARED_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "RUST_WORKER_SHARED_SECRET wajib diisi saat microservices aktif.".to_owned()
            })?
            .parse()
            .map_err(|_| "RUST_WORKER_SHARED_SECRET harus berupa metadata ASCII.".to_owned())?;
        Ok(Some(Self {
            identity: endpoint("ORACLE_API_IDENTITY_GRPC_URL", DEFAULT_IDENTITY_URL)?,
            operations: endpoint("ORACLE_API_OPERATIONS_GRPC_URL", DEFAULT_OPERATIONS_URL)?,
            realtime: endpoint("ORACLE_API_REALTIME_GRPC_URL", DEFAULT_REALTIME_URL)?,
            monitoring: endpoint("ORACLE_API_MONITORING_GRPC_URL", DEFAULT_MONITORING_URL)?,
            token,
        }))
    }

    pub(crate) async fn identity(&self, request: Request) -> Response {
        let input = match request_to_proto(request).await {
            Ok(value) => value,
            Err(response) => return response,
        };
        let mut client = IdentityServiceClient::with_interceptor(
            self.identity.clone(),
            ServiceTokenInterceptor {
                token: self.token.clone(),
            },
        );
        match client.handle(GrpcRequest::new(input)).await {
            Ok(response) => response_from_proto(response.into_inner()),
            Err(error) => unavailable(format!("Identity service tidak tersedia: {error}")),
        }
    }

    pub(crate) async fn operations(&self, request: Request) -> Response {
        let input = match request_to_proto(request).await {
            Ok(value) => value,
            Err(response) => return response,
        };
        let mut client = OperationsServiceClient::with_interceptor(
            self.operations.clone(),
            ServiceTokenInterceptor {
                token: self.token.clone(),
            },
        );
        match client.handle(GrpcRequest::new(input)).await {
            Ok(response) => response_from_proto(response.into_inner()),
            Err(error) => unavailable(format!("Operations service tidak tersedia: {error}")),
        }
    }

    /// Check every domain service through the standard gRPC health protocol.
    /// The gateway uses this for readiness so a running process with a dead
    /// domain service is not reported as healthy.
    pub(crate) async fn health_check(&self) -> Result<(), String> {
        for (service, reachable, healthy, _) in self.health_statuses().await {
            if !reachable {
                return Err(format!("{service}: service tidak dapat dijangkau"));
            }
            if !healthy {
                return Err(format!("{service}: service tidak sehat"));
            }
        }
        Ok(())
    }

    /// Returns an independent status for every gRPC domain service. Keeping
    /// this separate from the aggregate health check lets the admin panel
    /// identify exactly which service is offline without changing request
    /// routing or authentication behaviour.
    pub(crate) async fn health_statuses(&self) -> Vec<(&'static str, bool, bool, u128)> {
        let (identity, operations, realtime, monitoring) = tokio::join!(
            service_health_status(
                self.identity.clone(),
                self.token.clone(),
                IDENTITY_SERVICE_NAME,
            ),
            service_health_status(
                self.operations.clone(),
                self.token.clone(),
                OPERATIONS_SERVICE_NAME,
            ),
            service_health_status(
                self.realtime.clone(),
                self.token.clone(),
                REALTIME_SERVICE_NAME,
            ),
            service_health_status(
                self.monitoring.clone(),
                self.token.clone(),
                MONITORING_SERVICE_NAME,
            ),
        );
        vec![
            ("identity-service", identity.0, identity.1, identity.2),
            ("operations-service", operations.0, operations.1, operations.2),
            ("realtime-service", realtime.0, realtime.1, realtime.2),
            ("monitoring-service", monitoring.0, monitoring.1, monitoring.2),
        ]
    }

    pub(crate) async fn monitoring_snapshot(
        &self,
        headers: axum::http::HeaderMap,
    ) -> Result<Value, String> {
        let input = e_posyandu_proto::proto::platform::v1::MonitoringSnapshotRequest {
            request_id: headers
                .get("x-request-id")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned(),
            headers: header_list(&headers),
        };
        let mut client = MonitoringServiceClient::with_interceptor(
            self.monitoring.clone(),
            ServiceTokenInterceptor {
                token: self.token.clone(),
            },
        );
        let response = client
            .snapshot(GrpcRequest::new(input))
            .await
            .map_err(|error| error.to_string())?
            .into_inner();
        serde_json::from_str(&response.payload_json)
            .map_err(|_| "Payload monitoring service tidak valid.".to_owned())
    }

    pub(crate) async fn realtime(&self, request: Request) -> Response {
        let headers = request.headers().clone();
        let input = RealtimeSubscribeRequest {
            request_id: headers
                .get("x-request-id")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned(),
            headers: header_list(&headers),
        };
        let mut client = RealtimeServiceClient::with_interceptor(
            self.realtime.clone(),
            ServiceTokenInterceptor {
                token: self.token.clone(),
            },
        );
        let upstream = match client.subscribe(GrpcRequest::new(input)).await {
            Ok(response) => response.into_inner(),
            Err(error) => return unavailable(format!("Realtime service tidak tersedia: {error}")),
        };
        let events = stream::unfold(upstream, |mut upstream| async move {
            match upstream.message().await {
                Ok(Some(event)) => {
                    let payload = serde_json::json!({
                        "id": event.id,
                        "resource": event.resource,
                        "operation": event.operation,
                        "changedAt": event.changed_at,
                    });
                    Some((
                        Ok::<Event, Infallible>(
                            Event::default().event("data").data(payload.to_string()),
                        ),
                        upstream,
                    ))
                }
                Ok(None) | Err(_) => None,
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
        response
    }
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

fn endpoint(name: &str, fallback: &str) -> Result<Channel, String> {
    let url = env::var(name).unwrap_or_else(|_| fallback.to_owned());
    Endpoint::from_shared(url.trim().to_owned())
        .map_err(|_| format!("{name} bukan URL gRPC valid."))
        .map(|endpoint| {
            endpoint
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(30))
                .connect_lazy()
        })
}

async fn request_to_proto(request: Request) -> Result<ServiceRequest, Response> {
    let (parts, body) = request.into_parts();
    let body = to_bytes(body, MAX_REQUEST_BODY_BYTES)
        .await
        .map_err(|_| unavailable("Payload service terlalu besar.".to_owned()))?;
    let headers = parts
        .headers
        .iter()
        .filter_map(|(name, value)| {
            if !forwardable_header(name) {
                return None;
            }
            Some(HttpHeader {
                name: name.as_str().to_owned(),
                value: value.to_str().ok()?.to_owned(),
            })
        })
        .collect();
    Ok(ServiceRequest {
        request_id: parts
            .headers
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned(),
        method: parts.method.to_string(),
        path_and_query: parts
            .uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or(parts.uri.path())
            .to_owned(),
        headers,
        body: body.to_vec(),
    })
}

fn response_from_proto(input: ServiceResponse) -> Response {
    let status = StatusCode::from_u16(input.status as u16).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::new(Body::from(input.body));
    *response.status_mut() = status;
    for item in input.headers {
        let Ok(name) = HeaderName::try_from(item.name) else {
            continue;
        };
        if !forwardable_header(&name) {
            continue;
        }
        let Ok(value) = HeaderValue::try_from(item.value) else {
            continue;
        };
        response.headers_mut().append(name, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn header_list(headers: &axum::http::HeaderMap) -> Vec<HttpHeader> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            if !forwardable_header(name) {
                return None;
            }
            Some(HttpHeader {
                name: name.as_str().to_owned(),
                value: value.to_str().ok()?.to_owned(),
            })
        })
        .collect()
}

fn forwardable_header(name: &HeaderName) -> bool {
    !matches!(
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

async fn service_health(
    channel: Channel,
    token: MetadataValue<Ascii>,
    service: &'static str,
) -> Result<(), String> {
    let mut client = HealthClient::with_interceptor(channel, ServiceTokenInterceptor { token });
    let response = client
        .check(GrpcRequest::new(HealthCheckRequest {
            service: service.to_owned(),
        }))
        .await
        .map_err(|error| format!("{service}: {error}"))?;
    let status =
        ServingStatus::try_from(response.into_inner().status).unwrap_or(ServingStatus::Unknown);
    if status == ServingStatus::Serving {
        Ok(())
    } else {
        Err(format!("{service}: gRPC health status {status:?}"))
    }
}

async fn service_health_status(
    channel: Channel,
    token: MetadataValue<Ascii>,
    service: &'static str,
) -> (bool, bool, u128) {
    let started_at = std::time::Instant::now();
    let mut client = HealthClient::with_interceptor(channel, ServiceTokenInterceptor { token });
    let result = client
        .check(GrpcRequest::new(HealthCheckRequest {
            service: service.to_owned(),
        }))
        .await;
    let latency = started_at.elapsed().as_millis();
    match result {
        Ok(response) => {
            let status = ServingStatus::try_from(response.into_inner().status)
                .unwrap_or(ServingStatus::Unknown);
            (true, status == ServingStatus::Serving, latency)
        }
        Err(_) => (false, false, latency),
    }
}

fn unavailable(message: String) -> Response {
    let payload = serde_json::json!({"error":{"code":"service_unavailable","message":message}});
    let mut response = Response::new(Body::from(payload.to_string()));
    *response.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
