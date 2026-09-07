use std::{collections::HashMap, env, str::FromStr, time::Duration};

use axum::http::Method;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use futures_util::{StreamExt, stream::poll_fn};
use serde_json::{Map, Value, json};
use tokio_postgres::{
    AsyncMessage, NoTls,
    error::SqlState,
    types::{Json, ToSql},
};
use tracing::{error, warn};
use uuid::Uuid;

use crate::native_cache::NativeCache;
use crate::realtime::{NOTIFY_CHANNEL, RealtimeEvent, RealtimeHub};

const DEFAULT_POOL_SIZE: usize = 5;
const DEFAULT_POOL_WAIT_TIMEOUT_SECONDS: f64 = 2.0;
const DEFAULT_POOL_CREATE_TIMEOUT_SECONDS: f64 = 5.0;
const DEFAULT_POOL_RECYCLE_TIMEOUT_SECONDS: f64 = 2.0;

type SqlParameter = Box<dyn ToSql + Sync + Send>;

fn pool_timeout(name: &str, default_seconds: f64) -> Option<Duration> {
    let value = env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .unwrap_or(default_seconds);
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(value.clamp(0.1, 30.0)))
}

fn parse_user_uuid(user_id: &str) -> Result<Uuid, DatabaseError> {
    Uuid::parse_str(user_id).map_err(|_| DatabaseError::Invalid)
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum DatabaseError {
    Unavailable,
    Conflict,
    Invalid,
}

pub(crate) struct QueryResult {
    pub(crate) value: Value,
    pub(crate) content_range: Option<String>,
}

pub(crate) struct NativeDatabase {
    pool: Pool,
    config: tokio_postgres::Config,
}

impl NativeDatabase {
    pub(crate) fn from_env() -> Result<Self, String> {
        let database_url = env::var("ORACLE_DATABASE_URL")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "ORACLE_DATABASE_URL wajib diisi untuk PostgreSQL native Oracle.".to_string()
            })?;
        let config = tokio_postgres::Config::from_str(&database_url)
            .map_err(|_| "ORACLE_DATABASE_URL bukan URL PostgreSQL valid.".to_string())?;
        let pool_size = env::var("ORACLE_DATABASE_POOL_SIZE")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(DEFAULT_POOL_SIZE);
        if !(1..=10).contains(&pool_size) {
            return Err("ORACLE_DATABASE_POOL_SIZE wajib antara 1 dan 10.".into());
        }
        let pool_wait_timeout = pool_timeout(
            "ORACLE_DATABASE_POOL_WAIT_TIMEOUT_SECONDS",
            DEFAULT_POOL_WAIT_TIMEOUT_SECONDS,
        );
        let pool_create_timeout = pool_timeout(
            "ORACLE_DATABASE_POOL_CREATE_TIMEOUT_SECONDS",
            DEFAULT_POOL_CREATE_TIMEOUT_SECONDS,
        );
        let pool_recycle_timeout = pool_timeout(
            "ORACLE_DATABASE_POOL_RECYCLE_TIMEOUT_SECONDS",
            DEFAULT_POOL_RECYCLE_TIMEOUT_SECONDS,
        );
        let manager = Manager::from_config(
            config.clone(),
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(pool_size)
            .runtime(Runtime::Tokio1)
            .wait_timeout(pool_wait_timeout)
            .create_timeout(pool_create_timeout)
            .recycle_timeout(pool_recycle_timeout)
            .build()
            .map_err(|_| "Pool PostgreSQL native Oracle tidak dapat dibuat.".to_string())?;
        Ok(Self { pool, config })
    }

    pub(crate) async fn notify_realtime(&self, event: &RealtimeEvent) -> bool {
        let Ok(payload) = serde_json::to_string(event) else {
            return false;
        };
        let Ok(client) = self.pool.get().await else {
            return false;
        };
        let Ok(statement) = client.prepare_cached("SELECT pg_notify($1, $2)").await else {
            return false;
        };
        client
            .query_one(&statement, &[&NOTIFY_CHANNEL, &payload])
            .await
            .is_ok()
    }

    pub(crate) async fn listen_realtime(&self, hub: RealtimeHub, cache: Option<NativeCache>) {
        let config = self.config.clone();
        loop {
            let connection = config.connect(NoTls).await;
            let (client, mut connection) = match connection {
                Ok(value) => value,
                Err(error_value) => {
                    warn!(error = %error_value, "listener realtime PostgreSQL tidak dapat terhubung");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            if let Err(error_value) = client
                .batch_execute(&format!("LISTEN {NOTIFY_CHANNEL}"))
                .await
            {
                warn!(error = %error_value, "listener realtime PostgreSQL gagal mendaftar channel");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            let mut messages = Box::pin(poll_fn(move |context| connection.poll_message(context)));
            while let Some(message) = messages.next().await {
                match message {
                    Ok(AsyncMessage::Notification(notification))
                        if notification.channel() == NOTIFY_CHANNEL =>
                    {
                        if let Ok(event) =
                            serde_json::from_str::<RealtimeEvent>(notification.payload())
                        {
                            // Python commits materialized WHO/ML results
                            // directly to PostgreSQL, so no Rust mutation
                            // path gets a chance to bump Redis' dynamic
                            // cache version.  Analysis notifications close
                            // that gap without invalidating the cache for
                            // every polling request.
                            if event.operation == "analysis_updated"
                                && let Some(cache) = cache.as_ref()
                            {
                                cache.invalidate().await;
                            }
                            hub.publish(event);
                        }
                    }
                    Ok(_) => {}
                    Err(error_value) => {
                        warn!(error = %error_value, "listener realtime PostgreSQL terputus");
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    pub(crate) async fn ready(&self) -> bool {
        let client = match self.pool.get().await {
            Ok(client) => client,
            Err(error_value) => {
                error!(error = %error_value, "pool PostgreSQL native gagal memperoleh koneksi");
                return false;
            }
        };
        let statement = match client
            .prepare_cached("SELECT to_regclass('public.schema_migrations') IS NOT NULL")
            .await
        {
            Ok(statement) => statement,
            Err(error_value) => {
                error!(error = %error_value, "health check PostgreSQL native gagal menyiapkan statement");
                return false;
            }
        };
        match client.query_one(&statement, &[]).await {
            Ok(row) => row.get::<_, bool>(0),
            Err(error_value) => {
                error!(error = %error_value, "health check PostgreSQL native gagal");
                false
            }
        }
    }

    pub(crate) async fn get(
        &self,
        table: &str,
        parameters: &[(String, String)],
        count: bool,
    ) -> Result<QueryResult, DatabaseError> {
        ensure_table(table)?;
        let select = parameters
            .iter()
            .find(|(key, _)| key == "select")
            .map(|(_, value)| value.as_str())
            .unwrap_or("*");
        let join_children = select.contains("children(") || select.contains("children!inner(");
        let inner_children = select.contains("children!inner(");
        let mut values = Vec::<SqlParameter>::new();
        let filters = build_filters(parameters, &mut values, "t", join_children)?;
        let order = build_order(parameters)?;
        let limit = numeric_parameter(parameters, "limit")?;
        let offset = numeric_parameter(parameters, "offset")?;

        // Counting every matching row forces PostgreSQL to finish the full
        // scan even when the caller requested a small page. Only history
        // endpoints need an exact total; normal reads can stop at LIMIT.
        let total_expression = count
            .then_some(", count(*) OVER()::bigint AS total")
            .unwrap_or("");
        let mut sql = format!(
            "SELECT {}{} FROM public.{} AS t",
            document_expression(join_children),
            total_expression,
            quote_identifier(table)?
        );
        if join_children {
            sql.push_str(if inner_children {
                " INNER JOIN public.children AS c ON c.id = t.child_id"
            } else {
                " LEFT JOIN public.children AS c ON c.id = t.child_id"
            });
        }
        if !filters.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&filters.join(" AND "));
        }
        if !order.is_empty() {
            sql.push_str(" ORDER BY ");
            sql.push_str(&order.join(", "));
        }
        if let Some(limit) = limit {
            let placeholder = push_parameter(&mut values, limit);
            sql.push_str(&format!(" LIMIT {placeholder}"));
        }
        if let Some(offset) = offset {
            let placeholder = push_parameter(&mut values, offset);
            sql.push_str(&format!(" OFFSET {placeholder}"));
        }

        let client = self.pool.get().await.map_err(|error_value| {
            error!(error = %error_value, "pool PostgreSQL native tidak tersedia");
            DatabaseError::Unavailable
        })?;
        let refs = parameter_refs(&values);
        let statement = client.prepare_cached(&sql).await.map_err(|error| {
            map_postgres_query_error(error, "prepare select", &sql, values.len())
        })?;
        let rows = client
            .query(&statement, &refs)
            .await
            .map_err(|error| map_postgres_query_error(error, "select", &sql, values.len()))?;
        let total = count
            .then(|| {
                rows.first()
                    .map(|row| row.get::<_, i64>("total"))
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        let mut documents = rows
            .iter()
            .map(|row| row.get::<_, Json<Value>>("document").0)
            .collect::<Vec<_>>();
        // Derived WHO/N/T/O/B/ASI/risk fields are written by Python and joined
        // only for reads.  A missing table/row is tolerated during a rolling
        // migration; callers then see the raw document plus a pending marker.
        if table == "measurements" && !documents.is_empty() {
            let ids = documents
                .iter()
                .filter_map(|document| {
                    document
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect::<Vec<_>>();
            if !ids.is_empty()
                && let Ok(statement) = client
                    .prepare_cached(
                        "SELECT measurement_id, bbu_status, tbu_status, bbtb_status, imtu_status,
                                lila_status, lk_status, bbu_z_score::double precision as bbu_z_score,
                                tbu_z_score::double precision as tbu_z_score,
                                bbtb_z_score::double precision as bbtb_z_score,
                                imtu_z_score::double precision as imtu_z_score,
                                lila_z_score::double precision as lila_z_score,
                                lk_z_score::double precision as lk_z_score, weight_gain_status,
                                weight_gain_minimum_grams, exclusive_breastfeeding_status,
                                result_json
                         FROM public.measurement_analysis
                         WHERE measurement_id = ANY($1::text[])",
                    )
                    .await
                && let Ok(analysis_rows) = client.query(&statement, &[&ids]).await
            {
                let by_id = analysis_rows
                    .into_iter()
                    .map(|row| {
                        let id = row.get::<_, String>("measurement_id");
                        let derived = json!({
                            "bbuStatus": row.get::<_, Option<String>>("bbu_status"),
                            "tbuStatus": row.get::<_, Option<String>>("tbu_status"),
                            "bbtbStatus": row.get::<_, Option<String>>("bbtb_status"),
                            "imtuStatus": row.get::<_, Option<String>>("imtu_status"),
                            "lilaStatus": row.get::<_, Option<String>>("lila_status"),
                            "lkStatus": row.get::<_, Option<String>>("lk_status"),
                            "bbuZScore": row.get::<_, Option<f64>>("bbu_z_score"),
                            "tbuZScore": row.get::<_, Option<f64>>("tbu_z_score"),
                            "bbtbZScore": row.get::<_, Option<f64>>("bbtb_z_score"),
                            "imtuZScore": row.get::<_, Option<f64>>("imtu_z_score"),
                            "lilaZScore": row.get::<_, Option<f64>>("lila_z_score"),
                            "lkZScore": row.get::<_, Option<f64>>("lk_z_score"),
                            "statusNaik": row.get::<_, Option<String>>("weight_gain_status"),
                            "weightGainStatus": row.get::<_, Option<String>>("weight_gain_status"),
                            "weightGainMinimumGrams": row.get::<_, Option<i32>>("weight_gain_minimum_grams"),
                            "exclusiveBreastfeedingStatus": row.get::<_, Option<String>>("exclusive_breastfeeding_status"),
                            "analysis": row.get::<_, Json<Value>>("result_json").0,
                            "analysisPending": false,
                        });
                        (id, derived)
                    })
                    .collect::<HashMap<_, _>>();
                for document in &mut documents {
                    if let Some(object) = document.as_object_mut()
                        && let Some(id) = object.get("id").and_then(Value::as_str)
                    {
                        let derived = by_id
                            .get(id)
                            .cloned()
                            .unwrap_or_else(|| {
                                json!({
                                    "bbuStatus": null,
                                    "tbuStatus": null,
                                    "bbtbStatus": null,
                                    "imtuStatus": null,
                                    "lilaStatus": null,
                                    "lkStatus": null,
                                    "bbuZScore": null,
                                    "tbuZScore": null,
                                    "bbtbZScore": null,
                                    "imtuZScore": null,
                                    "lilaZScore": null,
                                    "lkZScore": null,
                                    "statusNaik": null,
                                    "weightGainStatus": null,
                                    "weightGainMinimumGrams": null,
                                    "exclusiveBreastfeedingStatus": null,
                                    "analysis": null,
                                    "analysisPending": true,
                                })
                            });
                        let current = object.get("data").and_then(Value::as_object).cloned();
                        if let Some(current) = current {
                            let mut data = current;
                            if let Some(values) = derived.as_object() {
                                data.extend(values.clone());
                            }
                            object.insert("data".to_owned(), Value::Object(data));
                        } else {
                            object.extend(derived.as_object().cloned().unwrap_or_default());
                        }
                    }
                }
            }
        }
        let content_range = count.then(|| {
            if documents.is_empty() {
                format!("*/{total}")
            } else {
                let start = offset.unwrap_or(0);
                format!("{}-{}/{total}", start, start + documents.len() as i64 - 1)
            }
        });
        Ok(QueryResult {
            value: Value::Array(documents),
            content_range,
        })
    }

    pub(crate) async fn write(
        &self,
        method: &Method,
        table: &str,
        parameters: &[(String, String)],
        payload: Option<&Value>,
        prefer: Option<&str>,
    ) -> Result<Value, DatabaseError> {
        ensure_table(table)?;
        let representation = prefer.is_some_and(|value| value.contains("return=representation"));
        let resolution =
            if prefer.is_some_and(|value| value.contains("resolution=ignore-duplicates")) {
                ConflictResolution::Ignore
            } else if prefer.is_some_and(|value| value.contains("resolution=merge-duplicates")) {
                ConflictResolution::Merge
            } else {
                ConflictResolution::Error
            };
        let conflict_columns = parameters
            .iter()
            .find(|(key, _)| key == "on_conflict")
            .map(|(_, value)| parse_identifier_list(value))
            .transpose()?
            .unwrap_or_default();

        let mut client = self.pool.get().await.map_err(|error_value| {
            error!(error = %error_value, "pool PostgreSQL native tidak tersedia");
            DatabaseError::Unavailable
        })?;
        let transaction = client.transaction().await.map_err(map_postgres_error)?;
        let mut output = Vec::new();
        match *method {
            Method::POST => {
                let rows = payload_rows(payload)?;
                for row in rows {
                    let (sql, values) = build_insert(table, row, &conflict_columns, resolution)?;
                    let refs = parameter_refs(&values);
                    let statement = transaction.prepare_cached(&sql).await.map_err(|error| {
                        map_postgres_query_error(error, "prepare insert", &sql, values.len())
                    })?;
                    for stored in transaction
                        .query(&statement, &refs)
                        .await
                        .map_err(|error| {
                            map_postgres_query_error(error, "insert", &sql, values.len())
                        })?
                    {
                        output.push(stored.get::<_, Json<Value>>("document").0);
                    }
                }
            }
            Method::PATCH => {
                let row = payload
                    .and_then(Value::as_object)
                    .ok_or(DatabaseError::Invalid)?;
                let (sql, values) = build_update(table, row, parameters)?;
                let refs = parameter_refs(&values);
                let statement = transaction.prepare_cached(&sql).await.map_err(|error| {
                    map_postgres_query_error(error, "prepare update", &sql, values.len())
                })?;
                for stored in transaction
                    .query(&statement, &refs)
                    .await
                    .map_err(|error| {
                        map_postgres_query_error(error, "update", &sql, values.len())
                    })?
                {
                    output.push(stored.get::<_, Json<Value>>("document").0);
                }
            }
            Method::DELETE => {
                let (sql, values) = build_delete(table, parameters)?;
                let refs = parameter_refs(&values);
                let statement = transaction.prepare_cached(&sql).await.map_err(|error| {
                    map_postgres_query_error(error, "prepare delete", &sql, values.len())
                })?;
                for stored in transaction
                    .query(&statement, &refs)
                    .await
                    .map_err(|error| {
                        map_postgres_query_error(error, "delete", &sql, values.len())
                    })?
                {
                    output.push(stored.get::<_, Json<Value>>("document").0);
                }
            }
            _ => return Err(DatabaseError::Invalid),
        }
        transaction.commit().await.map_err(map_postgres_error)?;
        if representation {
            Ok(Value::Array(output))
        } else {
            Ok(Value::Null)
        }
    }

    pub(crate) async fn store_native_password_hash(
        &self,
        user_id: &str,
        password_hash: &str,
    ) -> Result<(), DatabaseError> {
        let user_uuid = parse_user_uuid(user_id)?;
        let mut client = self.pool.get().await.map_err(|error_value| {
            error!(error = %error_value, "pool PostgreSQL native tidak tersedia");
            DatabaseError::Unavailable
        })?;
        let transaction = client.transaction().await.map_err(map_postgres_error)?;
        let credentials_statement = transaction
            .prepare_cached(
                "INSERT INTO public.auth_credentials (
                     user_id, password_hash, password_scheme,
                     password_changed_at, last_password_login_at,
                     created_at, updated_at
                 ) VALUES (
                     $1::uuid, $2, 'argon2id', timezone('utc', now()),
                     timezone('utc', now()), timezone('utc', now()), timezone('utc', now())
                 )
                 ON CONFLICT (user_id) DO UPDATE SET
                     password_hash = excluded.password_hash,
                     password_scheme = excluded.password_scheme,
                     password_changed_at = excluded.password_changed_at,
                     last_password_login_at = excluded.last_password_login_at,
                     updated_at = excluded.updated_at",
            )
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "prepare native credential upsert",
                    "auth_credentials",
                    2,
                )
            })?;
        transaction
            .execute(&credentials_statement, &[&user_uuid, &password_hash])
            .await
            .map_err(|error| {
                map_postgres_query_error(error, "native credential upsert", "auth_credentials", 2)
            })?;
        let migration_statement = transaction
            .prepare_cached(
                "INSERT INTO public.auth_credential_migration_state (
                     user_id, status, supabase_verified_at, native_hashed_at,
                     last_error, created_at, updated_at
                 ) VALUES (
                     $1::uuid, 'migrated', timezone('utc', now()), timezone('utc', now()),
                     NULL, timezone('utc', now()), timezone('utc', now())
                 )
                 ON CONFLICT (user_id) DO UPDATE SET
                     status = 'migrated',
                     supabase_verified_at = timezone('utc', now()),
                     native_hashed_at = timezone('utc', now()),
                     last_error = NULL,
                     updated_at = timezone('utc', now())",
            )
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "prepare native credential migration state upsert",
                    "auth_credential_migration_state",
                    1,
                )
            })?;
        transaction
            .execute(&migration_statement, &[&user_uuid])
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "native credential migration state upsert",
                    "auth_credential_migration_state",
                    1,
                )
            })?;
        transaction.commit().await.map_err(map_postgres_error)?;
        Ok(())
    }

    pub(crate) async fn native_password_hash(
        &self,
        user_id: &str,
    ) -> Result<Option<String>, DatabaseError> {
        let user_uuid = parse_user_uuid(user_id)?;
        let client = self.pool.get().await.map_err(|error_value| {
            error!(error = %error_value, "pool PostgreSQL native tidak tersedia");
            DatabaseError::Unavailable
        })?;
        let statement = client
            .prepare_cached(
                "SELECT password_hash
                 FROM public.auth_credentials
                 WHERE user_id = $1::uuid
                 LIMIT 1",
            )
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "prepare native credential lookup",
                    "auth_credentials",
                    1,
                )
            })?;
        let row = client
            .query_opt(&statement, &[&user_uuid])
            .await
            .map_err(|error| {
                map_postgres_query_error(error, "native credential lookup", "auth_credentials", 1)
            })?;
        Ok(row.map(|value| value.get::<_, String>("password_hash")))
    }

    pub(crate) async fn mark_native_password_login(
        &self,
        user_id: &str,
    ) -> Result<(), DatabaseError> {
        let user_uuid = parse_user_uuid(user_id)?;
        let mut client = self.pool.get().await.map_err(|error_value| {
            error!(error = %error_value, "pool PostgreSQL native tidak tersedia");
            DatabaseError::Unavailable
        })?;
        let transaction = client.transaction().await.map_err(map_postgres_error)?;
        let credentials_statement = transaction
            .prepare_cached(
                "UPDATE public.auth_credentials
                 SET last_password_login_at = timezone('utc', now()),
                     updated_at = timezone('utc', now())
                 WHERE user_id = $1::uuid",
            )
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "prepare native credential login mark",
                    "auth_credentials",
                    1,
                )
            })?;
        transaction
            .execute(&credentials_statement, &[&user_uuid])
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "native credential login mark",
                    "auth_credentials",
                    1,
                )
            })?;
        let migration_statement = transaction
            .prepare_cached(
                "UPDATE public.auth_credential_migration_state
                 SET updated_at = timezone('utc', now()), last_error = NULL
                 WHERE user_id = $1::uuid",
            )
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "prepare native credential migration mark",
                    "auth_credential_migration_state",
                    1,
                )
            })?;
        transaction
            .execute(&migration_statement, &[&user_uuid])
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "native credential migration mark",
                    "auth_credential_migration_state",
                    1,
                )
            })?;
        transaction.commit().await.map_err(map_postgres_error)?;
        Ok(())
    }

    pub(crate) async fn record_admin_security_shadow(
        &self,
        user_id: &str,
        totp_count: i32,
        passkey_count: i32,
    ) -> Result<(), DatabaseError> {
        let user_uuid = parse_user_uuid(user_id)?;
        let client = self.pool.get().await.map_err(|error_value| {
            error!(error = %error_value, "pool PostgreSQL native tidak tersedia");
            DatabaseError::Unavailable
        })?;
        let statement = client
            .prepare_cached(
                "INSERT INTO public.auth_security_migration_state (
                     user_id, mfa_status, passkey_status,
                     supabase_totp_count, supabase_passkey_count,
                     last_synced_at, last_error, created_at, updated_at
                 ) VALUES (
                     $1::uuid,
                     CASE WHEN $2::integer > 0 THEN 'shadowed' ELSE 'pending' END,
                     CASE WHEN $3::integer > 0 THEN 'shadowed' ELSE 'pending' END,
                     $2, $3, timezone('utc', now()), NULL,
                     timezone('utc', now()), timezone('utc', now())
                 )
                 ON CONFLICT (user_id) DO UPDATE SET
                     mfa_status = CASE
                         WHEN auth_security_migration_state.mfa_status = 'migrated' THEN 'migrated'
                         WHEN excluded.supabase_totp_count > 0 THEN 'shadowed'
                         ELSE 'pending'
                     END,
                     passkey_status = CASE
                         WHEN auth_security_migration_state.passkey_status = 'migrated' THEN 'migrated'
                         WHEN excluded.supabase_passkey_count > 0 THEN 'shadowed'
                         ELSE 'pending'
                     END,
                     supabase_totp_count = excluded.supabase_totp_count,
                     supabase_passkey_count = excluded.supabase_passkey_count,
                     last_synced_at = excluded.last_synced_at,
                     last_error = NULL,
                     updated_at = excluded.updated_at",
            )
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "prepare admin security shadow state upsert",
                    "auth_security_migration_state",
                    3,
                )
            })?;
        client
            .execute(&statement, &[&user_uuid, &totp_count, &passkey_count])
            .await
            .map_err(|error| {
                map_postgres_query_error(
                    error,
                    "admin security shadow state upsert",
                    "auth_security_migration_state",
                    3,
                )
            })?;
        Ok(())
    }

    pub(crate) async fn rpc(&self, name: &str, payload: Value) -> Result<Value, DatabaseError> {
        let sql = rpc_sql(name)?;
        let client = self.pool.get().await.map_err(|error_value| {
            error!(error = %error_value, "pool PostgreSQL native tidak tersedia");
            DatabaseError::Unavailable
        })?;
        let statement = client
            .prepare_cached(sql)
            .await
            .map_err(|error| map_postgres_query_error(error, "prepare rpc", sql, 1))?;
        let row = client
            .query_one(&statement, &[&Json(payload)])
            .await
            .map_err(|error| map_postgres_query_error(error, "rpc", sql, 1))?;
        Ok(row.get::<_, Json<Value>>("value").0)
    }

    pub(crate) async fn cleanup_retention(&self) -> Result<Value, DatabaseError> {
        self.rpc("eposyandu_cleanup_retention", json!({})).await
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ConflictResolution {
    Error,
    Ignore,
    Merge,
}

fn ensure_table(table: &str) -> Result<(), DatabaseError> {
    if matches!(
        table,
        "app_users"
            | "audit_events"
            | "background_jobs"
            | "change_log_entries"
            | "change_logs"
            | "children"
            | "measurements"
            | "mpasi_logs"
            | "pmt_monitorings"
            | "pmt_programs"
            | "schema_migrations"
            | "sync_tombstones"
    ) {
        Ok(())
    } else {
        Err(DatabaseError::Invalid)
    }
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn quote_identifier(value: &str) -> Result<String, DatabaseError> {
    if valid_identifier(value) {
        Ok(format!("\"{value}\""))
    } else {
        Err(DatabaseError::Invalid)
    }
}

fn parse_identifier_list(value: &str) -> Result<Vec<String>, DatabaseError> {
    let values = value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if valid_identifier(value) {
                Ok(value.to_owned())
            } else {
                Err(DatabaseError::Invalid)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    if values.is_empty() {
        Err(DatabaseError::Invalid)
    } else {
        Ok(values)
    }
}

fn parameter_refs(values: &[SqlParameter]) -> Vec<&(dyn ToSql + Sync)> {
    values
        .iter()
        .map(|value| value.as_ref() as &(dyn ToSql + Sync))
        .collect()
}

fn push_parameter<T>(values: &mut Vec<SqlParameter>, value: T) -> String
where
    T: ToSql + Sync + Send + 'static,
{
    values.push(Box::new(value));
    format!("${}", values.len())
}

fn numeric_parameter(
    parameters: &[(String, String)],
    name: &str,
) -> Result<Option<i64>, DatabaseError> {
    parameters
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| {
            value
                .parse::<i64>()
                .ok()
                .filter(|value| *value >= 0)
                .ok_or(DatabaseError::Invalid)
        })
        .transpose()
}

fn document_expression(join_children: bool) -> &'static str {
    if join_children {
        "to_jsonb(t) || jsonb_build_object('children', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('name', c.name, 'village', c.village, 'posyandu', c.posyandu) END) AS document"
    } else {
        "to_jsonb(t) AS document"
    }
}

fn build_order(parameters: &[(String, String)]) -> Result<Vec<String>, DatabaseError> {
    let Some((_, configured)) = parameters.iter().find(|(key, _)| key == "order") else {
        return Ok(Vec::new());
    };
    configured
        .split(',')
        .map(|part| {
            let (column, direction) = part.rsplit_once('.').ok_or(DatabaseError::Invalid)?;
            if !matches!(direction, "asc" | "desc") {
                return Err(DatabaseError::Invalid);
            }
            Ok(format!(
                "t.{} {}",
                quote_identifier(column)?,
                direction.to_ascii_uppercase()
            ))
        })
        .collect()
}

fn build_filters(
    parameters: &[(String, String)],
    values: &mut Vec<SqlParameter>,
    table_alias: &str,
    children_joined: bool,
) -> Result<Vec<String>, DatabaseError> {
    let mut filters = Vec::new();
    for (column, configured) in parameters {
        if matches!(
            column.as_str(),
            "select" | "order" | "limit" | "offset" | "on_conflict"
        ) {
            continue;
        }
        let (alias, column) = if let Some(column) = column.strip_prefix("children.") {
            if !children_joined {
                return Err(DatabaseError::Invalid);
            }
            ("c", column)
        } else {
            (table_alias, column.as_str())
        };
        let identifier = quote_identifier(column)?;
        let reference = format!("{alias}.{identifier}");
        let (operator, raw) = configured.split_once('.').ok_or(DatabaseError::Invalid)?;
        if operator == "in" {
            let raw = raw
                .strip_prefix('(')
                .and_then(|value| value.strip_suffix(')'))
                .ok_or(DatabaseError::Invalid)?;
            let options = raw.split(',').map(ToOwned::to_owned).collect::<Vec<_>>();
            if options.is_empty() || options.len() > 100 {
                return Err(DatabaseError::Invalid);
            }
            let placeholder = push_parameter(values, options);
            filters.push(format!("{reference}::text = ANY({placeholder}::text[])"));
            continue;
        }
        let sql_operator = match operator {
            "eq" => "=",
            "gt" => ">",
            "gte" => ">=",
            "lte" => "<=",
            _ => return Err(DatabaseError::Invalid),
        };
        let placeholder = push_parameter(values, raw.to_owned());
        let cast = column_cast(column);
        if cast == "text" {
            filters.push(format!(
                "{reference}::text {sql_operator} {placeholder}::text"
            ));
        } else {
            // Query parameters arrive from the HTTP API as strings. Casting the
            // placeholder to text first keeps the PostgreSQL wire type aligned
            // with String before PostgreSQL converts it to the column type.
            filters.push(format!(
                "{reference} {sql_operator} {placeholder}::text::{cast}"
            ));
        }
    }
    Ok(filters)
}

fn column_cast(column: &str) -> &'static str {
    match column {
        "birth_date" | "measurement_date" | "monitoring_date" => "date",
        "created_at" | "updated_at" | "changed_at" | "deleted_at" => "timestamptz",
        "version" | "week_number" => "bigint",
        _ => "text",
    }
}

fn payload_rows(payload: Option<&Value>) -> Result<Vec<&Map<String, Value>>, DatabaseError> {
    match payload {
        Some(Value::Object(row)) => Ok(vec![row]),
        Some(Value::Array(rows)) if !rows.is_empty() && rows.len() <= 100 => rows
            .iter()
            .map(|row| row.as_object().ok_or(DatabaseError::Invalid))
            .collect(),
        _ => Err(DatabaseError::Invalid),
    }
}

fn build_insert(
    table: &str,
    row: &Map<String, Value>,
    conflict_columns: &[String],
    resolution: ConflictResolution,
) -> Result<(String, Vec<SqlParameter>), DatabaseError> {
    if row.is_empty() {
        return Err(DatabaseError::Invalid);
    }
    let columns = row
        .keys()
        .map(|column| quote_identifier(column))
        .collect::<Result<Vec<_>, _>>()?;
    let mut values = Vec::<SqlParameter>::new();
    let payload = push_parameter(&mut values, Json(Value::Object(row.clone())));
    let table = quote_identifier(table)?;
    let mut sql = format!(
        "INSERT INTO public.{table} AS target ({}) SELECT {} FROM jsonb_populate_record(NULL::public.{table}, {payload}::jsonb) AS source",
        columns.join(", "),
        columns
            .iter()
            .map(|column| format!("source.{column}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    match resolution {
        ConflictResolution::Error => {}
        ConflictResolution::Ignore => {
            if conflict_columns.is_empty() {
                sql.push_str(" ON CONFLICT DO NOTHING");
            } else {
                sql.push_str(&format!(
                    " ON CONFLICT ({}) DO NOTHING",
                    conflict_columns
                        .iter()
                        .map(|column| quote_identifier(column))
                        .collect::<Result<Vec<_>, _>>()?
                        .join(", ")
                ));
            }
        }
        ConflictResolution::Merge => {
            let conflict = conflict_columns
                .iter()
                .map(|column| quote_identifier(column))
                .collect::<Result<Vec<_>, _>>()?;
            let updates = row
                .keys()
                .filter(|column| !conflict_columns.contains(column))
                .map(|column| {
                    let quoted = quote_identifier(column)?;
                    Ok(format!("{quoted} = EXCLUDED.{quoted}"))
                })
                .collect::<Result<Vec<_>, DatabaseError>>()?;
            if conflict.is_empty() || updates.is_empty() {
                return Err(DatabaseError::Invalid);
            }
            sql.push_str(&format!(
                " ON CONFLICT ({}) DO UPDATE SET {}",
                conflict.join(", "),
                updates.join(", ")
            ));
        }
    }
    sql.push_str(" RETURNING to_jsonb(target) AS document");
    Ok((sql, values))
}

fn build_update(
    table: &str,
    row: &Map<String, Value>,
    parameters: &[(String, String)],
) -> Result<(String, Vec<SqlParameter>), DatabaseError> {
    if row.is_empty() {
        return Err(DatabaseError::Invalid);
    }
    let columns = row
        .keys()
        .map(|column| quote_identifier(column))
        .collect::<Result<Vec<_>, _>>()?;
    let mut values = Vec::<SqlParameter>::new();
    let payload = push_parameter(&mut values, Json(Value::Object(row.clone())));
    let filters = build_filters(parameters, &mut values, "target", false)?;
    if filters.is_empty() {
        return Err(DatabaseError::Invalid);
    }
    let table = quote_identifier(table)?;
    let assignments = columns
        .iter()
        .map(|column| format!("{column} = source.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    Ok((
        format!(
            "UPDATE public.{table} AS target SET {assignments} FROM jsonb_populate_record(NULL::public.{table}, {payload}::jsonb) AS source WHERE {} RETURNING to_jsonb(target) AS document",
            filters.join(" AND ")
        ),
        values,
    ))
}

fn build_delete(
    table: &str,
    parameters: &[(String, String)],
) -> Result<(String, Vec<SqlParameter>), DatabaseError> {
    let mut values = Vec::<SqlParameter>::new();
    let filters = build_filters(parameters, &mut values, "target", false)?;
    if filters.is_empty() {
        return Err(DatabaseError::Invalid);
    }
    Ok((
        format!(
            "DELETE FROM public.{} AS target WHERE {} RETURNING to_jsonb(target) AS document",
            quote_identifier(table)?,
            filters.join(" AND ")
        ),
        values,
    ))
}

fn rpc_sql(name: &str) -> Result<&'static str, DatabaseError> {
    match name {
        "eposyandu_dashboard_dataset" => Ok(
            "SELECT public.eposyandu_dashboard_dataset(a.p_month_start, a.p_month_end, a.p_previous_month_start, a.p_previous_month_end, a.p_age_group, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_month_start date, p_month_end date, p_previous_month_start date, p_previous_month_end date, p_age_group text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text)",
        ),
        "eposyandu_dashboard_stats" => Ok(
            "SELECT public.eposyandu_dashboard_stats(a.p_month_start, a.p_month_end, a.p_previous_month_start, a.p_previous_month_end, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_month_start date, p_month_end date, p_previous_month_start date, p_previous_month_end date, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text)",
        ),
        "eposyandu_dashboard_snapshot" => Ok(
            "SELECT public.eposyandu_dashboard_snapshot(a.p_cache_key, a.p_scope_key, a.p_month_start, a.p_month_end, a.p_previous_month_start, a.p_previous_month_end, a.p_age_group, a.p_village, a.p_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_cache_key text, p_scope_key text, p_month_start date, p_month_end date, p_previous_month_start date, p_previous_month_end date, p_age_group text, p_village text, p_posyandu text)",
        ),
        "eposyandu_dashboard_snapshot_latest" => Ok(
            "SELECT public.eposyandu_dashboard_snapshot_latest(a.p_cache_key, a.p_scope_key, a.p_month_start, a.p_month_end, a.p_previous_month_start, a.p_previous_month_end, a.p_age_group, a.p_village, a.p_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_cache_key text, p_scope_key text, p_month_start date, p_month_end date, p_previous_month_start date, p_previous_month_end date, p_age_group text, p_village text, p_posyandu text)",
        ),
        "eposyandu_exclusive_breastfeeding_page" => Ok(
            "SELECT public.eposyandu_exclusive_breastfeeding_page(a.p_measurement_start, a.p_measurement_end, a.p_age_group, a.p_page, a.p_size, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_measurement_start date, p_measurement_end date, p_age_group text, p_page integer, p_size integer, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text)",
        ),
        "eposyandu_problem_children_page" => Ok(
            "SELECT public.eposyandu_problem_children_page(a.p_month_start, a.p_month_end, a.p_problem, a.p_page, a.p_size, a.p_search, a.p_sort, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu, a.p_age_group) AS value FROM jsonb_to_record($1::jsonb) AS a(p_month_start date, p_month_end date, p_problem text, p_page integer, p_size integer, p_search text, p_sort text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text, p_age_group text)",
        ),
        // Rolling-migration fallback for databases before migration 039.
        // Keep the legacy arity under a distinct internal operation name so
        // the age-aware operation can be used whenever the new overload is
        // available without breaking older replicas.
        "eposyandu_problem_children_page_legacy" => Ok(
            "SELECT public.eposyandu_problem_children_page(a.p_month_start, a.p_month_end, a.p_problem, a.p_page, a.p_size, a.p_search, a.p_sort, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_month_start date, p_month_end date, p_problem text, p_page integer, p_size integer, p_search text, p_sort text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text)",
        ),
        "eposyandu_replica_children_page" => Ok(
            "SELECT public.eposyandu_replica_children_page(a.p_as_of, a.p_measurement_start, a.p_measurement_end, a.p_page, a.p_size, a.p_sort, a.p_view, a.p_search, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu, a.p_age_group) AS value FROM jsonb_to_record($1::jsonb) AS a(p_as_of date, p_measurement_start date, p_measurement_end date, p_page integer, p_size integer, p_sort text, p_view text, p_search text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text, p_age_group text)",
        ),
        // Rolling-migration fallback for databases that still expose the
        // original 13-argument replica function (before age cohorts were
        // added). Callers only use this for the default 0-59 cohort.
        "eposyandu_replica_children_page_legacy" => Ok(
            "SELECT public.eposyandu_replica_children_page(a.p_as_of, a.p_measurement_start, a.p_measurement_end, a.p_page, a.p_size, a.p_sort, a.p_view, a.p_search, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_as_of date, p_measurement_start date, p_measurement_end date, p_page integer, p_size integer, p_sort text, p_view text, p_search text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text)",
        ),
        "eposyandu_materialized_children_page" => Ok(
            "SELECT public.eposyandu_materialized_children_page(a.p_as_of, a.p_measurement_start, a.p_measurement_end, a.p_page, a.p_size, a.p_sort, a.p_view, a.p_search, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu, a.p_age_group) AS value FROM jsonb_to_record($1::jsonb) AS a(p_as_of date, p_measurement_start date, p_measurement_end date, p_page integer, p_size integer, p_sort text, p_view text, p_search text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text, p_age_group text)",
        ),
        "eposyandu_materialized_exclusive_breastfeeding_page" => Ok(
            "SELECT public.eposyandu_materialized_exclusive_breastfeeding_page(a.p_measurement_start, a.p_measurement_end, a.p_age_group, a.p_page, a.p_size, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_measurement_start date, p_measurement_end date, p_age_group text, p_page integer, p_size integer, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text)",
        ),
        "eposyandu_change_history_page" => Ok(
            "SELECT public.eposyandu_change_history_page(a.p_as_of, a.p_page, a.p_size, a.p_age_group, a.p_search, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_as_of date, p_page integer, p_size integer, p_age_group text, p_search text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text)",
        ),
        "eposyandu_sigizi_measurement_export" => Ok(
            "SELECT public.eposyandu_sigizi_measurement_export(a.p_month_start, a.p_month_end, a.p_age_group, a.p_village, a.p_posyandu, a.p_role, a.p_scope_village, a.p_scope_posyandu) AS value FROM jsonb_to_record($1::jsonb) AS a(p_month_start date, p_month_end date, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text, p_age_group text)",
        ),
        "eposyandu_cleanup_retention" => Ok(
            "SELECT public.eposyandu_cleanup_retention(coalesce(a.p_now, clock_timestamp())) AS value FROM jsonb_to_record($1::jsonb) AS a(p_now timestamptz)",
        ),
        _ => Err(DatabaseError::Invalid),
    }
}

fn map_postgres_error(error_value: tokio_postgres::Error) -> DatabaseError {
    let kind = match error_value.code() {
        Some(code) if code == &SqlState::UNIQUE_VIOLATION => DatabaseError::Conflict,
        Some(code)
            if matches!(
                *code,
                SqlState::CHECK_VIOLATION
                    | SqlState::FOREIGN_KEY_VIOLATION
                    | SqlState::NOT_NULL_VIOLATION
                    | SqlState::INVALID_TEXT_REPRESENTATION
                    | SqlState::NUMERIC_VALUE_OUT_OF_RANGE
            ) =>
        {
            DatabaseError::Invalid
        }
        _ => DatabaseError::Unavailable,
    };
    error!(error = ?error_value, "query PostgreSQL native gagal");
    kind
}

fn map_postgres_query_error(
    error_value: tokio_postgres::Error,
    operation: &'static str,
    sql: &str,
    parameter_count: usize,
) -> DatabaseError {
    error!(
        error = ?error_value,
        operation,
        parameter_count,
        sql,
        "operasi PostgreSQL native gagal"
    );
    map_postgres_error(error_value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_tables_and_identifiers() {
        assert!(ensure_table("children").is_ok());
        assert!(ensure_table("auth.users").is_err());
        assert!(quote_identifier("updated_at").is_ok());
        assert!(quote_identifier("updated_at desc").is_err());
    }

    #[test]
    fn exposes_python_materialized_read_rpcs() {
        assert!(rpc_sql("eposyandu_materialized_children_page").is_ok());
        assert!(rpc_sql("eposyandu_replica_children_page_legacy").is_ok());
        assert!(rpc_sql("eposyandu_materialized_exclusive_breastfeeding_page").is_ok());
        assert!(rpc_sql("eposyandu_dashboard_snapshot").is_ok());
        assert!(rpc_sql("eposyandu_dashboard_snapshot_latest").is_ok());
    }

    #[test]
    fn validates_native_auth_user_ids_as_uuid_parameters() {
        assert!(parse_user_uuid("00000000-0000-0000-0000-000000000001").is_ok());
        assert!(parse_user_uuid("not-a-uuid").is_err());
    }

    #[test]
    fn builds_typed_timestamp_filter() {
        let mut values = Vec::new();
        let filters = build_filters(
            &[("updated_at".into(), "gt.2026-08-24T00:00:00Z".into())],
            &mut values,
            "t",
            false,
        )
        .expect("valid filter");
        assert_eq!(filters, vec!["t.\"updated_at\" > $1::text::timestamptz"]);
        assert_eq!(values.len(), 1);
    }

    #[test]
    fn exposes_python_dashboard_input_rpc() {
        let sql = rpc_sql("eposyandu_dashboard_dataset").expect("dashboard input RPC");
        assert!(sql.contains("public.eposyandu_dashboard_dataset"));
        assert!(sql.contains("p_previous_month_end"));
    }

    #[tokio::test]
    async fn exercises_native_database_when_enabled() {
        if env::var("ORACLE_DATABASE_INTEGRATION").as_deref() != Ok("1") {
            return;
        }
        let database = NativeDatabase::from_env().expect("native database configuration");
        assert!(database.ready().await);

        let measurement_page = database
            .get(
                "measurements",
                &[
                    ("select".into(), "*,children(name,village,posyandu)".into()),
                    ("order".into(), "created_at.desc".into()),
                    ("limit".into(), "1".into()),
                ],
                true,
            )
            .await
            .expect("measurement page through native database");
        let measurement = measurement_page
            .value
            .as_array()
            .and_then(|rows| rows.first())
            .expect("at least one migrated measurement");
        let measurement_id = measurement["id"].as_str().expect("measurement id");
        let village = measurement["legacy_village"].as_str().expect("village");
        let posyandu = measurement["legacy_posyandu"].as_str().expect("posyandu");
        let measurement_version = measurement["version"]
            .as_i64()
            .expect("measurement version");
        let measurement_updated_at = measurement["updated_at"]
            .as_str()
            .expect("measurement updated timestamp");
        let scoped_measurement = database
            .get(
                "measurements",
                &[
                    ("select".into(), "*,children(name,village,posyandu)".into()),
                    ("id".into(), format!("eq.{measurement_id}")),
                    ("legacy_village".into(), format!("eq.{village}")),
                    ("legacy_posyandu".into(), format!("eq.{posyandu}")),
                    ("version".into(), format!("eq.{measurement_version}")),
                    ("updated_at".into(), format!("eq.{measurement_updated_at}")),
                    ("limit".into(), "1".into()),
                ],
                true,
            )
            .await
            .expect("scoped measurement through native database");
        assert_eq!(scoped_measurement.value.as_array().map(Vec::len), Some(1));
        if env::var("ORACLE_DATABASE_INTEGRATION_READ_ONLY").as_deref() == Ok("1") {
            return;
        }

        let measurement_test_id = format!("native-measurement-test-{}", uuid::Uuid::new_v4());
        let measurement_source = measurement.as_object().expect("measurement row");
        let measurement_payload = json!({
            "id": measurement_test_id,
            "child_id": measurement_source.get("child_id").cloned().unwrap_or(Value::Null),
            "legacy_child_id": measurement_source["legacy_child_id"],
            "legacy_child_name": measurement_source["legacy_child_name"],
            "legacy_village": measurement_source["legacy_village"],
            "legacy_posyandu": measurement_source["legacy_posyandu"],
            "measurement_date": measurement_source.get("measurement_date").cloned().unwrap_or(Value::Null),
            "measurement_date_raw": measurement_source["measurement_date_raw"],
            "weight_kg": measurement_source.get("weight_kg").cloned().unwrap_or(Value::Null),
            "height_cm": measurement_source.get("height_cm").cloned().unwrap_or(Value::Null),
            "head_circumference_cm": measurement_source.get("head_circumference_cm").cloned().unwrap_or(Value::Null),
            "mid_upper_arm_circumference_cm": measurement_source.get("mid_upper_arm_circumference_cm").cloned().unwrap_or(Value::Null),
            "edema": measurement_source["edema"],
            "mother_class_attendance": measurement_source["mother_class_attendance"],
            "mbg": measurement_source["mbg"],
            "vitamin_a": measurement_source["vitamin_a"],
            "exclusive_breastfeeding": measurement_source["exclusive_breastfeeding"],
            "measurement_method": measurement_source["measurement_method"],
            "weight_gain_status": measurement_source["weight_gain_status"],
            "age_in_months": measurement_source.get("age_in_months").cloned().unwrap_or(Value::Null),
        });
        let inserted_measurement = database
            .write(
                &Method::POST,
                "measurements",
                &[("on_conflict".into(), "id".into())],
                Some(&measurement_payload),
                Some("resolution=ignore-duplicates,return=representation"),
            )
            .await
            .expect("measurement insert through native database");
        assert_eq!(inserted_measurement.as_array().map(Vec::len), Some(1));
        let stored_measurement = database
            .get(
                "measurements",
                &[
                    ("select".into(), "*,children(name,village,posyandu)".into()),
                    ("id".into(), format!("eq.{measurement_test_id}")),
                    ("legacy_village".into(), format!("eq.{village}")),
                    ("legacy_posyandu".into(), format!("eq.{posyandu}")),
                    ("limit".into(), "1".into()),
                ],
                false,
            )
            .await
            .expect("measurement reread through native database");
        assert_eq!(stored_measurement.value.as_array().map(Vec::len), Some(1));
        database
            .write(
                &Method::DELETE,
                "sync_tombstones",
                &[
                    ("resource".into(), "eq.measurements".into()),
                    ("document_id".into(), format!("eq.{measurement_test_id}")),
                ],
                None,
                Some("return=minimal"),
            )
            .await
            .expect("measurement tombstone cleanup through native database");
        database
            .write(
                &Method::POST,
                "audit_events",
                &[(
                    "on_conflict".into(),
                    "idempotency_key,action,resource,document_id".into(),
                )],
                Some(&json!({
                    "request_id": measurement_test_id,
                    "idempotency_key": measurement_test_id,
                    "actor_user_id": "native-database-integration",
                    "actor_role": "Ahli Gizi",
                    "action": "create",
                    "resource": "measurements",
                    "document_id": measurement_test_id,
                    "village": village,
                    "posyandu": posyandu,
                    "after_data": { "childId": measurement_source["legacy_child_id"] },
                    "metadata": { "origin": "oracle-native" }
                })),
                Some("resolution=ignore-duplicates,return=minimal"),
            )
            .await
            .expect("measurement audit through native database");
        database
            .write(
                &Method::DELETE,
                "audit_events",
                &[("document_id".into(), format!("eq.{measurement_test_id}"))],
                None,
                Some("return=minimal"),
            )
            .await
            .expect("measurement audit cleanup through native database");
        database
            .write(
                &Method::DELETE,
                "measurements",
                &[("id".into(), format!("eq.{measurement_test_id}"))],
                None,
                Some("return=minimal"),
            )
            .await
            .expect("measurement cleanup through native database");

        let test_id = format!("native-db-test-{}", uuid::Uuid::new_v4());
        let inserted = database
            .write(
                &Method::POST,
                "children",
                &[("on_conflict".into(), "id".into())],
                Some(&json!({
                    "id": test_id,
                    "name": "Uji PostgreSQL Native",
                    "birth_date_raw": "2025-01-01",
                    "sex": "L",
                    "village": "Mayangan",
                    "posyandu": "Pengujian"
                })),
                Some("resolution=ignore-duplicates,return=representation"),
            )
            .await
            .expect("insert through native database");
        assert_eq!(inserted.as_array().map(Vec::len), Some(1));

        let selected = database
            .get(
                "children",
                &[
                    ("select".into(), "*".into()),
                    ("id".into(), format!("eq.{test_id}")),
                    ("limit".into(), "1".into()),
                ],
                true,
            )
            .await
            .expect("select through native database");
        assert_eq!(selected.value.as_array().map(Vec::len), Some(1));
        assert_eq!(selected.content_range.as_deref(), Some("0-0/1"));

        let updated = database
            .write(
                &Method::PATCH,
                "children",
                &[("id".into(), format!("eq.{test_id}"))],
                Some(&json!({ "name": "Uji PostgreSQL Native Diperbarui" })),
                Some("return=representation"),
            )
            .await
            .expect("update through native database");
        assert_eq!(updated[0]["name"], "Uji PostgreSQL Native Diperbarui");

        let expected_version = updated[0]["version"].as_i64().expect("child version");
        let expected_updated_at = updated[0]["updated_at"]
            .as_str()
            .expect("child updated timestamp");
        let guarded_update = database
            .write(
                &Method::PATCH,
                "children",
                &[
                    ("id".into(), format!("eq.{test_id}")),
                    ("version".into(), format!("eq.{expected_version}")),
                    ("updated_at".into(), format!("eq.{expected_updated_at}")),
                ],
                Some(&json!({ "name": "Uji PostgreSQL Native Terkunci" })),
                Some("return=representation"),
            )
            .await
            .expect("guarded update through native database");
        assert_eq!(guarded_update[0]["name"], "Uji PostgreSQL Native Terkunci");

        let dashboard = database
            .rpc(
                "eposyandu_dashboard_stats",
                json!({
                    "p_month_start": "2026-08-01",
                    "p_month_end": "2026-08-31",
                    "p_previous_month_start": "2026-07-01",
                    "p_previous_month_end": "2026-07-31",
                    "p_village": null,
                    "p_posyandu": null,
                    "p_role": "Ahli Gizi",
                    "p_scope_village": null,
                    "p_scope_posyandu": null
                }),
            )
            .await
            .expect("RPC through native database");
        assert!(dashboard.is_object());

        let deleted = database
            .write(
                &Method::DELETE,
                "children",
                &[("id".into(), format!("eq.{test_id}"))],
                None,
                Some("return=representation"),
            )
            .await
            .expect("delete through native database");
        assert_eq!(deleted.as_array().map(Vec::len), Some(1));
    }
}
