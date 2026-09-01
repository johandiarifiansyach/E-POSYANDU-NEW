use e_posyandu_proto::analysis::{
    CalculateBatchRequest as AnalysisBatchRequest, CalculateBatchResponse as AnalysisBatchResponse,
    NutritionItem as AnalysisItem, analysis_service_client::AnalysisServiceClient,
};
use std::{env, time::Duration};
use tonic::{
    Request, Status,
    metadata::{Ascii, MetadataValue},
    transport::{Channel, Endpoint},
};

const DEFAULT_ANALYSIS_GRPC_URL: &str = "unix:///run/e-posyandu/analysis.sock";
const SERVICE_TOKEN_HEADER: &str = "x-eposyandu-service-token";

#[derive(Clone)]
struct ServiceTokenInterceptor {
    token: Option<MetadataValue<Ascii>>,
}

impl tonic::service::Interceptor for ServiceTokenInterceptor {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        if let Some(token) = &self.token {
            request
                .metadata_mut()
                .insert(SERVICE_TOKEN_HEADER, token.clone());
        }
        Ok(request)
    }
}

#[derive(Clone)]
pub struct AnalysisGrpcClient {
    channel: Channel,
    interceptor: ServiceTokenInterceptor,
}

impl AnalysisGrpcClient {
    pub fn from_env() -> Result<Option<Self>, String> {
        let url = env::var("ANALYSIS_GRPC_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ANALYSIS_GRPC_URL.to_owned());
        let configured = env::var("ANALYSIS_GRPC_ENABLED")
            .ok()
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !configured {
            return Ok(None);
        }
        let endpoint = Endpoint::from_shared(url.trim().to_owned())
            .map_err(|_| "ANALYSIS_GRPC_URL bukan URL gRPC valid.".to_owned())?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15));
        let token = env::var("RUST_WORKER_SHARED_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                value
                    .parse()
                    .map_err(|_| "Secret service gRPC harus berupa metadata ASCII.")
            })
            .transpose()?;
        Ok(Some(Self {
            channel: endpoint.connect_lazy(),
            interceptor: ServiceTokenInterceptor { token },
        }))
    }

    pub async fn calculate_batch(
        &self,
        items: Vec<AnalysisItem>,
    ) -> Result<AnalysisBatchResponse, Status> {
        let mut client =
            AnalysisServiceClient::with_interceptor(self.channel.clone(), self.interceptor.clone());
        client
            .calculate_batch(Request::new(AnalysisBatchRequest { items }))
            .await
            .map(|response| response.into_inner())
    }
}
