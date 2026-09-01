use e_posyandu_data_processing_service::proto::data_processing_worker_server::DataProcessingWorkerServer;
use e_posyandu_data_processing_service::queue_consumer;
use e_posyandu_data_processing_service::{DataProcessingWorkerService, service_auth_interceptor};
use e_posyandu_proto::transport::{ListenAddress, bind_unix, parse_listen_address};
use std::io;
use tokio_stream::wrappers::UnixListenerStream;
use tonic::transport::Server;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = parse_listen_address(
        &std::env::var("DATA_PROCESSING_GRPC_ADDR")
            .or_else(|_| std::env::var("GRPC_ADDR"))
            .unwrap_or_default(),
        "unix:///tmp/e-posyandu/data-processing.sock",
        "DATA_PROCESSING_GRPC_ADDR",
    )?;
    let (health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter
        .set_serving::<DataProcessingWorkerServer<DataProcessingWorkerService>>()
        .await;
    println!("data-processing-worker listening on {address:?}");
    tokio::spawn(async {
        if let Err(error) = queue_consumer::run_if_configured().await {
            eprintln!("Queue consumer tidak aktif: {error}");
        }
    });
    let service_auth = service_auth_interceptor(false).map_err(io::Error::other)?;
    let server = Server::builder()
        .layer(tonic::service::InterceptorLayer::new(service_auth))
        .add_service(health_service)
        .add_service(DataProcessingWorkerServer::new(DataProcessingWorkerService));
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
