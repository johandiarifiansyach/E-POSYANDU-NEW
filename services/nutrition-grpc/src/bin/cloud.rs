use axum::{Router, routing::get};
use e_posyandu_nutrition_grpc::proto::nutrition_worker_server::NutritionWorkerServer;
use e_posyandu_nutrition_grpc::queue_consumer::{self, QueueConfig, QueueConfigInput};
use e_posyandu_nutrition_grpc::{NutritionService, service_auth_interceptor};
use e_posyandu_proto::transport::{ListenAddress, bind_unix, parse_listen_address};
use std::{env, io, net::SocketAddr};
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::Server;

fn required_env(name: &str) -> Result<String, io::Error> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| io::Error::other(format!("Environment {name} belum diatur.")))
}

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
    "E-Posyandu nutrition worker aktif"
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
    let grpc_target = env::var("GRPC_ADDR").unwrap_or_default();
    let grpc_address = parse_listen_address(
        &grpc_target,
        "unix:///run/e-posyandu/nutrition.sock",
        "GRPC_ADDR",
    )?;
    let (health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter
        .set_serving::<NutritionWorkerServer<NutritionService>>()
        .await;
    let service_auth = service_auth_interceptor(true).map_err(io::Error::other)?;

    let mut grpc_task = tokio::spawn(async move {
        println!("nutrition-grpc internal listening on {grpc_address:?}");
        let server = Server::builder()
            .layer(tonic::service::InterceptorLayer::new(service_auth))
            .add_service(health_service)
            .add_service(NutritionWorkerServer::new(NutritionService));
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

    let queue_config = QueueConfig::new(QueueConfigInput {
        account_id: required_env("CLOUDFLARE_ACCOUNT_ID")?,
        queue_id: required_env("CLOUDFLARE_QUEUE_ID")?,
        api_token: required_env("CLOUDFLARE_QUEUES_API_TOKEN")?,
        api_url: required_env("EPOSYANDU_API_URL")?,
        shared_secret: required_env("RUST_WORKER_SHARED_SECRET")?,
        grpc_url: if grpc_target.trim().is_empty() {
            "unix:///run/e-posyandu/nutrition.sock".to_owned()
        } else {
            grpc_target
        },
        batch_size: optional_number("QUEUE_BATCH_SIZE", 2_u8)?,
        poll_interval_ms: optional_number("QUEUE_POLL_INTERVAL_MS", 15_000_u64)?,
    })
    .map_err(io::Error::other)?;

    let mut queue_task = tokio::spawn(queue_consumer::run(queue_config));

    let port = optional_number("PORT", 8_080_u16)?;
    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("nutrition worker health check listening on {address}");
    let http_server = axum::serve(
        listener,
        Router::new()
            .route("/", get(health))
            .route("/health", get(health)),
    );

    tokio::select! {
        () = shutdown_signal() => {
            println!("nutrition worker menerima sinyal shutdown");
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
