use std::{fs, path::Path, time::Instant};

use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Clone, Copy, Debug, Default)]
struct Counters {
    cpu_total: u64,
    cpu_idle: u64,
    disk_read_operations: u64,
    disk_write_operations: u64,
    disk_read_bytes: u64,
    disk_write_bytes: u64,
    network_receive_bytes: u64,
    network_transmit_bytes: u64,
}

#[derive(Debug, Default)]
struct InstantValues {
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    load_average: f64,
    uptime_seconds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemMetricSample {
    pub(crate) timestamp: String,
    pub(crate) interval_seconds: f64,
    pub(crate) cpu_percent: f64,
    pub(crate) memory_percent: f64,
    pub(crate) memory_used_bytes: u64,
    pub(crate) memory_total_bytes: u64,
    pub(crate) load_average: f64,
    pub(crate) disk_read_operations_per_second: f64,
    pub(crate) disk_write_operations_per_second: f64,
    pub(crate) disk_read_bytes_per_second: f64,
    pub(crate) disk_write_bytes_per_second: f64,
    pub(crate) network_receive_bytes_per_second: f64,
    pub(crate) network_transmit_bytes_per_second: f64,
    pub(crate) uptime_seconds: f64,
}

pub(crate) struct SystemMetricsSampler {
    previous: Counters,
    previous_at: Instant,
}

fn rounded(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn delta_rate(current: u64, previous: u64, seconds: f64) -> f64 {
    rounded(current.saturating_sub(previous) as f64 / seconds.max(0.001))
}

fn parse_cpu(source: &str) -> (u64, u64) {
    let Some(line) = source.lines().find(|line| line.starts_with("cpu ")) else {
        return (0, 0);
    };
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse().ok())
        .collect();
    let total = values.iter().copied().sum();
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    (total, idle)
}

fn parse_memory(source: &str) -> (u64, u64) {
    let mut total_kib = 0_u64;
    let mut available_kib = 0_u64;
    for line in source.lines() {
        let mut fields = line.split_whitespace();
        match fields.next() {
            Some("MemTotal:") => {
                total_kib = fields
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0)
            }
            Some("MemAvailable:") => {
                available_kib = fields
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0)
            }
            _ => {}
        }
    }
    let total = total_kib.saturating_mul(1024);
    (
        total,
        total.saturating_sub(available_kib.saturating_mul(1024)),
    )
}

fn physical_block_device(name: &str) -> bool {
    !name.starts_with("loop")
        && !name.starts_with("ram")
        && !name.starts_with("zram")
        && !name.starts_with("sr")
        && !name.starts_with("fd")
        && !name.starts_with("dm-")
        && Path::new("/sys/block").join(name).exists()
}

fn parse_disk(source: &str) -> (u64, u64, u64, u64) {
    source
        .lines()
        .fold((0_u64, 0_u64, 0_u64, 0_u64), |totals, line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 10 || !physical_block_device(fields[2]) {
                return totals;
            }
            let reads = fields[3].parse::<u64>().unwrap_or(0);
            let read_sectors = fields[5].parse::<u64>().unwrap_or(0);
            let writes = fields[7].parse::<u64>().unwrap_or(0);
            let write_sectors = fields[9].parse::<u64>().unwrap_or(0);
            (
                totals.0.saturating_add(reads),
                totals.1.saturating_add(writes),
                totals.2.saturating_add(read_sectors.saturating_mul(512)),
                totals.3.saturating_add(write_sectors.saturating_mul(512)),
            )
        })
}

fn parse_network(source: &str) -> (u64, u64) {
    source.lines().filter_map(|line| line.split_once(':')).fold(
        (0_u64, 0_u64),
        |totals, (interface, values)| {
            if interface.trim() == "lo" {
                return totals;
            }
            let fields: Vec<&str> = values.split_whitespace().collect();
            if fields.len() < 9 {
                return totals;
            }
            (
                totals
                    .0
                    .saturating_add(fields[0].parse::<u64>().unwrap_or(0)),
                totals
                    .1
                    .saturating_add(fields[8].parse::<u64>().unwrap_or(0)),
            )
        },
    )
}

fn read_snapshot() -> (Counters, InstantValues) {
    let cpu = fs::read_to_string("/proc/stat").unwrap_or_default();
    let memory = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let disk = fs::read_to_string("/proc/diskstats").unwrap_or_default();
    let network = fs::read_to_string("/proc/net/dev").unwrap_or_default();
    let load_average = fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|value| value.split_whitespace().next()?.parse().ok())
        .unwrap_or(0.0);
    let uptime_seconds = fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|value| value.split_whitespace().next()?.parse().ok())
        .unwrap_or(0.0);
    let (cpu_total, cpu_idle) = parse_cpu(&cpu);
    let (memory_total_bytes, memory_used_bytes) = parse_memory(&memory);
    let (disk_read_operations, disk_write_operations, disk_read_bytes, disk_write_bytes) =
        parse_disk(&disk);
    let (network_receive_bytes, network_transmit_bytes) = parse_network(&network);
    (
        Counters {
            cpu_total,
            cpu_idle,
            disk_read_operations,
            disk_write_operations,
            disk_read_bytes,
            disk_write_bytes,
            network_receive_bytes,
            network_transmit_bytes,
        },
        InstantValues {
            memory_total_bytes,
            memory_used_bytes,
            load_average,
            uptime_seconds,
        },
    )
}

impl SystemMetricsSampler {
    pub(crate) fn new() -> Self {
        let (previous, _) = read_snapshot();
        Self {
            previous,
            previous_at: Instant::now(),
        }
    }

    pub(crate) fn sample(&mut self) -> SystemMetricSample {
        let sampled_at = Instant::now();
        let seconds = sampled_at
            .duration_since(self.previous_at)
            .as_secs_f64()
            .max(0.001);
        let (current, instant) = read_snapshot();
        let cpu_total_delta = current.cpu_total.saturating_sub(self.previous.cpu_total);
        let cpu_idle_delta = current.cpu_idle.saturating_sub(self.previous.cpu_idle);
        let cpu_percent = if cpu_total_delta == 0 {
            0.0
        } else {
            rounded(
                100.0 * cpu_total_delta.saturating_sub(cpu_idle_delta) as f64
                    / cpu_total_delta as f64,
            )
        };
        let memory_percent = if instant.memory_total_bytes == 0 {
            0.0
        } else {
            rounded(100.0 * instant.memory_used_bytes as f64 / instant.memory_total_bytes as f64)
        };
        let timestamp = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into());
        let result = SystemMetricSample {
            timestamp,
            interval_seconds: rounded(seconds),
            cpu_percent,
            memory_percent,
            memory_used_bytes: instant.memory_used_bytes,
            memory_total_bytes: instant.memory_total_bytes,
            load_average: rounded(instant.load_average),
            disk_read_operations_per_second: delta_rate(
                current.disk_read_operations,
                self.previous.disk_read_operations,
                seconds,
            ),
            disk_write_operations_per_second: delta_rate(
                current.disk_write_operations,
                self.previous.disk_write_operations,
                seconds,
            ),
            disk_read_bytes_per_second: delta_rate(
                current.disk_read_bytes,
                self.previous.disk_read_bytes,
                seconds,
            ),
            disk_write_bytes_per_second: delta_rate(
                current.disk_write_bytes,
                self.previous.disk_write_bytes,
                seconds,
            ),
            network_receive_bytes_per_second: delta_rate(
                current.network_receive_bytes,
                self.previous.network_receive_bytes,
                seconds,
            ),
            network_transmit_bytes_per_second: delta_rate(
                current.network_transmit_bytes,
                self.previous.network_transmit_bytes,
                seconds,
            ),
            uptime_seconds: rounded(instant.uptime_seconds),
        };
        self.previous = current;
        self.previous_at = sampled_at;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cpu_and_memory_without_exposing_process_data() {
        assert_eq!(parse_cpu("cpu  10 2 3 80 5 0 0 0\n"), (100, 85));
        assert_eq!(
            parse_memory("MemTotal:       1000 kB\nMemAvailable:    250 kB\n"),
            (1_024_000, 768_000)
        );
    }

    #[test]
    fn parses_network_and_ignores_loopback() {
        let source =
            "lo: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\neth0: 300 0 0 0 0 0 0 0 400 0 0 0 0 0 0 0\n";
        assert_eq!(parse_network(source), (300, 400));
    }

    #[test]
    fn counter_resets_do_not_create_negative_rates() {
        assert_eq!(delta_rate(10, 20, 5.0), 0.0);
        assert_eq!(delta_rate(30, 20, 5.0), 2.0);
    }
}
