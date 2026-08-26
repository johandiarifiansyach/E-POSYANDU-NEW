use e_posyandu_oracle_domain::{IdentityDomain, request_from_proto, response_to_proto};
use e_posyandu_proto::proto::platform::v1::{
    ServiceRequest, ServiceResponse,
    identity_service_server::{IdentityService, IdentityServiceServer},
};
use e_posyandu_proto::transport::{ListenAddress, bind_unix, parse_listen_address};
use std::{env, io};
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
            .ok_or_else(|| Status::unauthenticated("Token service identity tidak ditemukan."))?;
        if supplied != &self.token {
            return Err(Status::unauthenticated(
                "Token service identity tidak valid.",
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

#[derive(Clone)]
struct IdentityGrpc {
    domain: std::sync::Arc<IdentityDomain>,
}

#[tonic::async_trait]
impl IdentityService for IdentityGrpc {
    async fn handle(
        &self,
        request: Request<ServiceRequest>,
    ) -> Result<Response<ServiceResponse>, Status> {
        let input = request.into_inner();
        let http = request_from_proto(&input).map_err(|status| {
            Status::invalid_argument(format!("Request identity tidak valid: {status}"))
        })?;
        Ok(Response::new(
            response_to_proto(self.domain.handle(http).await).await,
        ))
    }
}

fn address() -> Result<ListenAddress, io::Error> {
    parse_listen_address(
        &env::var("IDENTITY_GRPC_ADDR").unwrap_or_default(),
        "unix:///run/e-posyandu/identity.sock",
        "IDENTITY_GRPC_ADDR",
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
    let domain = std::sync::Arc::new(IdentityDomain::from_env().map_err(io::Error::other)?);
    let (reporter, health) = tonic_health::server::health_reporter();
    reporter
        .set_serving::<IdentityServiceServer<IdentityGrpc>>()
        .await;
    let server = Server::builder()
        .layer(tonic::service::InterceptorLayer::new(service_auth()?))
        .add_service(health)
        .add_service(IdentityServiceServer::new(IdentityGrpc { domain }));
    match address {
        ListenAddress::Tcp(address) => {
            server
                .serve_with_shutdown(address, shutdown_signal())
                .await?
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
