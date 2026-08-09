use e_posyandu_nutrition_grpc::proto::nutrition_worker_client::NutritionWorkerClient;
use e_posyandu_nutrition_grpc::proto::{CalculateReportRequest, NutritionItem};
use serde_json::json;
use std::{env, io, sync::Arc, time::Instant};
use tokio::{sync::Semaphore, task::JoinSet};
use tonic::Request;

fn number(name: &str, fallback: usize, maximum: usize) -> Result<usize, io::Error> {
    let value = env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map_or(Ok(fallback), |value| {
            value
                .parse::<usize>()
                .map_err(|_| io::Error::other(format!("Environment {name} harus berupa angka.")))
        })?;
    Ok(value.clamp(1, maximum))
}

fn synthetic_items(count: usize, request_index: usize) -> Vec<NutritionItem> {
    (0..count)
        .map(|index| NutritionItem {
            weight_kg: 7.0 + ((request_index + index) % 80) as f64 / 10.0,
            height_cm: Some(65.0 + ((request_index + index) % 45) as f64),
            age_months: ((request_index + index) % 60) as i32,
            sex: if index % 2 == 0 { "L" } else { "P" }.into(),
            measurement_method: Some(
                if index % 3 == 0 {
                    "Terlentang"
                } else {
                    "Berdiri"
                }
                .into(),
            ),
            row_number: (index + 1) as u64,
            record_id: format!("load-{request_index}-{index}"),
            nik: String::new(),
        })
        .collect()
}

fn percentile(values: &[u128], ratio: f64) -> u128 {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let index = ((sorted.len() as f64 * ratio).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len().saturating_sub(1));
    sorted.get(index).copied().unwrap_or_default()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let endpoint = env::var("LOAD_GRPC_URL").unwrap_or_else(|_| "http://127.0.0.1:50051".into());
    let requests = number("LOAD_GRPC_REQUESTS", 20, 1_000)?;
    let concurrency = number("LOAD_GRPC_CONCURRENCY", 4, 50)?;
    let items_per_request = number("LOAD_GRPC_ITEMS", 100, 10_000)?;
    let p95_limit_ms = number("LOAD_GRPC_P95_LIMIT_MS", 2_000, 120_000)? as u128;
    let client = NutritionWorkerClient::connect(endpoint.clone()).await?;
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let overall_started = Instant::now();
    let mut tasks = JoinSet::new();

    for request_index in 0..requests {
        let permit = semaphore.clone().acquire_owned().await?;
        let mut client = client.clone();
        tasks.spawn(async move {
            let _permit = permit;
            let started = Instant::now();
            let response = client
                .calculate_report(Request::new(CalculateReportRequest {
                    items: synthetic_items(items_per_request, request_index),
                }))
                .await?;
            if response.into_inner().total != items_per_request as u64 {
                return Err(tonic::Status::internal("Jumlah hasil gRPC tidak sesuai."));
            }
            Ok::<u128, tonic::Status>(started.elapsed().as_millis())
        });
    }

    let mut latencies = Vec::with_capacity(requests);
    let mut failures = 0_usize;
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(latency)) => latencies.push(latency),
            Ok(Err(error)) => {
                failures += 1;
                eprintln!("Request gRPC gagal: {error}");
            }
            Err(error) => {
                failures += 1;
                eprintln!("Task load test gagal: {error}");
            }
        }
    }

    let p95 = percentile(&latencies, 0.95);
    let report = json!({
        "event": "grpc_load_test",
        "ok": failures == 0 && p95 <= p95_limit_ms,
        "endpoint": endpoint,
        "requests": requests,
        "concurrency": concurrency,
        "itemsPerRequest": items_per_request,
        "failures": failures,
        "durationMs": overall_started.elapsed().as_millis(),
        "latencyMs": {
            "minimum": latencies.iter().min().copied().unwrap_or_default(),
            "p50": percentile(&latencies, 0.5),
            "p95": p95,
            "maximum": latencies.iter().max().copied().unwrap_or_default(),
            "limitP95": p95_limit_ms,
        }
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    if failures > 0 || p95 > p95_limit_ms {
        return Err(io::Error::other("Load test gRPC tidak memenuhi ambang batas.").into());
    }
    Ok(())
}
