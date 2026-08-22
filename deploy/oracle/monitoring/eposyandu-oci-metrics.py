#!/usr/bin/env python3
"""Publish non-sensitive Oracle VM health metrics to OCI Monitoring.

The script uses instance principals and never reads or emits application data
or secret values. It is intentionally small so it can run from a systemd
timer on Oracle Linux without adding another container or network listener.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import shutil
import socket
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

import oci
from oci.auth.signers import InstancePrincipalsSecurityTokenSigner


LOG = logging.getLogger("eposyandu-oci-metrics")
METRIC_NAMESPACE = "eposyandu"
INSTANCE_METADATA_URL = "http://169.254.169.254/opc/v2/instance/"
ENV_FILE = Path("/etc/e-posyandu/nutrition-grpc.env")


def read_instance_metadata() -> dict[str, str]:
    request = urllib.request.Request(
        INSTANCE_METADATA_URL,
        headers={"Authorization": "Bearer Oracle"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        payload = json.load(response)
    return {
        "compartment_id": str(payload["compartmentId"]),
        "instance_id": str(payload["id"]),
        "region": str(payload["region"]),
    }


def read_env_value(name: str) -> str:
    try:
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    prefix = f"{name}="
    for line in lines:
        if line.startswith(prefix):
            return line[len(prefix) :].strip().strip('"\'')
    return ""


def command_ok(command: list[str], timeout: float = 5) -> bool:
    try:
        subprocess.run(
            command,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def worker_health() -> bool:
    site = read_env_value("ORACLE_HEALTH_SITE")
    if not site:
        return False
    parsed = urllib.parse.urlparse(site if "://" in site else f"https://{site}")
    host = parsed.hostname
    if not host:
        return False
    health_url = f"https://{host}/health"
    return command_ok(
        [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--output",
            "/dev/null",
            "--max-time",
            "5",
            "--resolve",
            f"{host}:443:127.0.0.1",
            health_url,
        ],
        timeout=7,
    )


def https_port_open() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", 443), timeout=3):
            return True
    except OSError:
        return False


def oracle_api_health() -> bool:
    return command_ok(
        [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--output",
            "/dev/null",
            "--max-time",
            "3",
            "http://127.0.0.1:8081/health",
        ],
        timeout=5,
    )


def cloudflare_tunnel_health() -> bool:
    return command_ok(
        [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--output",
            "/dev/null",
            "--max-time",
            "3",
            "http://127.0.0.1:2000/ready",
        ],
        timeout=5,
    )


def disk_usage_percent() -> float:
    usage = shutil.disk_usage("/")
    if usage.total <= 0:
        return 100.0
    return round(usage.used * 100 / usage.total, 2)


def metric(
    name: str,
    value: float,
    dimensions: dict[str, str],
    timestamp: dt.datetime,
    compartment_id: str,
) -> oci.monitoring.models.MetricDataDetails:
    return oci.monitoring.models.MetricDataDetails(
        namespace=METRIC_NAMESPACE,
        compartment_id=compartment_id,
        name=name,
        dimensions=dimensions,
        datapoints=[oci.monitoring.models.Datapoint(timestamp=timestamp, value=float(value))],
    )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    metadata = read_instance_metadata()
    timestamp = dt.datetime.now(dt.timezone.utc)
    dimensions = {"instanceId": metadata["instance_id"], "service": "nutrition-worker"}
    api_dimensions = {"instanceId": metadata["instance_id"], "service": "oracle-api"}
    tunnel_dimensions = {
        "instanceId": metadata["instance_id"],
        "service": "cloudflare-tunnel",
    }
    worker_ok = worker_health()
    api_ok = oracle_api_health()
    tunnel_ok = cloudflare_tunnel_health()
    https_ok = https_port_open()
    disk_percent = disk_usage_percent()
    metrics = [
        metric("DiskUsagePercent", disk_percent, {**dimensions, "mount": "/"}, timestamp, metadata["compartment_id"]),
        metric("WorkerUp", 1 if worker_ok else 0, dimensions, timestamp, metadata["compartment_id"]),
        metric("ApiUp", 1 if api_ok else 0, api_dimensions, timestamp, metadata["compartment_id"]),
        metric("TunnelUp", 1 if tunnel_ok else 0, tunnel_dimensions, timestamp, metadata["compartment_id"]),
        metric("HttpsPortUp", 1 if https_ok else 0, dimensions, timestamp, metadata["compartment_id"]),
    ]
    signer = InstancePrincipalsSecurityTokenSigner()
    client = oci.monitoring.MonitoringClient(config={"region": metadata["region"]}, signer=signer)
    # OCI uses a separate ingestion endpoint for PostMetricData.
    client.base_client.endpoint = (
        f"https://telemetry-ingestion.{metadata['region']}.oraclecloud.com/20180401"
    )
    client.post_metric_data(
        oci.monitoring.models.PostMetricDataDetails(
            metric_data=metrics,
            batch_atomicity="NON_ATOMIC",
        )
    )
    LOG.info(
        "metrik OCI terkirim: disk=%.2f worker=%s api=%s tunnel=%s health-proxy=%s https=%s",
        disk_percent,
        worker_ok,
        api_ok,
        tunnel_ok,
        https_ok,
        https_ok,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
