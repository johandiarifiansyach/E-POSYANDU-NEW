#!/usr/bin/env python3
"""Materialize selected OCI Vault secrets into a short-lived env file."""

from __future__ import annotations

import base64
import os
import stat
import tempfile
from pathlib import Path
from urllib.parse import quote

import oci
from oci.auth.signers import InstancePrincipalsSecurityTokenSigner


CONFIG_FILE = Path("/etc/e-posyandu/vault.env")
NUTRITION_OUTPUT_FILE = Path("/run/e-posyandu/nutrition-grpc-vault.env")
ORACLE_API_OUTPUT_FILE = Path("/run/e-posyandu/oracle-api-vault.env")
CLOUDFLARE_TUNNEL_TOKEN_FILE = Path(
    "/run/e-posyandu/cloudflare-tunnel-token"
)
NUTRITION_SECRET_SPECS = (
    ("CLOUDFLARE_QUEUES_API_TOKEN", "OCI_SECRET_CLOUDFLARE_QUEUES_API_TOKEN_ID"),
    ("RUST_WORKER_SHARED_SECRET", "OCI_SECRET_RUST_WORKER_SHARED_SECRET_ID"),
)
ORACLE_API_SECRET_SPECS = (
    ("SUPABASE_URL", "OCI_SECRET_SUPABASE_URL_ID"),
    ("SUPABASE_PUBLISHABLE_KEY", "OCI_SECRET_SUPABASE_PUBLISHABLE_KEY_ID"),
    ("SUPABASE_SECRET_KEY", "OCI_SECRET_SUPABASE_SECRET_KEY_ID"),
    ("TURNSTILE_SECRET_KEY", "OCI_SECRET_TURNSTILE_SECRET_KEY_ID"),
    ("ORACLE_API_SESSION_KEY", "OCI_SECRET_ORACLE_API_SESSION_KEY_ID"),
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
    # OCI Console commonly preserves the final newline produced by clipboard
    # commands. Remove exactly one terminal line ending, never embedded lines.
    if value.endswith("\r\n"):
        value = value[:-2]
    elif value.endswith("\n"):
        value = value[:-1]
    if not value:
        raise RuntimeError(f"Secret {name} kosong")
    if any(character in value for character in ("\x00", "\r", "\n")):
        raise RuntimeError(f"Secret {name} mengandung karakter baris yang tidak didukung")
    return value


def write_env_file(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent, text=True
    )
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for name, value in values.items():
                handle.write(f"{name}={value}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def write_secret_file(path: Path, value: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def main() -> None:
    config = parse_env(CONFIG_FILE)
    region = config.get("OCI_VAULT_REGION", "ap-batam-1")
    missing = [key for _, key in NUTRITION_SECRET_SPECS if not config.get(key)]
    if missing:
        raise RuntimeError(f"Konfigurasi Vault belum lengkap: {', '.join(missing)}")

    signer = InstancePrincipalsSecurityTokenSigner()
    client = oci.secrets.SecretsClient({"region": region}, signer=signer)
    nutrition_values = {
        name: fetch_secret(client, config[secret_id_key], name)
        for name, secret_id_key in NUTRITION_SECRET_SPECS
    }
    write_env_file(NUTRITION_OUTPUT_FILE, nutrition_values)

    configured_api = [
        config_key for _, config_key in ORACLE_API_SECRET_SPECS if config.get(config_key)
    ]
    if configured_api and len(configured_api) != len(ORACLE_API_SECRET_SPECS):
        missing_api = [
            config_key
            for _, config_key in ORACLE_API_SECRET_SPECS
            if not config.get(config_key)
        ]
        raise RuntimeError(
            "Konfigurasi Vault API Oracle belum lengkap: " + ", ".join(missing_api)
        )
    oracle_api_values = {
        name: fetch_secret(client, config[secret_id_key], name)
        for name, secret_id_key in ORACLE_API_SECRET_SPECS
        if config.get(secret_id_key)
    }
    # Oracle membuat job langsung di database dan mendorong pesan ke Queue.
    # Gunakan token Vault yang sama; jangan menyalinnya ke env host.
    oracle_api_values["CLOUDFLARE_QUEUES_API_TOKEN"] = nutrition_values[
        "CLOUDFLARE_QUEUES_API_TOKEN"
    ]
    # API native dan worker gizi memakai token yang sama untuk autentikasi
    # komunikasi gRPC privat. Nilai tetap berasal dari Vault dan hanya ditulis
    # ke tmpfs mode 0600.
    oracle_api_values["RUST_WORKER_SHARED_SECRET"] = nutrition_values[
        "RUST_WORKER_SHARED_SECRET"
    ]
    database_password_secret_id = config.get(
        "OCI_SECRET_ORACLE_DATABASE_PASSWORD_ID"
    )
    if database_password_secret_id:
        database_password = fetch_secret(
            client,
            database_password_secret_id,
            "Oracle PostgreSQL application password",
        )
        oracle_api_values["ORACLE_DATABASE_URL"] = (
            "postgresql://eposyandu_api:"
            + quote(database_password, safe="")
            + "@host.containers.internal:5432/eposyandu?sslmode=disable"
        )
    # Compose requires this file even while native auth is still disabled.
    write_env_file(ORACLE_API_OUTPUT_FILE, oracle_api_values)

    tunnel_secret_id = config.get("OCI_SECRET_CLOUDFLARE_TUNNEL_TOKEN_ID")
    if tunnel_secret_id:
        write_secret_file(
            CLOUDFLARE_TUNNEL_TOKEN_FILE,
            fetch_secret(client, tunnel_secret_id, "Cloudflare Tunnel token"),
        )
        tunnel_count = 1
    else:
        # Selalu timpa file agar token lama tidak tertinggal setelah OCID
        # dihapus. File kosong juga membuat Compose profile nonaktif tetap
        # dapat divalidasi tanpa membuat bind mount rahasia secara manual.
        write_secret_file(CLOUDFLARE_TUNNEL_TOKEN_FILE, "")
        tunnel_count = 0

    print(
        "Secret runtime OCI berhasil disiapkan "
        f"({len(oracle_api_values)} secret API dan "
        f"{tunnel_count} token Tunnel materialized)."
    )


if __name__ == "__main__":
    main()
