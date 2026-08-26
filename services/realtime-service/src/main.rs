use e_posyandu_oracle_domain::RealtimeDomain;
use e_posyandu_proto::proto::platform::v1::{
    RealtimeEvent, RealtimeSubscribeRequest,
    realtime_service_server::{RealtimeService, RealtimeServiceServer},
};
use e_posyandu_proto::transport::{ListenAddress, bind_unix, parse_listen_address};
use futures_util::stream;
use std::{
    env, io,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
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
            .ok_or_else(|| Status::unauthenticated("Token service realtime tidak ditemukan."))?;
        if supplied != &self.token {
            return Err(Status::unauthenticated(
                "Token service realtime tidak valid.",
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

struct RealtimeGrpc {
    domain: Arc<RealtimeDomain>,
    active: Arc<AtomicUsize>,
}

struct ConnectionGuard(Arc<AtomicUsize>);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn acquire_connection(active: Arc<AtomicUsize>) -> Option<ConnectionGuard> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < 100).then_some(current + 1)
        })
        .ok()
        .map(|_| ConnectionGuard(active))
}

#[tonic::async_trait]
impl RealtimeService for RealtimeGrpc {
    type SubscribeStream = std::pin::Pin<
        Box<dyn tokio_stream::Stream<Item = Result<RealtimeEvent, Status>> + Send + 'static>,
    >;

    async fn subscribe(
        &self,
        request: Request<RealtimeSubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let input = request.into_inner();
        let mut headers = axum::http::HeaderMap::new();
        for header in input.headers {
            let name = axum::http::HeaderName::try_from(header.name)
                .map_err(|_| Status::invalid_argument("Nama header realtime tidak valid."))?;
            let value = axum::http::HeaderValue::try_from(header.value)
                .map_err(|_| Status::invalid_argument("Nilai header realtime tidak valid."))?;
            headers.append(name, value);
        }
        let access = self.domain.authorize(headers).await.map_err(|_| {
            Status::unauthenticated("Sesi realtime tidak valid atau sudah berakhir.")
        })?;
        let connection = acquire_connection(self.active.clone())
            .ok_or_else(|| Status::resource_exhausted("Batas koneksi realtime tercapai."))?;
        let receiver = self.domain.subscribe();
        let domain = self.domain.clone();
        let stream = stream::unfold(
            (receiver, domain, access, connection),
            |(mut receiver, domain, access, connection)| async move {
                loop {
                    match tokio::time::timeout(Duration::from_secs(30), receiver.recv()).await {
                        Ok(Ok(event)) => {
                            if let Some(public) = domain.event_for(&access, &event) {
                                return Some((Ok(public), (receiver, domain, access, connection)));
                            }
                        }
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return None,
                        Err(_) => {}
                    }
                }
            },
        );
        Ok(Response::new(Box::pin(stream)))
    }
}

fn address() -> Result<ListenAddress, io::Error> {
    parse_listen_address(
        &env::var("REALTIME_GRPC_ADDR").unwrap_or_default(),
        "unix:///run/e-posyandu/realtime.sock",
        "REALTIME_GRPC_ADDR",
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
    let domain = Arc::new(RealtimeDomain::from_env().map_err(io::Error::other)?);
    let active = Arc::new(AtomicUsize::new(0));
    domain.start_listener();
    let (reporter, health) = tonic_health::server::health_reporter();
    reporter
        .set_serving::<RealtimeServiceServer<RealtimeGrpc>>()
        .await;
    let server = Server::builder()
        .layer(tonic::service::InterceptorLayer::new(service_auth()?))
        .add_service(health)
        .add_service(RealtimeServiceServer::new(RealtimeGrpc { domain, active }));
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
