#!/usr/bin/env python3
"""Materialize selected OCI Vault secrets into a short-lived env file."""

from __future__ import annotations

import base64
import os
import stat
import tempfile
from pathlib import Path

import oci
from oci.auth.signers import InstancePrincipalsSecurityTokenSigner


CONFIG_FILE = Path("/etc/e-posyandu/vault.env")
OUTPUT_FILE = Path("/run/e-posyandu/nutrition-grpc-vault.env")
SECRET_SPECS = (
    ("CLOUDFLARE_QUEUES_API_TOKEN", "OCI_SECRET_CLOUDFLARE_QUEUES_API_TOKEN_ID"),
    ("RUST_WORKER_SHARED_SECRET", "OCI_SECRET_RUST_WORKER_SHARED_SECRET_ID"),
)


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value
    return values


def fetch_secret(client: oci.secrets.SecretsClient, secret_id: str, name: str) -> str:
    bundle = client.get_secret_bundle(secret_id, stage="CURRENT").data
    content = bundle.secret_bundle_content
    if content is None or not content.content:
        raise RuntimeError(f"Secret {name} tidak memiliki isi CURRENT")
    try:
        value = base64.b64decode(content.content, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"Secret {name} bukan teks UTF-8 base64 yang valid") from exc
    if any(character in value for character in ("\x00", "\r", "\n")):
        raise RuntimeError(f"Secret {name} mengandung karakter baris yang tidak didukung")
    return value


def write_output(values: dict[str, str]) -> None:
    OUTPUT_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(OUTPUT_FILE.parent, 0o700)
    fd, temporary_name = tempfile.mkstemp(
        prefix=".nutrition-grpc-vault.env.", dir=OUTPUT_FILE.parent, text=True
    )
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for name, value in values.items():
                handle.write(f"{name}={value}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, OUTPUT_FILE)
        os.chmod(OUTPUT_FILE, 0o600)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def main() -> None:
    config = parse_env(CONFIG_FILE)
    region = config.get("OCI_VAULT_REGION", "ap-batam-1")
    missing = [key for _, key in SECRET_SPECS if not config.get(key)]
    if missing:
        raise RuntimeError(f"Konfigurasi Vault belum lengkap: {', '.join(missing)}")

    signer = InstancePrincipalsSecurityTokenSigner()
    client = oci.secrets.SecretsClient({"region": region}, signer=signer)
    values = {
        name: fetch_secret(client, config[secret_id_key], name)
        for name, secret_id_key in SECRET_SPECS
    }
    write_output(values)
    print("Secret runtime OCI berhasil disiapkan.")


if __name__ == "__main__":
    main()
