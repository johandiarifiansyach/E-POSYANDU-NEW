#!/usr/bin/env python3
"""Create, verify, encrypt, and upload the native PostgreSQL backup."""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import os
import pwd
import re
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import oci
from oci.auth.signers import InstancePrincipalsSecurityTokenSigner


LOG = logging.getLogger("eposyandu-postgresql-backup")
CONFIG_FILE = Path("/etc/e-posyandu/backup.env")
WORK_ROOT = Path("/var/lib/pgsql/backup")
IMDS_URL = "http://169.254.169.254/opc/v2/instance/"
BACKUP_OBJECT_PATTERN = re.compile(
    r"^e-posyandu-postgresql-(?P<timestamp>\d{8}T\d{6}Z)\.dump\.gpg$"
)


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            values[name.strip()] = value.strip().strip('"\'')
    return values


def metadata() -> dict[str, str]:
    request = urllib.request.Request(
        IMDS_URL,
        headers={"Authorization": "Bearer Oracle"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        payload = json.load(response)
    return {"region": str(payload["region"]), "instance_id": str(payload["id"])}


def fetch_passphrase(client: oci.secrets.SecretsClient, secret_id: str) -> str:
    bundle = client.get_secret_bundle(secret_id, stage="CURRENT").data
    content = bundle.secret_bundle_content
    if content is None or not content.content:
        raise RuntimeError("Secret enkripsi backup tidak memiliki isi CURRENT")
    value = base64.b64decode(content.content, validate=True).decode("utf-8")
    if value.endswith("\r\n"):
        value = value[:-2]
    elif value.endswith("\n"):
        value = value[:-1]
    if len(value) < 20 or any(char in value for char in ("\x00", "\r", "\n")):
        raise RuntimeError("Secret enkripsi backup tidak valid")
    return value


def run(command: list[str], *, timeout: int = 600) -> None:
    completed = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    if completed.returncode:
        detail = completed.stderr.strip().splitlines()[-1:] or ["unknown error"]
        raise RuntimeError(f"Perintah backup gagal: {detail[0]}")


def cleanup_old_backups(
    objects: oci.object_storage.ObjectStorageClient,
    namespace: str,
    bucket: str,
    prefix: str,
    retention_days: int,
) -> int:
    """Remove only this job's encrypted dumps beyond the configured window."""

    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=retention_days)
    listed = objects.list_objects(
        namespace,
        bucket,
        prefix=f"{prefix}/",
        fields="name,timeCreated",
        limit=1000,
    ).data
    deleted = 0
    for item in listed.objects or []:
        name = str(item.name or "")
        match = BACKUP_OBJECT_PATTERN.fullmatch(name.rsplit("/", 1)[-1])
        if match is None or item.time_created is None:
            continue
        created_at = dt.datetime.strptime(
            match.group("timestamp"), "%Y%m%dT%H%M%SZ"
        ).replace(tzinfo=dt.timezone.utc)
        if created_at < cutoff:
            objects.delete_object(namespace, bucket, name)
            deleted += 1
    return deleted


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    config = parse_env(CONFIG_FILE)
    required = ("OCI_BACKUP_BUCKET", "OCI_BACKUP_ENCRYPTION_SECRET_ID")
    missing = [name for name in required if not config.get(name)]
    if missing:
        raise RuntimeError(f"Konfigurasi backup belum lengkap: {', '.join(missing)}")

    instance = metadata()
    region = config.get("OCI_BACKUP_REGION", instance["region"])
    database = config.get("OCI_POSTGRESQL_BACKUP_DATABASE", "eposyandu")
    if not database.replace("_", "").isalnum():
        raise RuntimeError("Nama database backup tidak valid")
    prefix = config.get("OCI_BACKUP_PREFIX", "production/oracle").strip("/")
    retention_text = config.get("OCI_BACKUP_RETENTION_DAYS", "30")
    try:
        retention_days = int(retention_text)
    except ValueError as exc:
        raise RuntimeError("OCI_BACKUP_RETENTION_DAYS harus berupa angka") from exc
    if not 7 <= retention_days <= 365:
        raise RuntimeError("OCI_BACKUP_RETENTION_DAYS harus antara 7 dan 365 hari")
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    object_name = f"{prefix}/e-posyandu-postgresql-{timestamp}.dump.gpg"

    signer = InstancePrincipalsSecurityTokenSigner()
    secrets = oci.secrets.SecretsClient({"region": region}, signer=signer)
    passphrase = fetch_passphrase(secrets, config["OCI_BACKUP_ENCRYPTION_SECRET_ID"])
    objects = oci.object_storage.ObjectStorageClient({"region": region}, signer=signer)
    namespace = objects.get_namespace().data

    postgres = pwd.getpwnam("postgres")
    WORK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(WORK_ROOT, postgres.pw_uid, postgres.pw_gid)
    os.chmod(WORK_ROOT, 0o700)
    temporary = Path(tempfile.mkdtemp(prefix="run-", dir=WORK_ROOT))
    os.chown(temporary, postgres.pw_uid, postgres.pw_gid)
    os.chmod(temporary, 0o700)
    try:
        dump = temporary / "eposyandu.dump"
        encrypted = temporary / "eposyandu.dump.gpg"
        passphrase_file = temporary / ".passphrase"
        gpg_home = temporary / ".gnupg"
        gpg_home.mkdir(mode=0o700)
        passphrase_file.write_text(passphrase, encoding="utf-8")
        os.chmod(passphrase_file, 0o600)
        run(
            [
                "runuser",
                "-u",
                "postgres",
                "--",
                "/usr/bin/pg_dump",
                f"--dbname={database}",
                "--format=custom",
                "--compress=zstd:9",
                "--no-owner",
                "--no-acl",
                f"--file={dump}",
            ]
        )
        run(["/usr/bin/pg_restore", "--list", str(dump)], timeout=120)
        run(
            [
                "/usr/bin/gpg",
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
                str(encrypted),
                str(dump),
            ]
        )
        passphrase_file.unlink(missing_ok=True)
        dump.unlink(missing_ok=True)
        with encrypted.open("rb") as handle:
            objects.put_object(
                namespace,
                config["OCI_BACKUP_BUCKET"],
                object_name,
                handle,
                content_length=encrypted.stat().st_size,
                content_type="application/octet-stream",
            )
        LOG.info(
            "backup PostgreSQL terenkripsi tersimpan: %s (%s byte)",
            object_name,
            encrypted.stat().st_size,
        )
        deleted = cleanup_old_backups(
            objects, namespace, config["OCI_BACKUP_BUCKET"], prefix, retention_days
        )
        if deleted:
            LOG.info("backup PostgreSQL lama dihapus: %s objek", deleted)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
