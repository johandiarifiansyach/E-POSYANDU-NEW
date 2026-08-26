use e_posyandu_nutrition_grpc::proto::nutrition_worker_server::NutritionWorkerServer;
use e_posyandu_nutrition_grpc::queue_consumer;
use e_posyandu_nutrition_grpc::{NutritionService, service_auth_interceptor};
use e_posyandu_proto::transport::{ListenAddress, bind_unix, parse_listen_address};
use std::io;
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::Server;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = parse_listen_address(
        &std::env::var("GRPC_ADDR").unwrap_or_default(),
        "unix:///tmp/e-posyandu/nutrition.sock",
        "GRPC_ADDR",
    )?;
    let (health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter
        .set_serving::<NutritionWorkerServer<NutritionService>>()
        .await;
    println!("nutrition-grpc listening on {address:?}");
    tokio::spawn(async {
        if let Err(error) = queue_consumer::run_if_configured().await {
            eprintln!("Queue consumer tidak aktif: {error}");
        }
    });
    let service_auth = service_auth_interceptor(false).map_err(io::Error::other)?;
    let server = Server::builder()
        .layer(tonic::service::InterceptorLayer::new(service_auth))
        .add_service(health_service)
        .add_service(NutritionWorkerServer::new(NutritionService));
    match address {
        ListenAddress::Tcp(address) => {
            server
                .serve_with_shutdown(address, async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
        }
        ListenAddress::Unix(path) => {
            let listener = bind_unix(&path)?;
            server
                .serve_with_incoming_shutdown(UnixListenerStream::new(listener), async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
        }
    }
    Ok(())
}
