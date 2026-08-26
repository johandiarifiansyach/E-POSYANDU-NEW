use e_posyandu_oracle_domain::MonitoringDomain;
use e_posyandu_proto::proto::platform::v1::{
    MonitoringSnapshot, MonitoringSnapshotRequest,
    monitoring_service_server::{MonitoringService, MonitoringServiceServer},
};
use e_posyandu_proto::transport::{ListenAddress, bind_unix, parse_listen_address};
use std::{env, io, sync::Arc};
use tokio_stream::wrappers::UnixListenerStream;
use tonic::{
    Request, Response, Status,
    metadata::{Ascii, MetadataValue},
    service::Interceptor,
    transport::Server,
};

const TOKEN_HEADER: &str = "x-eposyandu-service-token";

#[derive(Clone)]
struct AuthInterceptor {
    token: MetadataValue<Ascii>,
}

impl Interceptor for AuthInterceptor {
    fn call(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
        let supplied = request
            .metadata()
            .get(TOKEN_HEADER)
            .ok_or_else(|| Status::unauthenticated("Token service monitoring tidak ditemukan."))?;
        if supplied != &self.token {
            return Err(Status::unauthenticated(
                "Token service monitoring tidak valid.",
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

struct MonitoringGrpc {
    domain: Arc<MonitoringDomain>,
}

#[tonic::async_trait]
impl MonitoringService for MonitoringGrpc {
    async fn snapshot(
        &self,
        request: Request<MonitoringSnapshotRequest>,
    ) -> Result<Response<MonitoringSnapshot>, Status> {
        let input = request.into_inner();
        let mut headers = axum::http::HeaderMap::new();
        for header in input.headers {
            let name = axum::http::HeaderName::try_from(header.name)
                .map_err(|_| Status::invalid_argument("Nama header monitoring tidak valid."))?;
            let value = axum::http::HeaderValue::try_from(header.value)
                .map_err(|_| Status::invalid_argument("Nilai header monitoring tidak valid."))?;
            headers.append(name, value);
        }
        let payload = self.domain.snapshot(headers).await.map_err(|_| {
            Status::unauthenticated("Sesi monitoring admin tidak valid atau belum terverifikasi.")
        })?;
        let payload_json = serde_json::to_string(&payload)
            .map_err(|_| Status::internal("Snapshot monitoring tidak dapat diserialisasi."))?;
        Ok(Response::new(MonitoringSnapshot { payload_json }))
    }
}

fn address() -> Result<ListenAddress, io::Error> {
    parse_listen_address(
        &env::var("MONITORING_GRPC_ADDR").unwrap_or_default(),
        "unix:///run/e-posyandu/monitoring.sock",
        "MONITORING_GRPC_ADDR",
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
    let address = address()?;
    let domain = Arc::new(
        MonitoringDomain::from_env()
            .await
            .map_err(io::Error::other)?,
    );
    let (reporter, health) = tonic_health::server::health_reporter();
    reporter
        .set_serving::<MonitoringServiceServer<MonitoringGrpc>>()
        .await;
    let server = Server::builder()
        .layer(tonic::service::InterceptorLayer::new(service_auth()?))
        .add_service(health)
        .add_service(MonitoringServiceServer::new(MonitoringGrpc { domain }));
    match address {
        ListenAddress::Tcp(address) => {
            server
                .serve_with_shutdown(address, shutdown_signal())
                .await?;
        }
        ListenAddress::Unix(path) => {
            let listener = bind_unix(&path)?;
            server
                .serve_with_incoming_shutdown(UnixListenerStream::new(listener), shutdown_signal())
                .await?;
        }
    }
    Ok(())
}
