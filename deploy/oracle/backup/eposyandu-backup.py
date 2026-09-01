#!/usr/bin/env python3
"""Create an encrypted, non-application-data Oracle deployment backup.

The archive intentionally contains deployment/configuration metadata only. It
does not include the runtime Vault env file, container data, Caddy TLS state,
database dumps, Queue payloads, NIK, or health records.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

import oci
from oci.auth.signers import InstancePrincipalsSecurityTokenSigner


LOG = logging.getLogger("eposyandu-backup")
CONFIG_FILE = Path("/etc/e-posyandu/backup.env")
IMDS_URL = "http://169.254.169.254/opc/v2/instance/"
SENSITIVE_ENV_NAME = re.compile(
    r"(?:TOKEN|SECRET|PASSWORD|PASSphrase|PRIVATE.?KEY|DATABASE.?URL|SERVICE.?ROLE)",
    re.IGNORECASE,
)
SENSITIVE_FILE_NAMES = {
    "data-processing-worker-vault.env",
    "data-processing-worker.env",
    "nutrition-grpc-vault.env",
    "nutrition-grpc.env",
}


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value.strip().strip('"\'')
    return values


def read_instance_metadata() -> dict[str, str]:
    import urllib.request

    request = urllib.request.Request(
        IMDS_URL,
        headers={"Authorization": "Bearer Oracle"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        payload = json.load(response)
    return {
        "instance_id": str(payload["id"]),
        "region": str(payload["region"]),
        "compartment_id": str(payload["compartmentId"]),
    }


def fetch_passphrase(client: oci.secrets.SecretsClient, secret_id: str) -> str:
    bundle = client.get_secret_bundle(secret_id, stage="CURRENT").data
    content = bundle.secret_bundle_content
    if content is None or not content.content:
        raise RuntimeError("Secret backup tidak memiliki isi CURRENT")
    try:
        value = base64.b64decode(content.content, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError("Secret backup bukan teks UTF-8 base64 yang valid") from exc
    if len(value) < 20 or any(char in value for char in ("\x00", "\r", "\n")):
        raise RuntimeError("Secret backup terlalu pendek atau memiliki karakter baris")
    return value


def sanitized_env(source: Path, destination: Path) -> None:
    lines: list[str] = []
    for raw_line in source.read_text(encoding="utf-8").splitlines():
        if "=" not in raw_line or raw_line.lstrip().startswith("#"):
            lines.append(raw_line)
            continue
        name, value = raw_line.split("=", 1)
        if SENSITIVE_ENV_NAME.search(name):
            lines.append(f"{name}=REDACTED_BY_EPOSYANDU_BACKUP")
        else:
            lines.append(f"{name}={value}")
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(destination, 0o600)


def copy_selected_files(staging: Path) -> list[str]:
    """Copy only deployment metadata into staging and return archive paths."""

    copied: list[str] = []

    def copy_file(source: Path, archive_path: str, *, redact_env: bool = False) -> None:
        if not source.exists() or not source.is_file():
            return
        destination = staging / archive_path
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if redact_env:
            sanitized_env(source, destination)
        else:
            shutil.copy2(source, destination)
        copied.append(archive_path)

    for env_path in (
        Path("/etc/e-posyandu/data-processing-worker.env"),
        Path("/etc/e-posyandu/nutrition-grpc.env"),
    ):
        copy_file(env_path, f"etc/e-posyandu/{env_path.name}", redact_env=True)
    copy_file(Path("/etc/e-posyandu/vault.env"), "etc/e-posyandu/vault.env", redact_env=True)
    copy_file(Path("/etc/e-posyandu/backup.env"), "etc/e-posyandu/backup.env", redact_env=True)

    deployment_root = Path("/opt/e-posyandu/current/deploy/oracle").resolve()
    if deployment_root.is_dir():
        for source in sorted(deployment_root.rglob("*")):
            if not source.is_file() or source.name in SENSITIVE_FILE_NAMES:
                continue
            relative = source.relative_to(deployment_root)
            copy_file(source, f"deployment/oracle/{relative}")

    for source in (
        Path("/etc/systemd/system/eposyandu-oci-metrics.service"),
        Path("/etc/systemd/system/eposyandu-oci-metrics.timer"),
        Path("/etc/systemd/system/eposyandu-vault-env.service"),
        Path("/etc/systemd/system/eposyandu-backup.service"),
        Path("/etc/systemd/system/eposyandu-backup.timer"),
    ):
        copy_file(source, f"systemd/{source.name}")

    return copied


def encrypt_staging(staging: Path, output: Path, passphrase: str) -> None:
    passphrase_file = staging.parent / ".backup-passphrase"
    gpg_home = staging.parent / ".gnupg"
    passphrase_file.write_text(passphrase, encoding="utf-8")
    os.chmod(passphrase_file, 0o600)
    gpg_home.mkdir(mode=0o700)
    command = [
        "gpg",
        "--batch",
        "--yes",
        "--homedir",
        str(gpg_home),
        "--pinentry-mode",
        "loopback",
        "--passphrase-file",
        str(passphrase_file),
        "--symmetric",
        "--cipher-algo",
        "AES256",
        "--output",
        str(output),
    ]
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
        assert process.stdin is not None
        try:
            try:
                with tarfile.open(fileobj=process.stdin, mode="w:gz") as archive:
                    archive.add(staging, arcname="e-posyandu-backup")
            except BrokenPipeError:
                # GPG's exit code below contains the useful failure reason.
                pass
        finally:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
        if process.wait(timeout=120) != 0:
            raise RuntimeError("GPG gagal mengenkripsi backup")
    finally:
        passphrase_file.unlink(missing_ok=True)
        shutil.rmtree(gpg_home, ignore_errors=True)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    config = parse_env(CONFIG_FILE)
    required = ("OCI_BACKUP_BUCKET", "OCI_BACKUP_ENCRYPTION_SECRET_ID")
    missing = [name for name in required if not config.get(name)]
    if missing:
        raise RuntimeError(f"Konfigurasi backup belum lengkap: {', '.join(missing)}")

    metadata = read_instance_metadata()
    region = config.get("OCI_BACKUP_REGION", metadata["region"])
    prefix = config.get("OCI_BACKUP_PREFIX", "production/oracle").strip("/")
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    object_name = f"{prefix}/e-posyandu-config-{timestamp}.tar.gz.gpg"

    signer = InstancePrincipalsSecurityTokenSigner()
    secrets_client = oci.secrets.SecretsClient({"region": region}, signer=signer)
    passphrase = fetch_passphrase(secrets_client, config["OCI_BACKUP_ENCRYPTION_SECRET_ID"])
    object_client = oci.object_storage.ObjectStorageClient({"region": region}, signer=signer)
    namespace = object_client.get_namespace().data

    with tempfile.TemporaryDirectory(prefix="eposyandu-backup-") as temporary_dir:
        temporary_root = Path(temporary_dir)
        staging = temporary_root / "payload"
        staging.mkdir(mode=0o700)
        copied = copy_selected_files(staging)
        manifest = {
            "format": 1,
            "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "instance_id": metadata["instance_id"],
            "region": region,
            "database_data": "excluded; primary database remains external",
            "health_records": "excluded",
            "files": copied,
        }
        (staging / "MANIFEST.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        encrypted = temporary_root / "backup.tar.gz.gpg"
        encrypt_staging(staging, encrypted, passphrase)
        with encrypted.open("rb") as handle:
            object_client.put_object(
                namespace,
                config["OCI_BACKUP_BUCKET"],
                object_name,
                handle,
                content_length=encrypted.stat().st_size,
                content_type="application/octet-stream",
            )
        LOG.info("backup terenkripsi tersimpan: %s (%s byte)", object_name, encrypted.stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
