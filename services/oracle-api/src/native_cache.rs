use std::{
    env,
    time::{SystemTime, UNIX_EPOCH},
};

use redis::{AsyncCommands, aio::ConnectionManager};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::warn;

pub(crate) const DYNAMIC_CACHE_TTL_SECONDS: u64 = 5 * 60;
pub(crate) const DASHBOARD_CACHE_TTL_SECONDS: u64 = 60;
const DYNAMIC_CACHE_VERSION_KEY: &str = "e-posyandu:dynamic:version:v1";
const DYNAMIC_CACHE_KEY_PREFIX: &str = "e-posyandu:cache:v2";

#[derive(Clone)]
pub(crate) struct NativeCache {
    connection: ConnectionManager,
}

impl NativeCache {
    pub(crate) async fn from_env() -> Result<Option<Self>, String> {
        let Some(url) = env::var("ORACLE_REDIS_URL")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };
        let client = redis::Client::open(url)
            .map_err(|_| "ORACLE_REDIS_URL bukan URL Redis valid.".to_string())?;
        let connection = ConnectionManager::new(client)
            .await
            .map_err(|_| "Redis cache Oracle tidak dapat dihubungi.".to_string())?;
        Ok(Some(Self { connection }))
    }

    pub(crate) async fn ready(&self) -> bool {
        let mut connection = self.connection.clone();
        redis::cmd("PING")
            .query_async::<String>(&mut connection)
            .await
            .is_ok_and(|value| value == "PONG")
    }

    pub(crate) async fn request_key(
        &self,
        role: &str,
        village: Option<&str>,
        posyandu: Option<&str>,
        request_target: &str,
    ) -> Option<String> {
        let version = self.version().await?;
        Some(dynamic_cache_key(
            role,
            village,
            posyandu,
            request_target,
            version,
        ))
    }

    pub(crate) async fn get(&self, key: &str) -> Option<Value> {
        let mut connection = self.connection.clone();
        let payload = connection.get::<_, Option<String>>(key).await.ok()??;
        serde_json::from_str(&payload).ok()
    }

    pub(crate) async fn put(&self, key: &str, value: &Value, ttl_seconds: u64) {
        let Ok(payload) = serde_json::to_string(value) else {
            return;
        };
        let mut connection = self.connection.clone();
        if let Err(error_value) = connection
            .set_ex::<_, _, ()>(key, payload, ttl_seconds)
            .await
        {
            warn!(error = %error_value, "Redis tidak dapat menyimpan cache data dinamis");
        }
    }

    pub(crate) async fn invalidate(&self) {
        let mut connection = self.connection.clone();
        if let Err(error_value) = connection
            .incr::<_, _, i64>(DYNAMIC_CACHE_VERSION_KEY, 1)
            .await
        {
            warn!(error = %error_value, "versi cache data dinamis Redis tidak dapat dinaikkan");
        }
    }

    async fn version(&self) -> Option<i64> {
        let mut connection = self.connection.clone();
        match connection
            .get::<_, Option<i64>>(DYNAMIC_CACHE_VERSION_KEY)
            .await
        {
            Ok(Some(version)) => Some(version),
            Ok(None) => {
                let seed: i64 = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_millis()
                    .try_into()
                    .ok()?;
                let initialized: redis::RedisResult<bool> =
                    connection.set_nx(DYNAMIC_CACHE_VERSION_KEY, seed).await;
                if initialized.is_err() {
                    return None;
                }
                connection
                    .get::<_, Option<i64>>(DYNAMIC_CACHE_VERSION_KEY)
                    .await
                    .ok()?
            }
            Err(error_value) => {
                warn!(error = %error_value, "versi cache data dinamis Redis tidak dapat dibaca");
                None
            }
        }
    }
}

fn dynamic_cache_key(
    role: &str,
    village: Option<&str>,
    posyandu: Option<&str>,
    request_target: &str,
    version: i64,
) -> String {
    // Keep the key human-auditable at the category/version level while
    // hashing scope and query values so names, NIKs, and addresses never
    // become Redis key material.  A new prefix also makes old v1 entries
    // naturally unreachable without requiring a production-wide FLUSHDB.
    let scope_hash = digest_components([
        role,
        village.unwrap_or_default(),
        posyandu.unwrap_or_default(),
    ]);
    let query_hash = digest_components([request_target]);
    let target_label = cache_target_label(request_target);
    format!(
        "{DYNAMIC_CACHE_KEY_PREFIX}:{}:version:{version}:scope:{scope_hash}:query:{query_hash}",
        target_label,
    )
}

fn digest_components<const N: usize>(components: [&str; N]) -> String {
    let mut digest = Sha256::new();
    for component in components {
        digest.update(component.as_bytes());
        digest.update([0]);
    }
    hex::encode(digest.finalize())
}

fn cache_target_label(request_target: &str) -> String {
    let path = request_target
        .split(['?', '|'])
        .next()
        .unwrap_or(request_target);
    match path {
        "/api/v1/dashboard/stats" => "dashboard-stats".to_owned(),
        "/api/v1/children/page" => "children-page".to_owned(),
        "/api/v1/exclusive-breastfeeding/page" => "exclusive-breastfeeding-page".to_owned(),
        _ if path.starts_with("/api/v1/collections/") => {
            let table = path
                .strip_prefix("/api/v1/collections/")
                .and_then(|value| value.split('/').next())
                .unwrap_or("unknown");
            let mut safe = table
                .chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
                })
                .take(32)
                .collect::<String>();
            if safe.is_empty() {
                safe.push_str("unknown");
            }
            format!("collection-{safe}")
        }
        _ => "dynamic".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_dynamic_cache_by_scope_query_and_version() {
        let base = dynamic_cache_key(
            "Kader Posyandu",
            Some("Purwoasri"),
            Some("SALAK 58"),
            "/api/v1/collections/measurements?filter=childId%7C%3D%3D%7C123",
            4,
        );
        assert_ne!(
            base,
            dynamic_cache_key(
                "Kader Posyandu",
                Some("Purwoasri"),
                Some("MELATI 01"),
                "/api/v1/collections/measurements?filter=childId%7C%3D%3D%7C123",
                4,
            )
        );
        assert_ne!(
            base,
            dynamic_cache_key(
                "Kader Posyandu",
                Some("Purwoasri"),
                Some("SALAK 58"),
                "/api/v1/collections/measurements?filter=childId%7C%3D%3D%7C456",
                4,
            )
        );
        assert_ne!(
            base,
            dynamic_cache_key(
                "Kader Posyandu",
                Some("Purwoasri"),
                Some("SALAK 58"),
                "/api/v1/collections/measurements?filter=childId%7C%3D%3D%7C123",
                5,
            )
        );
    }

    #[test]
    fn dynamic_cache_ttl_uses_five_minutes_with_dashboard_exception() {
        assert_eq!(DYNAMIC_CACHE_TTL_SECONDS, 300);
        assert_eq!(DASHBOARD_CACHE_TTL_SECONDS, 60);
    }

    #[test]
    fn cache_key_has_readable_versioned_namespace_without_raw_scope() {
        let key = dynamic_cache_key(
            "Kader Posyandu",
            Some("Desa Rahasia"),
            Some("SALAK 01"),
            "/api/v1/children/page?ageGroup=0-59",
            187,
        );
        assert!(key.starts_with("e-posyandu:cache:v2:children-page:version:187:"));
        assert!(key.contains(":scope:"));
        assert!(key.contains(":query:"));
        assert!(!key.contains("Desa Rahasia"));
        assert!(!key.contains("SALAK 01"));
        assert_eq!(
            cache_target_label("/api/v1/dashboard/stats"),
            "dashboard-stats"
        );
        assert_eq!(
            cache_target_label("/api/v1/collections/measurements"),
            "collection-measurements"
        );
    }
}
