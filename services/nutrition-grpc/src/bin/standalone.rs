use e_posyandu_nutrition_grpc::NutritionService;
use e_posyandu_nutrition_grpc::proto::nutrition_worker_server::NutritionWorkerServer;
use e_posyandu_nutrition_grpc::queue_consumer;
use std::net::SocketAddr;
use tonic::transport::Server;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = std::env::var("GRPC_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:50051".into())
        .parse()?;
    let (health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter
        .set_serving::<NutritionWorkerServer<NutritionService>>()
        .await;
    println!("nutrition-grpc listening on {address}");
    tokio::spawn(async {
        if let Err(error) = queue_consumer::run_if_configured().await {
            eprintln!("Queue consumer tidak aktif: {error}");
        }
    });
    Server::builder()
        .add_service(health_service)
        .add_service(NutritionWorkerServer::new(NutritionService))
        .serve_with_shutdown(address, async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
