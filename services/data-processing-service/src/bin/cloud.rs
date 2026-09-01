use axum::{Router, routing::get};
use e_posyandu_data_processing_service::proto::data_processing_worker_server::DataProcessingWorkerServer;
use e_posyandu_data_processing_service::queue_consumer;
use e_posyandu_data_processing_service::{DataProcessingWorkerService, service_auth_interceptor};
use e_posyandu_proto::transport::{ListenAddress, bind_unix, parse_listen_address};
use std::{env, io, net::SocketAddr};
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::Server;

fn optional_number<T>(name: &str, fallback: T) -> Result<T, io::Error>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    env::var(name).map_or(Ok(fallback), |value| {
        value
            .parse::<T>()
            .map_err(|error| io::Error::other(format!("Environment {name} tidak valid: {error}")))
    })
}

async fn health() -> &'static str {
    "E-Posyandu data processing worker aktif"
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
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let grpc_target = env::var("DATA_PROCESSING_GRPC_ADDR")
        .or_else(|_| env::var("GRPC_ADDR"))
        .unwrap_or_default();
    let grpc_address = parse_listen_address(
        &grpc_target,
        "unix:///run/e-posyandu/data-processing.sock",
        "DATA_PROCESSING_GRPC_ADDR",
    )?;
    let (health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter
        .set_serving::<DataProcessingWorkerServer<DataProcessingWorkerService>>()
        .await;
    let service_auth = service_auth_interceptor(true).map_err(io::Error::other)?;

    let mut grpc_task = tokio::spawn(async move {
        println!("data-processing-worker internal listening on {grpc_address:?}");
        let server = Server::builder()
            .layer(tonic::service::InterceptorLayer::new(service_auth))
            .add_service(health_service)
            .add_service(DataProcessingWorkerServer::new(DataProcessingWorkerService));
        match grpc_address {
            ListenAddress::Tcp(address) => server
                .serve(address)
                .await
                .map_err(|error| io::Error::other(error.to_string())),
            ListenAddress::Unix(path) => {
                let listener = bind_unix(&path)?;
                server
                    .serve_with_incoming(UnixListenerStream::new(listener))
                    .await
                    .map_err(|error| io::Error::other(error.to_string()))
            }
        }
    });

    // Render and other health-check deployments may intentionally run this
    // binary without a Queue consumer.  Reuse the same opt-in configuration
    // as the standalone worker so missing Queue secrets do not terminate the
    // HTTP health endpoint. Oracle enables the consumer explicitly through
    // QUEUE_CONSUMER_ENABLED=true.
    let queue_task = tokio::spawn(async {
        match queue_consumer::run_if_configured().await {
            Ok(()) => std::future::pending::<Result<(), String>>().await,
            Err(error) => Err(error),
        }
    });
    tokio::pin!(queue_task);

    let port = optional_number("PORT", 8_080_u16)?;
    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("data processing worker health check listening on {address}");
    let http_server = axum::serve(
        listener,
        Router::new()
            .route("/", get(health))
            .route("/health", get(health)),
    );

    tokio::select! {
        () = shutdown_signal() => {
            println!("data processing worker menerima sinyal shutdown");
            grpc_task.abort();
            queue_task.abort();
            Ok(())
        },
        result = http_server => result.map_err(Into::into),
        result = &mut grpc_task => match result {
            Ok(Ok(())) => Err(io::Error::other("Server gRPC internal berhenti.").into()),
            Ok(Err(error)) => Err(error.into()),
            Err(error) => Err(error.into()),
        },
        result = &mut queue_task => match result {
            Ok(Ok(())) => Err(io::Error::other("Queue consumer berhenti.").into()),
            Ok(Err(error)) => Err(io::Error::other(error).into()),
            Err(error) => Err(error.into()),
        },
    }
}
