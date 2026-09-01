#!/usr/bin/env python3
"""Prepare, validate, and atomically promote the native PostgreSQL database.

The source password is fetched through the instance principal and is only
passed to PostgreSQL client processes through their environment. It is never
written to a command line, manifest, or log.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import oci
from oci.auth.signers import InstancePrincipalsSecurityTokenSigner


CONFIG_FILE = Path("/etc/e-posyandu/stage3-migration.env")
WORK_ROOT = Path("/var/lib/pgsql/migration")
LIVE_DATABASE = "eposyandu"
API_ROLE = "eposyandu_api"
IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            values[name.strip()] = value.strip().strip("\"'")
    return values


def fetch_secret(secret_id: str) -> str:
    signer = InstancePrincipalsSecurityTokenSigner()
    request = urllib.request.Request(
        "http://169.254.169.254/opc/v2/instance/",
        headers={"Authorization": "Bearer Oracle"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        region = str(json.load(response)["region"])
    client = oci.secrets.SecretsClient({"region": region}, signer=signer)
    bundle = client.get_secret_bundle(secret_id, stage="CURRENT").data
    content = bundle.secret_bundle_content
    if content is None or not content.content:
        raise RuntimeError("Secret URL database sumber tidak memiliki isi CURRENT")
    value = base64.b64decode(content.content, validate=True).decode("utf-8")
    return value.rstrip("\r\n")


def source_connection(url: str) -> tuple[list[str], dict[str, str]]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("postgres", "postgresql"):
        raise RuntimeError("Secret sumber bukan URL PostgreSQL")
    if not parsed.hostname or not parsed.username or parsed.password is None:
        raise RuntimeError("URL PostgreSQL sumber tidak lengkap")
    database = urllib.parse.unquote(parsed.path.lstrip("/"))
    if not database:
        raise RuntimeError("URL PostgreSQL sumber tidak memiliki nama database")
    args = [
        "-h",
        parsed.hostname,
        "-p",
        str(parsed.port or 5432),
        "-U",
        urllib.parse.unquote(parsed.username),
        "-d",
        database,
    ]
    query = urllib.parse.parse_qs(parsed.query)
    environment = os.environ.copy()
    environment["PGPASSWORD"] = urllib.parse.unquote(parsed.password)
    environment["PGAPPNAME"] = "eposyandu-stage3-migration"
    environment["PGOPTIONS"] = "-c timezone=UTC -c statement_timeout=0"
    environment["PGSSLMODE"] = query.get("sslmode", ["require"])[-1]
    if query.get("channel_binding"):
        environment["PGCHANNELBINDING"] = query["channel_binding"][-1]
    return args, environment


def run(
    command: list[str],
    *,
    environment: dict[str, str] | None = None,
    capture: bool = False,
    timeout: int = 1_800,
) -> str:
    completed = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
        timeout=timeout,
    )
    if completed.returncode:
        detail = completed.stderr.strip().splitlines()[-1:] or ["unknown error"]
        raise RuntimeError(f"Perintah migrasi gagal: {detail[0]}")
    return completed.stdout.strip() if capture else ""


def local_command(program: str, database: str, *arguments: str) -> list[str]:
    return [
        "/usr/sbin/runuser",
        "-u",
        "postgres",
        "--",
        "/usr/bin/env",
        "PGOPTIONS=-c timezone=UTC -c statement_timeout=0",
        program,
        "-d",
        database,
        *arguments,
    ]


def local_sql(database: str, sql: str, *, capture: bool = False) -> str:
    return run(
        local_command(
            "/usr/bin/psql",
            database,
            "-X",
            "--no-psqlrc",
            "--set=ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--command",
            sql,
        ),
        capture=capture,
    )


def source_sql(connection: list[str], environment: dict[str, str], sql: str) -> str:
    return run(
        [
            "/usr/bin/psql",
            *connection,
            "-X",
            "--no-psqlrc",
            "--set=ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--command",
            sql,
        ],
        environment=environment,
        capture=True,
    )


def quote_identifier(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise RuntimeError(f"Identifier PostgreSQL tidak valid: {value!r}")
    return '"' + value + '"'


def database_exists(database: str) -> bool:
    escaped = database.replace("'", "''")
    return local_sql(
        "postgres",
        f"select exists(select 1 from pg_database where datname='{escaped}');",
        capture=True,
    ) == "t"


def public_tables_source(connection: list[str], environment: dict[str, str]) -> list[str]:
    result = source_sql(
        connection,
        environment,
        "select tablename from pg_catalog.pg_tables "
        "where schemaname='public' order by tablename;",
    )
    tables = [line for line in result.splitlines() if line]
    if not tables or any(not IDENTIFIER.fullmatch(table) for table in tables):
        raise RuntimeError("Daftar tabel public sumber tidak valid")
    return tables


def fingerprint_query(table: str) -> str:
    relation = f"public.{quote_identifier(table)}"
    return (
        "select count(*)::text || ':' || "
        "coalesce(md5(string_agg(payload, E'\\n' order by payload collate \"C\")), md5('')) "
        f"from (select to_jsonb(row_value)::text as payload from {relation} row_value) rows;"
    )


def fingerprints_source(
    connection: list[str], environment: dict[str, str], tables: list[str]
) -> dict[str, str]:
    return {
        table: source_sql(connection, environment, fingerprint_query(table))
        for table in tables
    }


def fingerprints_local(database: str, tables: list[str]) -> dict[str, str]:
    return {
        table: local_sql(database, fingerprint_query(table), capture=True)
        for table in tables
    }


def setup_candidate(database: str, dump: Path) -> None:
    quoted_database = quote_identifier(database)
    local_sql(
        "postgres",
        f"create database {quoted_database} template template0 encoding 'UTF8';",
    )
    local_sql(
        database,
        "drop schema public cascade;"
        "create schema auth;"
        "create table auth.users (id uuid primary key);"
        "create or replace function auth.uid() returns uuid language sql stable "
        "set search_path=pg_catalog as $$"
        "select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid"
        "$$;",
    )
    for section in ("pre-data", "data"):
        run(
            local_command(
                "/usr/bin/pg_restore",
                database,
                "--exit-on-error",
                "--no-owner",
                "--no-acl",
                f"--section={section}",
                str(dump),
            )
        )
        if section == "pre-data":
            local_sql(
                database,
                "create extension if not exists pg_stat_statements;",
            )
    local_sql(
        database,
        "insert into auth.users(id) "
        "select distinct user_id from public.app_users where user_id is not null "
        "on conflict (id) do nothing;",
    )
    run(
        local_command(
            "/usr/bin/pg_restore",
            database,
            "--exit-on-error",
            "--no-owner",
            "--no-acl",
            "--section=post-data",
            str(dump),
        )
    )
    local_sql(
        database,
        f"grant connect on database {quoted_database} to {API_ROLE};"
        f"grant usage on schema public, auth to {API_ROLE};"
        f"grant select, insert, update, delete on all tables in schema public to {API_ROLE};"
        f"grant select on auth.users to {API_ROLE};"
        f"grant usage, select, update on all sequences in schema public to {API_ROLE};"
        f"grant execute on all functions in schema public, auth to {API_ROLE};"
        f"alter default privileges in schema public grant select, insert, update, delete on tables to {API_ROLE};"
        f"alter default privileges in schema public grant usage, select, update on sequences to {API_ROLE};"
        f"alter default privileges in schema public grant execute on functions to {API_ROLE};"
        "analyze;",
    )


def validate_candidate(
    database: str,
    connection: list[str],
    environment: dict[str, str],
    tables: list[str],
) -> dict[str, object]:
    local_tables = local_sql(
        database,
        "select tablename from pg_catalog.pg_tables "
        "where schemaname='public' order by tablename;",
        capture=True,
    ).splitlines()
    if local_tables != tables:
        raise RuntimeError("Daftar tabel kandidat tidak sama dengan sumber")
    source_fingerprints = fingerprints_source(connection, environment, tables)
    target_fingerprints = fingerprints_local(database, tables)
    different = [
        table
        for table in tables
        if source_fingerprints[table] != target_fingerprints[table]
    ]
    if different:
        raise RuntimeError(
            "Fingerprint sumber berubah/tidak cocok: " + ", ".join(different)
        )
    invalid_constraints = local_sql(
        database,
        "select count(*) from pg_constraint where not convalidated;",
        capture=True,
    )
    if invalid_constraints != "0":
        raise RuntimeError("Kandidat memiliki constraint yang belum tervalidasi")
    source_functions = source_sql(
        connection,
        environment,
        "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
        "where n.nspname='public' and not exists ("
        "select 1 from pg_depend d where d.classid='pg_proc'::regclass "
        "and d.objid=p.oid and d.deptype='e');",
    )
    target_functions = local_sql(
        database,
        "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
        "where n.nspname='public' and not exists ("
        "select 1 from pg_depend d where d.classid='pg_proc'::regclass "
        "and d.objid=p.oid and d.deptype='e');",
        capture=True,
    )
    if source_functions != target_functions:
        raise RuntimeError("Jumlah function public kandidat tidak sama dengan sumber")
    auth_users = local_sql(
        database, "select count(*) from auth.users;", capture=True
    )
    app_users = local_sql(
        database,
        "select count(distinct user_id) from public.app_users where user_id is not null;",
        capture=True,
    )
    if auth_users != app_users:
        raise RuntimeError("Identitas kompatibilitas auth tidak lengkap")
    return {
        "tables": len(tables),
        "functions": int(target_functions),
        "authUsers": int(auth_users),
        "fingerprints": target_fingerprints,
    }


def prepare(database: str) -> None:
    if not IDENTIFIER.fullmatch(database) or database == LIVE_DATABASE:
        raise RuntimeError("Nama database kandidat tidak valid")
    if database_exists(database):
        raise RuntimeError(f"Database kandidat {database} sudah ada")
    config = parse_env(CONFIG_FILE)
    secret_id = config.get("OCI_SECRET_SOURCE_DATABASE_URL_ID")
    if not secret_id:
        raise RuntimeError("OCID secret database sumber belum dikonfigurasi")
    source_url = fetch_secret(secret_id)
    connection, environment = source_connection(source_url)
    source_version = int(source_sql(connection, environment, "show server_version_num;"))
    dump_version_text = run(["/usr/bin/pg_dump", "--version"], capture=True)
    match = re.search(r"(\d+)(?:\.\d+)?", dump_version_text)
    if not match or int(match.group(1)) < source_version // 10000:
        raise RuntimeError("pg_dump lebih lama daripada PostgreSQL sumber")

    WORK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(WORK_ROOT, 0o700)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dump = WORK_ROOT / f"supabase-public-{timestamp}.dump"
    manifest = WORK_ROOT / f"{database}-{timestamp}.json"
    tables = public_tables_source(connection, environment)
    try:
        run(
            [
                "/usr/bin/pg_dump",
                *connection,
                "--schema=public",
                "--format=custom",
                "--compress=zstd:9",
                "--no-owner",
                "--no-acl",
                "--lock-wait-timeout=30000",
                f"--file={dump}",
            ],
            environment=environment,
        )
        os.chmod(dump, 0o640)
        postgres = __import__("pwd").getpwnam("postgres")
        os.chown(dump, postgres.pw_uid, postgres.pw_gid)
        run(["/usr/bin/pg_restore", "--list", str(dump)], capture=True, timeout=120)
        setup_candidate(database, dump)
        validation = validate_candidate(
            database, connection, environment, tables
        )
        payload = {
            "preparedAt": timestamp,
            "candidate": database,
            "sourceMajor": source_version // 10000,
            "dump": dump.name,
            "dumpBytes": dump.stat().st_size,
            "dumpSha256": hashlib.sha256(dump.read_bytes()).hexdigest(),
            "validation": validation,
        }
        manifest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.chmod(manifest, 0o600)
        print(
            f"Kandidat {database} siap: {validation['tables']} tabel, "
            f"{validation['functions']} function, fingerprint cocok."
        )
        print(f"Manifest: {manifest}")
    except Exception:
        print(
            f"Kandidat {database} tidak dipromosikan; periksa lalu hapus secara eksplisit bila perlu.",
            file=sys.stderr,
        )
        raise
    finally:
        environment["PGPASSWORD"] = ""
        source_url = ""


def application_containers_running() -> list[str]:
    output = run(
        ["/usr/bin/podman", "ps", "--format", "{{.Names}}"], capture=True
    )
    return [
        name
        for name in output.splitlines()
        if "oracle-api" in name or "data-processing-worker" in name
    ]


def promote(database: str) -> None:
    if not IDENTIFIER.fullmatch(database) or database == LIVE_DATABASE:
        raise RuntimeError("Nama database kandidat tidak valid")
    running = application_containers_running()
    if running:
        raise RuntimeError(
            "Hentikan API dan data-processing worker sebelum promosi: " + ", ".join(running)
        )
    if not database_exists(database) or not database_exists(LIVE_DATABASE):
        raise RuntimeError("Database kandidat atau database live tidak ditemukan")
    ready = local_sql(
        database,
        "select to_regclass('public.schema_migrations') is not null;",
        capture=True,
    )
    if ready != "t":
        raise RuntimeError("Database kandidat belum siap")
    suffix = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d_%H%M%S")
    previous = f"eposyandu_pre_cutover_{suffix}"
    live = quote_identifier(LIVE_DATABASE)
    candidate = quote_identifier(database)
    backup = quote_identifier(previous)
    local_sql(
        "postgres",
        f"alter database {live} connection limit 0;"
        f"select pg_terminate_backend(pid) from pg_stat_activity "
        f"where datname='{LIVE_DATABASE}' and pid <> pg_backend_pid();"
        f"alter database {live} rename to {backup};"
        f"alter database {backup} allow_connections false;"
        f"alter database {candidate} rename to {live};"
        f"alter database {live} connection limit 100;",
    )
    print(f"Promosi atomik selesai: {database} -> {LIVE_DATABASE}")
    print(f"Snapshot rollback lokal: {previous} (koneksi dinonaktifkan)")


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--database", required=True)
    promote_parser = subparsers.add_parser("promote")
    promote_parser.add_argument("--database", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Jalankan migrasi sebagai root")
    if args.command == "prepare":
        prepare(args.database)
    else:
        promote(args.database)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
