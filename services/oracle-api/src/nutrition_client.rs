use std::{env, time::Duration};

use e_posyandu_proto::proto::{
    CalculateBatchRequest, CalculateBatchResponse, NutritionItem,
    nutrition_worker_client::NutritionWorkerClient,
};
use tonic::{
    Request,
    metadata::{Ascii, MetadataValue},
    service::Interceptor,
    transport::{Channel, Endpoint},
};
use tonic_health::pb::{
    HealthCheckRequest, health_check_response::ServingStatus, health_client::HealthClient,
};

const DEFAULT_NUTRITION_GRPC_URL: &str = "unix:///run/e-posyandu/nutrition.sock";
const NUTRITION_SERVICE_NAME: &str = "eposyandu.nutrition.v1.NutritionWorker";
const SERVICE_TOKEN_HEADER: &str = "x-eposyandu-service-token";

#[derive(Clone)]
struct ServiceTokenInterceptor {
    token: Option<MetadataValue<Ascii>>,
}

impl Interceptor for ServiceTokenInterceptor {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, tonic::Status> {
        if let Some(token) = &self.token {
            request
                .metadata_mut()
                .insert(SERVICE_TOKEN_HEADER, token.clone());
        }
        Ok(request)
    }
}

#[derive(Clone)]
pub(crate) struct NutritionGrpcClient {
    channel: Channel,
    interceptor: ServiceTokenInterceptor,
}

impl NutritionGrpcClient {
    pub(crate) fn from_env() -> Result<Self, String> {
        let url = env::var("ORACLE_API_NUTRITION_GRPC_URL")
            .unwrap_or_else(|_| DEFAULT_NUTRITION_GRPC_URL.to_owned());
        let endpoint = Endpoint::from_shared(url.trim().to_owned())
            .map_err(|_| "ORACLE_API_NUTRITION_GRPC_URL bukan URL gRPC valid.".to_owned())?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8));
        Ok(Self {
            channel: endpoint.connect_lazy(),
            interceptor: ServiceTokenInterceptor {
                token: env::var("RUST_WORKER_SHARED_SECRET")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .and_then(|value| value.parse().ok()),
            },
        })
    }

    pub(crate) async fn health_check(&self) -> Result<(), String> {
        let mut client =
            HealthClient::with_interceptor(self.channel.clone(), self.interceptor.clone());
        let response = client
            .check(Request::new(HealthCheckRequest {
                service: NUTRITION_SERVICE_NAME.to_owned(),
            }))
            .await
            .map_err(|error| error.to_string())?;
        let status =
            ServingStatus::try_from(response.into_inner().status).unwrap_or(ServingStatus::Unknown);
        if status == ServingStatus::Serving {
            Ok(())
        } else {
            Err(format!("gRPC health status {status:?}"))
        }
    }

    /// Synchronous service-to-service nutrition calculation over gRPC.
    /// Large exports and imports remain on the durable Queue path.
    #[allow(dead_code)]
    pub(crate) async fn calculate_batch(
        &self,
        items: Vec<NutritionItem>,
    ) -> Result<CalculateBatchResponse, String> {
        let mut client =
            NutritionWorkerClient::with_interceptor(self.channel.clone(), self.interceptor.clone());
        client
            .calculate_batch(Request::new(CalculateBatchRequest { items }))
            .await
            .map(|response| response.into_inner())
            .map_err(|error| error.to_string())
    }
}
