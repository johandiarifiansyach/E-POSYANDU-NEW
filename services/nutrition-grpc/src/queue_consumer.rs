use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use hmac::{Hmac, Mac};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{env, time::Duration};
use tonic::Request;

use crate::proto::{
    ProcessJobRequest, ProcessJobResponse, nutrition_worker_client::NutritionWorkerClient,
};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct QueueConfig {
    account_id: String,
    queue_id: String,
    api_token: String,
    api_url: String,
    shared_secret: String,
    grpc_url: String,
    batch_size: u8,
    poll_interval: Duration,
}

impl QueueConfig {
    pub fn new(
        account_id: String,
        queue_id: String,
        api_token: String,
        api_url: String,
        shared_secret: String,
        grpc_url: String,
        batch_size: u8,
        poll_interval_ms: u64,
    ) -> Result<Self, String> {
        let required = |name: &str, value: String| {
            if value.trim().is_empty() {
                Err(format!(
                    "Konfigurasi {name} wajib diisi untuk Queue consumer."
                ))
            } else {
                Ok(value)
            }
        };

        Ok(Self {
            account_id: required("CLOUDFLARE_ACCOUNT_ID", account_id)?,
            queue_id: required("CLOUDFLARE_QUEUE_ID", queue_id)?,
            api_token: required("CLOUDFLARE_QUEUES_API_TOKEN", api_token)?,
            api_url: required("EPOSYANDU_API_URL", api_url)?
                .trim_end_matches('/')
                .into(),
            shared_secret: required("RUST_WORKER_SHARED_SECRET", shared_secret)?,
            grpc_url: if grpc_url.trim().is_empty() {
                "http://127.0.0.1:50051".into()
            } else {
                grpc_url
            },
            batch_size: batch_size.clamp(1, 100),
            poll_interval: Duration::from_millis(poll_interval_ms.clamp(250, 60_000)),
        })
    }

    fn from_env() -> Result<Option<Self>, String> {
        if env::var("QUEUE_CONSUMER_ENABLED")
            .unwrap_or_default()
            .to_ascii_lowercase()
            != "true"
        {
            return Ok(None);
        }
        let required = |name: &str| {
            env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("Environment {name} wajib diisi untuk Queue consumer."))
        };
        let batch_size = env::var("QUEUE_BATCH_SIZE")
            .ok()
            .and_then(|value| value.parse::<u8>().ok())
            .unwrap_or(5)
            .clamp(1, 100);
        let poll_interval = env::var("QUEUE_POLL_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(1_500)
            .clamp(250, 60_000);
        Self::new(
            required("CLOUDFLARE_ACCOUNT_ID")?,
            required("CLOUDFLARE_QUEUE_ID")?,
            required("CLOUDFLARE_QUEUES_API_TOKEN")?,
            required("EPOSYANDU_API_URL")?,
            required("RUST_WORKER_SHARED_SECRET")?,
            env::var("GRPC_URL").unwrap_or_else(|_| "http://127.0.0.1:50051".into()),
            batch_size,
            poll_interval,
        )
        .map(Some)
    }

    fn queue_url(&self, action: &str) -> String {
        format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/queues/{}/messages/{action}",
            self.account_id, self.queue_id
        )
    }
}

#[derive(Deserialize)]
struct PullResponse {
    success: bool,
    result: Option<PullResult>,
}

#[derive(Deserialize)]
struct PullResult {
    #[serde(default)]
    messages: Vec<PulledMessage>,
}

#[derive(Deserialize)]
struct PulledMessage {
    body: Value,
    lease_id: String,
    #[serde(default)]
    attempts: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueJobMessage {
    job_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InternalJob {
    id: String,
    kind: String,
    status: String,
    payload: Value,
    actor_role: String,
    village: Option<String>,
    posyandu: Option<String>,
}

#[derive(Serialize)]
struct Lease<'a> {
    lease_id: &'a str,
}

#[derive(Serialize)]
struct RetryLease<'a> {
    lease_id: &'a str,
    delay_seconds: u32,
}

fn queue_message(body: &Value) -> Result<QueueJobMessage, String> {
    if body.is_object() {
        return serde_json::from_value(body.clone())
            .map_err(|_| "Pesan Queue tidak memiliki jobId.".into());
    }
    let raw = body
        .as_str()
        .ok_or_else(|| "Isi pesan Queue tidak valid.".to_owned())?;
    if let Ok(value) = BASE64.decode(raw)
        && let Ok(message) = serde_json::from_slice::<QueueJobMessage>(&value)
    {
        return Ok(message);
    }
    serde_json::from_str(raw).map_err(|_| "Pesan Queue tidak memiliki jobId.".into())
}

fn internal_signature(method: &Method, timestamp: &str, body: &str, secret: &str) -> String {
    let payload = format!("{}\n{timestamp}\n{body}", method.as_str());
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC secret");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

async fn internal_request(
    client: &Client,
    config: &QueueConfig,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let body = body.map(|value| value.to_string()).unwrap_or_default();
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let signature = internal_signature(&method, &timestamp, &body, &config.shared_secret);
    let mut request = client
        .request(method, format!("{}{}", config.api_url, path))
        .header("X-EPosyandu-Timestamp", timestamp)
        .header("X-EPosyandu-Signature", signature);
    if !body.is_empty() {
        request = request
            .header("Content-Type", "application/json")
            .body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("API job tidak dapat dihubungi: {error}"))?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|_| "Respons API job tidak dapat dibaca.".to_owned())?;
    if !status.is_success() {
        return Err(payload
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("API job menolak permintaan.")
            .into());
    }
    Ok(payload)
}

async fn update_job(
    client: &Client,
    config: &QueueConfig,
    job_id: &str,
    payload: Value,
) -> Result<(), String> {
    internal_request(
        client,
        config,
        Method::PATCH,
        &format!("/internal/v1/jobs/{job_id}"),
        Some(payload),
    )
    .await
    .map(|_| ())
}

async fn store_file(
    client: &Client,
    config: &QueueConfig,
    result: &ProcessJobResponse,
) -> Result<Value, String> {
    internal_request(
        client,
        config,
        Method::POST,
        &format!("/internal/v1/jobs/{}/file", result.job_id),
        Some(json!({
            "filename": result.file_name,
            "contentType": result.file_content_type,
            "contentBase64": BASE64.encode(&result.file_content),
        })),
    )
    .await
}

async fn process_message(
    client: &Client,
    config: &QueueConfig,
    message: &PulledMessage,
) -> Result<(), String> {
    let queue_job = queue_message(&message.body)?;
    let job_payload = internal_request(
        client,
        config,
        Method::GET,
        &format!("/internal/v1/jobs/{}", queue_job.job_id),
        None,
    )
    .await?;
    let job: InternalJob = serde_json::from_value(job_payload)
        .map_err(|_| "Data job internal tidak lengkap.".to_owned())?;
    if matches!(job.status.as_str(), "completed" | "cancelled") {
        return Ok(());
    }
    update_job(
        client,
        config,
        &job.id,
        json!({ "status": "processing", "progress": 5 }),
    )
    .await?;

    let mut grpc = NutritionWorkerClient::connect(config.grpc_url.clone())
        .await
        .map_err(|error| format!("Layanan gRPC belum siap: {error}"))?;
    let result = grpc
        .process_job(Request::new(ProcessJobRequest {
            job_id: job.id.clone(),
            kind: job.kind,
            payload_json: job.payload.to_string(),
            actor_role: job.actor_role,
            village: job.village,
            posyandu: job.posyandu,
        }))
        .await
        .map_err(|error| format!("gRPC gagal memproses job: {}", error.message()))?
        .into_inner();

    update_job(
        client,
        config,
        &job.id,
        json!({ "status": "processing", "progress": 85 }),
    )
    .await?;

    let mut result_json = serde_json::from_str::<Value>(&result.result_json)
        .unwrap_or_else(|_| json!({ "message": result.result_json }));
    if !result.file_content.is_empty() {
        let stored = store_file(client, config, &result).await?;
        if let (Some(target), Some(source)) = (result_json.as_object_mut(), stored.as_object()) {
            target.extend(source.clone());
        }
        update_job(
            client,
            config,
            &job.id,
            json!({ "status": "processing", "progress": 95 }),
        )
        .await?;
    }
    update_job(
        client,
        config,
        &job.id,
        json!({
            "status": "completed",
            "progress": 100,
            "result": result_json,
            "error": null,
        }),
    )
    .await
}

async fn acknowledge(
    client: &Client,
    config: &QueueConfig,
    acknowledgements: &[&str],
    retries: &[&str],
) -> Result<(), String> {
    let response = client
        .post(config.queue_url("ack"))
        .bearer_auth(&config.api_token)
        .json(&json!({
            "acks": acknowledgements.iter().map(|lease_id| Lease { lease_id }).collect::<Vec<_>>(),
            "retries": retries.iter().map(|lease_id| RetryLease { lease_id, delay_seconds: 15 }).collect::<Vec<_>>(),
        }))
        .send()
        .await
        .map_err(|error| format!("Acknowledgement Queue gagal: {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Acknowledgement Queue ditolak dengan status {}.",
            response.status()
        ))
    }
}

async fn fail_message(
    client: &Client,
    config: &QueueConfig,
    message: &PulledMessage,
    error: &str,
) -> Result<(), String> {
    let job = queue_message(&message.body)?;
    update_job(
        client,
        config,
        &job.job_id,
        json!({
            "status": "failed",
            "progress": 100,
            "result": null,
            "error": error.chars().take(1_000).collect::<String>(),
        }),
    )
    .await
}

async fn pull(client: &Client, config: &QueueConfig) -> Result<Vec<PulledMessage>, String> {
    let response = client
        .post(config.queue_url("pull"))
        .bearer_auth(&config.api_token)
        .json(&json!({
            "visibility_timeout_ms": 300_000,
            "batch_size": config.batch_size,
        }))
        .send()
        .await
        .map_err(|error| format!("Queue tidak dapat dibaca: {error}"))?;
    let status = response.status();
    let payload = response
        .json::<PullResponse>()
        .await
        .map_err(|_| "Respons Queue tidak dapat dibaca.".to_owned())?;
    if !status.is_success() || !payload.success {
        return Err(format!(
            "Cloudflare Queue menolak pull dengan status {status}."
        ));
    }
    Ok(payload
        .result
        .map(|value| value.messages)
        .unwrap_or_default())
}

pub async fn run(config: QueueConfig) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(330))
        .build()
        .map_err(|error| format!("HTTP client Queue gagal dibuat: {error}"))?;
    println!("Cloudflare Queue pull consumer aktif");
    loop {
        match pull(&client, &config).await {
            Ok(messages) if messages.is_empty() => tokio::time::sleep(config.poll_interval).await,
            Ok(messages) => {
                let mut acks = Vec::new();
                let mut retries = Vec::new();
                for message in &messages {
                    match process_message(&client, &config, message).await {
                        Ok(()) => acks.push(message.lease_id.as_str()),
                        Err(error) => {
                            eprintln!("Queue job gagal: {error}");
                            if message.attempts >= 3 {
                                if let Err(update_error) =
                                    fail_message(&client, &config, message, &error).await
                                {
                                    eprintln!("Status job gagal diperbarui: {update_error}");
                                }
                                acks.push(message.lease_id.as_str());
                            } else {
                                retries.push(message.lease_id.as_str());
                            }
                        }
                    }
                }
                if let Err(error) = acknowledge(&client, &config, &acks, &retries).await {
                    eprintln!("{error}");
                }
            }
            Err(error) => {
                eprintln!("{error}");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

pub async fn run_if_configured() -> Result<(), String> {
    let Some(config) = QueueConfig::from_env()? else {
        return Ok(());
    };
    run(config).await
}
