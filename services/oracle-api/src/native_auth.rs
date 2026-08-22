use std::{
    collections::HashSet,
    env, fs,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    body::to_bytes,
    extract::Request,
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose};
use rand::{RngCore, rngs::OsRng};
use reqwest::{Client, Url};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tracing::{error, warn};

const SESSION_COOKIE: &str = "__Host-e-posyandu-session";
const DEVELOPMENT_SESSION_COOKIE: &str = "e-posyandu-session";
const SESSION_TTL_SECONDS: i64 = 8 * 60 * 60;
const SESSION_REFRESH_WINDOW_SECONDS: i64 = 90;
const LOGIN_BODY_MAX_BYTES: usize = 16 * 1024;
const LOGIN_IP_WINDOW_SECONDS: i64 = 600;
const LOGIN_ACCOUNT_WINDOW_SECONDS: i64 = 600;
const LOGIN_PAIR_WINDOW_SECONDS: i64 = 60;
const LOGIN_IP_MAX_ATTEMPTS: i64 = 30;
const LOGIN_ACCOUNT_MAX_ATTEMPTS: i64 = 10;
const LOGIN_PAIR_MAX_ATTEMPTS: i64 = 5;
const TURNSTILE_VERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ORACLE_ORIGIN_HEADER: &str = "x-e-posyandu-origin";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccessScope {
    pub(crate) user_id: String,
    pub(crate) email: Option<String>,
    pub(crate) role: String,
    pub(crate) desa: Option<String>,
    pub(crate) posyandu: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AuthorizedSession {
    pub(crate) access_token: String,
    pub(crate) scope: AccessScope,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SupabaseUser {
    id: String,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SupabaseSession {
    access_token: String,
    refresh_token: String,
    user: SupabaseUser,
}

#[derive(Clone, Debug, Deserialize)]
struct LoginAccount {
    user_id: String,
    email: Option<String>,
    role: String,
    village: Option<String>,
    posyandu: Option<String>,
    active: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct AppUser {
    role: String,
    village: Option<String>,
    posyandu: Option<String>,
    active: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct BrowserSession {
    access_token: String,
    refresh_token: String,
    user: SupabaseUser,
    profile: AccessScope,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    username: Option<String>,
    password: Option<String>,
    turnstile_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TurnstileResult {
    success: bool,
    hostname: Option<String>,
}

#[derive(Debug)]
struct NativeError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl NativeError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Sesi masuk diperlukan.",
        )
    }

    fn into_response(self) -> Response {
        response_json(
            self.status,
            json!({ "error": { "code": self.code, "message": self.message } }),
        )
    }
}

#[derive(Clone)]
struct SupabaseClient {
    http: Client,
    base_url: Url,
    publishable_key: String,
    secret_key: String,
}

struct SessionStore {
    connection: Mutex<Connection>,
    encryption_key: [u8; 32],
}

pub(crate) struct NativeAuth {
    supabase: SupabaseClient,
    sessions: SessionStore,
    turnstile_secret: String,
    turnstile_hostnames: HashSet<String>,
    allowed_origins: HashSet<String>,
    development: bool,
    local_turnstile_bypass: bool,
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} wajib diisi untuk API native Oracle."))
}

fn env_flag(name: &str, fallback: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(fallback)
}

fn csv_origin_set(name: &str) -> HashSet<String> {
    env::var(name)
        .unwrap_or_default()
        .split(',')
        .filter_map(normalize_origin)
        .collect()
}

fn csv_hostname_set(name: &str) -> HashSet<String> {
    env::var(name)
        .unwrap_or_default()
        .split(',')
        .filter_map(normalize_hostname)
        .collect()
}

fn normalize_hostname(value: &str) -> Option<String> {
    let candidate = value.trim().to_ascii_lowercase();
    if candidate.is_empty() {
        return None;
    }
    let parsed = Url::parse(&format!("https://{candidate}")).ok()?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "" && parsed.path() != "/")
    {
        return None;
    }
    parsed.host_str().map(str::to_ascii_lowercase)
}

fn normalize_origin(value: &str) -> Option<String> {
    let parsed = Url::parse(value.trim()).ok()?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "" && parsed.path() != "/")
    {
        return None;
    }

    let host = parsed.host_str()?.to_ascii_lowercase();
    let port = parsed
        .port()
        .filter(|port| !((*port == 80 && scheme == "http") || (*port == 443 && scheme == "https")));
    let authority = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    Some(match port {
        Some(port) => format!("{scheme}://{authority}:{port}"),
        None => format!("{scheme}://{authority}"),
    })
}

fn decode_session_key(value: &str) -> Result<[u8; 32], String> {
    let value = value.trim();
    let decoded = if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        hex::decode(value).map_err(|_| "ORACLE_API_SESSION_KEY tidak valid.".to_string())?
    } else {
        general_purpose::STANDARD
            .decode(value)
            .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(value))
            .or_else(|_| general_purpose::URL_SAFE_NO_PAD.decode(value))
            .map_err(|_| "ORACLE_API_SESSION_KEY harus berupa base64 atau hex.".to_string())?
    };
    decoded.try_into().map_err(|_| {
        "ORACLE_API_SESSION_KEY wajib berisi tepat 32 byte untuk AES-256-GCM.".to_string()
    })
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn response_json(status: StatusCode, payload: Value) -> Response {
    let mut response = (
        status,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        axum::Json(payload),
    )
        .into_response();
    response.headers_mut().insert(
        HeaderName::from_static(ORACLE_ORIGIN_HEADER),
        HeaderValue::from_static("oracle-native"),
    );
    response
}

fn normalized_username(input: Option<&str>) -> Result<String, NativeError> {
    let username = input.unwrap_or_default().trim().to_ascii_lowercase();
    let valid = username.len() >= 3
        && username.len() <= 32
        && username.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || (index > 0 && matches!(character, '.' | '_' | '-'))
        });
    if valid {
        Ok(username)
    } else {
        Err(NativeError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Username atau kata sandi tidak benar.",
        ))
    }
}

fn request_id(request: &Request) -> String {
    request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty() && value.len() <= 128)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("req-{}-{}", unix_seconds(), random_identifier(8)))
}

fn remote_ip(request: &Request) -> String {
    request
        .headers()
        .get("cf-connecting-ip")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            request
                .headers()
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
        })
        .map(str::trim)
        .and_then(|value| value.parse::<IpAddr>().ok())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

fn random_identifier(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    general_purpose::URL_SAFE_NO_PAD.encode(value)
}

fn jwt_expiration_seconds(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let decoded = general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice::<Value>(&decoded)
        .ok()?
        .get("exp")?
        .as_i64()
}

impl SessionStore {
    fn open(path: &Path, encryption_key: [u8; 32]) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Direktori sesi Oracle tidak dapat dibuat: {error}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            }
        }
        let connection = Connection::open(path)
            .map_err(|error| format!("Database sesi Oracle tidak dapat dibuka: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Timeout database sesi tidak dapat diatur: {error}"))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=FULL;
                 PRAGMA foreign_keys=ON;
                 CREATE TABLE IF NOT EXISTS browser_sessions (
                    identifier_hash TEXT PRIMARY KEY,
                    encrypted_payload TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS browser_sessions_expires_idx
                    ON browser_sessions(expires_at);
                 CREATE TABLE IF NOT EXISTS login_attempts (
                    attempt_key TEXT PRIMARY KEY,
                    attempt_count INTEGER NOT NULL,
                    reset_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS login_attempts_reset_idx
                    ON login_attempts(reset_at);",
            )
            .map_err(|error| format!("Skema database sesi tidak dapat dibuat: {error}"))?;
        Ok(Self {
            connection: Mutex::new(connection),
            encryption_key,
        })
    }

    fn encrypt(&self, session: &BrowserSession) -> Result<String, NativeError> {
        let plaintext = serde_json::to_vec(session).map_err(|_| {
            NativeError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "session_error",
                "Sesi aman tidak dapat disimpan.",
            )
        })?;
        let cipher = Aes256Gcm::new_from_slice(&self.encryption_key).map_err(|_| {
            NativeError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "session_error",
                "Konfigurasi enkripsi sesi tidak valid.",
            )
        })?;
        let mut nonce_bytes = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
            .map_err(|_| {
                NativeError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "session_error",
                    "Sesi aman tidak dapat disimpan.",
                )
            })?;
        let mut encoded = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
        encoded.extend_from_slice(&nonce_bytes);
        encoded.extend_from_slice(&ciphertext);
        Ok(general_purpose::STANDARD.encode(encoded))
    }

    fn decrypt(&self, encrypted: &str) -> Result<BrowserSession, NativeError> {
        let encoded = general_purpose::STANDARD.decode(encrypted).map_err(|_| {
            NativeError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_session",
                "Sesi masuk tidak lagi valid.",
            )
        })?;
        if encoded.len() <= 12 {
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_session",
                "Sesi masuk tidak lagi valid.",
            ));
        }
        let (nonce, ciphertext) = encoded.split_at(12);
        let cipher = Aes256Gcm::new_from_slice(&self.encryption_key).map_err(|_| {
            NativeError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "session_error",
                "Konfigurasi enkripsi sesi tidak valid.",
            )
        })?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|_| {
                NativeError::new(
                    StatusCode::UNAUTHORIZED,
                    "invalid_session",
                    "Sesi masuk tidak lagi valid.",
                )
            })?;
        serde_json::from_slice(&plaintext).map_err(|_| {
            NativeError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_session",
                "Sesi masuk tidak lagi valid.",
            )
        })
    }

    fn put(&self, identifier: &str, session: &BrowserSession) -> Result<(), NativeError> {
        let encrypted = self.encrypt(session)?;
        let now = unix_seconds();
        let connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "session_unavailable",
                "Penyimpanan sesi aman belum tersedia.",
            )
        })?;
        connection
            .execute(
                "INSERT INTO browser_sessions(identifier_hash, encrypted_payload, expires_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(identifier_hash) DO UPDATE SET
                    encrypted_payload=excluded.encrypted_payload,
                    expires_at=excluded.expires_at,
                    updated_at=excluded.updated_at",
                params![
                    sha256_hex(identifier),
                    encrypted,
                    now + SESSION_TTL_SECONDS,
                    now
                ],
            )
            .map_err(|error| {
                error!(%error, "sesi terenkripsi tidak dapat disimpan");
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "session_unavailable",
                    "Sesi aman tidak dapat disimpan.",
                )
            })?;
        Ok(())
    }

    fn get(&self, identifier: &str) -> Result<Option<BrowserSession>, NativeError> {
        let now = unix_seconds();
        let identifier_hash = sha256_hex(identifier);
        let connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "session_unavailable",
                "Penyimpanan sesi aman belum tersedia.",
            )
        })?;
        let row: Option<(String, i64)> = connection
            .query_row(
                "SELECT encrypted_payload, expires_at FROM browser_sessions WHERE identifier_hash=?1",
                params![identifier_hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| {
                error!(%error, "sesi terenkripsi tidak dapat dibaca");
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "session_unavailable",
                    "Penyimpanan sesi aman belum tersedia.",
                )
            })?;
        let Some((encrypted, expires_at)) = row else {
            return Ok(None);
        };
        if expires_at <= now {
            let _ = connection.execute(
                "DELETE FROM browser_sessions WHERE identifier_hash=?1",
                params![sha256_hex(identifier)],
            );
            return Ok(None);
        }
        drop(connection);
        self.decrypt(&encrypted).map(Some)
    }

    fn delete(&self, identifier: &str) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let _ = connection.execute(
            "DELETE FROM browser_sessions WHERE identifier_hash=?1",
            params![sha256_hex(identifier)],
        );
    }

    fn consume_attempt(
        &self,
        attempt_key: &str,
        maximum: i64,
        window_seconds: i64,
    ) -> Result<bool, NativeError> {
        let now = unix_seconds();
        let key = sha256_hex(attempt_key);
        let mut connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "rate_limit_unavailable",
                "Perlindungan masuk belum tersedia.",
            )
        })?;
        let transaction = connection.transaction().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "rate_limit_unavailable",
                "Perlindungan masuk belum tersedia.",
            )
        })?;
        let current: Option<(i64, i64)> = transaction
            .query_row(
                "SELECT attempt_count, reset_at FROM login_attempts WHERE attempt_key=?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "rate_limit_unavailable",
                    "Perlindungan masuk belum tersedia.",
                )
            })?;
        let allowed =
            !matches!(current, Some((count, reset_at)) if reset_at > now && count >= maximum);
        if allowed {
            match current {
                Some((count, reset_at)) if reset_at > now => {
                    transaction
                        .execute(
                            "UPDATE login_attempts SET attempt_count=?2 WHERE attempt_key=?1",
                            params![key, count + 1],
                        )
                        .map_err(|_| {
                            NativeError::new(
                                StatusCode::SERVICE_UNAVAILABLE,
                                "rate_limit_unavailable",
                                "Perlindungan masuk belum tersedia.",
                            )
                        })?;
                }
                _ => {
                    transaction
                        .execute(
                            "INSERT INTO login_attempts(attempt_key, attempt_count, reset_at)
                             VALUES (?1, 1, ?2)
                             ON CONFLICT(attempt_key) DO UPDATE SET attempt_count=1, reset_at=excluded.reset_at",
                            params![key, now + window_seconds],
                        )
                        .map_err(|_| {
                            NativeError::new(
                                StatusCode::SERVICE_UNAVAILABLE,
                                "rate_limit_unavailable",
                                "Perlindungan masuk belum tersedia.",
                            )
                        })?;
                }
            }
        }
        transaction.commit().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "rate_limit_unavailable",
                "Perlindungan masuk belum tersedia.",
            )
        })?;
        Ok(allowed)
    }

    fn clear_attempts(&self, keys: &[String]) {
        let Ok(mut connection) = self.connection.lock() else {
            return;
        };
        let Ok(transaction) = connection.transaction() else {
            return;
        };
        for key in keys {
            let _ = transaction.execute(
                "DELETE FROM login_attempts WHERE attempt_key=?1",
                params![sha256_hex(key)],
            );
        }
        let _ = transaction.commit();
    }

    fn cleanup(&self) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let now = unix_seconds();
        let _ = connection.execute(
            "DELETE FROM browser_sessions WHERE expires_at <= ?1",
            params![now],
        );
        let _ = connection.execute(
            "DELETE FROM login_attempts WHERE reset_at <= ?1",
            params![now],
        );
    }
}

impl SupabaseClient {
    fn url(&self, path: &str) -> Result<Url, NativeError> {
        self.base_url.join(path).map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "upstream_unavailable",
                "Konfigurasi layanan akun tidak valid.",
            )
        })
    }

    async fn response_json<T: DeserializeOwned>(
        response: reqwest::Response,
        message: &'static str,
    ) -> Result<T, NativeError> {
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "upstream_unavailable",
                message,
            )
        })?;
        if !status.is_success() {
            return Err(NativeError::new(
                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    StatusCode::TOO_MANY_REQUESTS
                } else if status == reqwest::StatusCode::UNAUTHORIZED
                    || status == reqwest::StatusCode::BAD_REQUEST
                {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    "rate_limited"
                } else if status == reqwest::StatusCode::UNAUTHORIZED
                    || status == reqwest::StatusCode::BAD_REQUEST
                {
                    "unauthorized"
                } else {
                    "upstream_unavailable"
                },
                message,
            ));
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_upstream_response",
                "Respons layanan akun tidak dapat dibaca.",
            )
        })
    }

    fn service_request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .header("apikey", &self.secret_key)
            .bearer_auth(&self.secret_key)
            .header(header::ACCEPT, "application/json")
    }

    fn public_request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .header("apikey", &self.publishable_key)
            .bearer_auth(&self.publishable_key)
            .header(header::ACCEPT, "application/json")
    }

    async fn login_account(&self, username: &str) -> Result<Option<LoginAccount>, NativeError> {
        let mut url = self.url("rest/v1/app_users")?;
        url.query_pairs_mut()
            .append_pair("select", "user_id,email,role,village,posyandu,active")
            .append_pair("username", &format!("eq.{username}"))
            .append_pair("limit", "1");
        let response = self
            .service_request(Method::GET, url)
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Layanan akun belum tersedia.",
                )
            })?;
        let accounts: Vec<LoginAccount> =
            Self::response_json(response, "Layanan akun belum tersedia.").await?;
        Ok(accounts.into_iter().next())
    }

    async fn password_login(
        &self,
        email: &str,
        password: &str,
    ) -> Result<SupabaseSession, NativeError> {
        let mut url = self.url("auth/v1/token")?;
        url.query_pairs_mut().append_pair("grant_type", "password");
        let response = self
            .public_request(Method::POST, url)
            .json(&json!({ "email": email, "password": password }))
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Layanan autentikasi belum tersedia.",
                )
            })?;
        Self::response_json(response, "Username atau kata sandi tidak benar.").await
    }

    async fn refresh(&self, refresh_token: &str) -> Result<SupabaseSession, NativeError> {
        let mut url = self.url("auth/v1/token")?;
        url.query_pairs_mut()
            .append_pair("grant_type", "refresh_token");
        let response = self
            .public_request(Method::POST, url)
            .json(&json!({ "refresh_token": refresh_token }))
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Layanan autentikasi belum tersedia.",
                )
            })?;
        Self::response_json(response, "Sesi masuk tidak lagi valid.").await
    }

    async fn logout(&self, access_token: &str) {
        let Ok(url) = self.url("auth/v1/logout") else {
            return;
        };
        let _ = self
            .http
            .post(url)
            .header("apikey", &self.publishable_key)
            .bearer_auth(access_token)
            .send()
            .await;
    }

    async fn verify_bearer(&self, access_token: &str) -> Result<AccessScope, NativeError> {
        let url = self.url("auth/v1/user")?;
        let response = self
            .http
            .get(url)
            .header("apikey", &self.publishable_key)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Layanan autentikasi belum tersedia.",
                )
            })?;
        let identity: SupabaseUser =
            Self::response_json(response, "Sesi masuk tidak lagi valid.").await?;

        let mut profile_url = self.url("rest/v1/app_users")?;
        profile_url
            .query_pairs_mut()
            .append_pair("select", "role,village,posyandu,active")
            .append_pair("user_id", &format!("eq.{}", identity.id))
            .append_pair("limit", "1");
        let response = self
            .service_request(Method::GET, profile_url)
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Layanan profil akun belum tersedia.",
                )
            })?;
        let profiles: Vec<AppUser> =
            Self::response_json(response, "Layanan profil akun belum tersedia.").await?;
        let profile = profiles
            .into_iter()
            .next()
            .filter(|value| value.active)
            .ok_or_else(|| {
                NativeError::new(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "Akun ini belum diberi akses aplikasi.",
                )
            })?;
        validate_profile(
            identity.id,
            identity.email,
            profile.role,
            profile.village,
            profile.posyandu,
        )
    }

    async fn audit_login(
        &self,
        request_id: &str,
        username: &str,
        account: Option<&LoginAccount>,
        action: &str,
        outcome: &str,
    ) {
        let Ok(url) = self
            .url("rest/v1/audit_events?on_conflict=idempotency_key,action,resource,document_id")
        else {
            return;
        };
        let account_key = sha256_hex(&format!("account:{username}"));
        let response = self
            .service_request(Method::POST, url)
            .header("Prefer", "resolution=ignore-duplicates,return=minimal")
            .json(&json!({
                "request_id": request_id,
                "idempotency_key": Value::Null,
                "actor_user_id": account.map(|value| value.user_id.as_str()).unwrap_or("anonymous"),
                "actor_role": account.map(|value| value.role.as_str()).unwrap_or("anonymous"),
                "action": action,
                "resource": "authentication",
                "document_id": account_key,
                "village": account.and_then(|value| value.village.as_deref()),
                "posyandu": account.and_then(|value| value.posyandu.as_deref()),
                "before_data": Value::Null,
                "after_data": Value::Null,
                "metadata": { "outcome": outcome, "origin": "oracle-native" }
            }))
            .send()
            .await;
        if !response.is_ok_and(|value| value.status().is_success()) {
            warn!(%request_id, %action, "audit autentikasi native gagal ditulis");
        }
    }
}

fn validate_profile(
    user_id: String,
    email: Option<String>,
    role: String,
    desa: Option<String>,
    posyandu: Option<String>,
) -> Result<AccessScope, NativeError> {
    if !matches!(role.as_str(), "Kader Posyandu" | "Bidan Desa" | "Ahli Gizi") {
        return Err(NativeError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Peran akun tidak valid.",
        ));
    }
    if role == "Kader Posyandu" && (desa.is_none() || posyandu.is_none()) {
        return Err(NativeError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Wilayah kader belum lengkap.",
        ));
    }
    if role == "Bidan Desa" && desa.is_none() {
        return Err(NativeError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Wilayah bidan belum lengkap.",
        ));
    }
    Ok(AccessScope {
        user_id,
        email,
        role,
        desa,
        posyandu,
    })
}

impl NativeAuth {
    pub(crate) fn from_env(http: Client) -> Result<Option<Self>, String> {
        if !env_flag("ORACLE_API_NATIVE_AUTH_ENABLED", false) {
            return Ok(None);
        }

        let configured_url = required_env("SUPABASE_URL")?;
        let mut base_url =
            Url::parse(&configured_url).map_err(|_| "SUPABASE_URL bukan URL valid.".to_string())?;
        if base_url.scheme() != "https"
            || base_url.username() != ""
            || base_url.password().is_some()
            || base_url.query().is_some()
        {
            return Err("SUPABASE_URL wajib berupa origin HTTPS tanpa kredensial/query.".into());
        }
        base_url.set_path("/");
        base_url.set_fragment(None);

        let environment = env::var("ORACLE_API_ENVIRONMENT")
            .unwrap_or_else(|_| "production".into())
            .trim()
            .to_ascii_lowercase();
        let development = environment == "development";
        let local_turnstile_bypass = env_flag("ORACLE_API_LOCAL_TURNSTILE_BYPASS", false);
        if local_turnstile_bypass && !development {
            return Err(
                "ORACLE_API_LOCAL_TURNSTILE_BYPASS hanya boleh aktif di development.".into(),
            );
        }

        let turnstile_hostnames = csv_hostname_set("TURNSTILE_HOSTNAMES");
        if !development && turnstile_hostnames.is_empty() {
            return Err("TURNSTILE_HOSTNAMES wajib diisi pada production.".into());
        }
        let allowed_origins = csv_origin_set("CORS_ORIGINS");
        if !development && allowed_origins.is_empty() {
            return Err("CORS_ORIGINS wajib diisi pada production.".into());
        }

        let path = env::var("ORACLE_API_SESSION_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/var/lib/e-posyandu-api/sessions.sqlite"));
        let session_key = decode_session_key(&required_env("ORACLE_API_SESSION_KEY")?)?;
        let sessions = SessionStore::open(&path, session_key)?;
        sessions.cleanup();

        Ok(Some(Self {
            supabase: SupabaseClient {
                http,
                base_url,
                publishable_key: required_env("SUPABASE_PUBLISHABLE_KEY")?,
                secret_key: required_env("SUPABASE_SECRET_KEY")?,
            },
            sessions,
            turnstile_secret: required_env("TURNSTILE_SECRET_KEY")?,
            turnstile_hostnames,
            allowed_origins,
            development,
            local_turnstile_bypass,
        }))
    }

    pub(crate) fn configured(&self) -> bool {
        true
    }

    fn cookie_name(&self) -> &'static str {
        if self.development {
            DEVELOPMENT_SESSION_COOKIE
        } else {
            SESSION_COOKIE
        }
    }

    fn set_cookie(&self, identifier: &str) -> String {
        if self.development {
            format!(
                "{}={identifier}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}",
                self.cookie_name()
            )
        } else {
            format!(
                "{}={identifier}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={SESSION_TTL_SECONDS}",
                self.cookie_name()
            )
        }
    }

    fn clear_cookie(&self) -> String {
        if self.development {
            format!(
                "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
                self.cookie_name()
            )
        } else {
            format!(
                "{}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
                self.cookie_name()
            )
        }
    }

    fn cookie_identifier(&self, headers: &HeaderMap) -> Option<String> {
        headers
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())?
            .split(';')
            .filter_map(|part| part.trim().split_once('='))
            .find_map(|(name, value)| {
                (name == self.cookie_name()
                    && (32..=128).contains(&value.len())
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
                .then(|| value.to_owned())
            })
    }

    fn validate_origin(&self, request: &Request) -> Result<(), NativeError> {
        self.validate_origin_headers(request.headers(), false)
    }

    fn validate_origin_headers(
        &self,
        headers: &HeaderMap,
        required: bool,
    ) -> Result<(), NativeError> {
        let Some(origin) = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        else {
            return if required && !self.development {
                Err(NativeError::new(
                    StatusCode::FORBIDDEN,
                    "origin_required",
                    "Origin permintaan wajib tersedia.",
                ))
            } else {
                Ok(())
            };
        };
        let Some(normalized) = normalize_origin(origin) else {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "origin_not_allowed",
                "Origin permintaan tidak diizinkan.",
            ));
        };
        if self.allowed_origins.contains(&normalized) {
            Ok(())
        } else {
            Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "origin_not_allowed",
                "Origin permintaan tidak diizinkan.",
            ))
        }
    }

    fn rate_limit_keys(ip: &str, username: &str) -> [String; 3] {
        [
            format!("login:ip:v3:{ip}"),
            format!("login:account:v3:{username}"),
            format!("login:pair:v3:{ip}\0{username}"),
        ]
    }

    fn allow_login_attempt(&self, ip: &str, username: &str) -> Result<(), NativeError> {
        let keys = Self::rate_limit_keys(ip, username);
        let limits = [
            (LOGIN_IP_MAX_ATTEMPTS, LOGIN_IP_WINDOW_SECONDS),
            (LOGIN_ACCOUNT_MAX_ATTEMPTS, LOGIN_ACCOUNT_WINDOW_SECONDS),
            (LOGIN_PAIR_MAX_ATTEMPTS, LOGIN_PAIR_WINDOW_SECONDS),
        ];
        for (key, (maximum, window)) in keys.iter().zip(limits) {
            if !self.sessions.consume_attempt(key, maximum, window)? {
                return Err(NativeError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limited",
                    "Terlalu banyak percobaan masuk. Silakan tunggu dan coba lagi.",
                ));
            }
        }
        Ok(())
    }

    async fn verify_turnstile(
        &self,
        token: Option<&str>,
        remote_ip: &str,
    ) -> Result<(), NativeError> {
        if self.local_turnstile_bypass {
            return Ok(());
        }
        let token = token
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                NativeError::new(
                    StatusCode::FORBIDDEN,
                    "turnstile_required",
                    "Verifikasi keamanan diperlukan sebelum masuk.",
                )
            })?;
        let mut form = vec![
            ("secret", self.turnstile_secret.as_str()),
            ("response", token),
        ];
        if remote_ip != "unknown" {
            form.push(("remoteip", remote_ip));
        }
        let response = self
            .supabase
            .http
            .post(TURNSTILE_VERIFY_URL)
            .form(&form)
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "turnstile_unavailable",
                    "Layanan verifikasi keamanan belum tersedia.",
                )
            })?;
        if !response.status().is_success() {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "turnstile_failed",
                "Verifikasi keamanan tidak berhasil. Coba lagi.",
            ));
        }
        let result: TurnstileResult = response.json().await.map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "turnstile_unavailable",
                "Respons verifikasi keamanan tidak dapat dibaca.",
            )
        })?;
        if !result.success {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "turnstile_failed",
                "Verifikasi keamanan tidak berhasil. Coba lagi.",
            ));
        }
        if !self.turnstile_hostnames.is_empty()
            && !result.hostname.as_deref().is_some_and(|hostname| {
                self.turnstile_hostnames
                    .contains(&hostname.trim().to_ascii_lowercase())
            })
        {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "turnstile_hostname_mismatch",
                "Verifikasi keamanan tidak sesuai dengan alamat aplikasi.",
            ));
        }
        Ok(())
    }

    async fn active_session(
        &self,
        headers: HeaderMap,
    ) -> Result<(String, BrowserSession), NativeError> {
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                value
                    .strip_prefix("Bearer ")
                    .or_else(|| value.strip_prefix("bearer "))
            })
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        if let Some(value) = bearer {
            let profile = self.supabase.verify_bearer(&value).await?;
            return Ok((
                String::new(),
                BrowserSession {
                    access_token: value,
                    refresh_token: String::new(),
                    user: SupabaseUser {
                        id: profile.user_id.clone(),
                        email: profile.email.clone(),
                    },
                    profile,
                    updated_at: now_iso(),
                },
            ));
        }

        let identifier = self
            .cookie_identifier(&headers)
            .ok_or_else(NativeError::unauthorized)?;
        let mut session = self
            .sessions
            .get(&identifier)?
            .ok_or_else(NativeError::unauthorized)?;
        let expires_soon = jwt_expiration_seconds(&session.access_token)
            .is_none_or(|expires_at| expires_at <= unix_seconds() + SESSION_REFRESH_WINDOW_SECONDS);
        if expires_soon {
            let refreshed = match self.supabase.refresh(&session.refresh_token).await {
                Ok(refreshed) => refreshed,
                Err(error_value) => {
                    self.sessions.delete(&identifier);
                    return Err(error_value);
                }
            };
            if refreshed.user.id != session.profile.user_id {
                self.sessions.delete(&identifier);
                return Err(NativeError::new(
                    StatusCode::UNAUTHORIZED,
                    "invalid_session",
                    "Sesi masuk tidak lagi valid.",
                ));
            }
            session.access_token = refreshed.access_token;
            session.refresh_token = refreshed.refresh_token;
            session.user = refreshed.user;
            session.updated_at = now_iso();
        }
        self.sessions.put(&identifier, &session)?;
        Ok((identifier, session))
    }

    pub(crate) async fn legacy_authorization(
        &self,
        headers: HeaderMap,
    ) -> Result<Option<HeaderValue>, Response> {
        if headers.contains_key(header::AUTHORIZATION) {
            return Ok(None);
        }

        let Some(identifier) = self.cookie_identifier(&headers) else {
            return Ok(None);
        };
        match self.sessions.get(&identifier) {
            Ok(Some(_)) => {}
            Ok(None) => {
                // The browser may still carry a valid Cloudflare Worker session
                // during the migration window. Leave it untouched so the legacy
                // upstream can validate its own cookie.
                return Ok(None);
            }
            Err(error_value) => return Err(error_value.into_response()),
        }

        let (_, session) = self
            .active_session(headers)
            .await
            .map_err(NativeError::into_response)?;
        HeaderValue::from_str(&format!("Bearer {}", session.access_token))
            .map(Some)
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "session_unavailable",
                    "Sesi aman tidak dapat diteruskan.",
                )
                .into_response()
            })
    }

    pub(crate) async fn authorize(
        &self,
        headers: HeaderMap,
    ) -> Result<AuthorizedSession, Response> {
        let (_, session) = self
            .active_session(headers)
            .await
            .map_err(NativeError::into_response)?;
        Ok(AuthorizedSession {
            access_token: session.access_token,
            scope: session.profile,
        })
    }

    pub(crate) fn valid_mutation_origin(&self, headers: &HeaderMap) -> bool {
        self.validate_origin_headers(headers, true).is_ok()
    }

    pub(crate) async fn login(&self, request: Request) -> Response {
        match self.login_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn login_result(&self, request: Request) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let request_id = request_id(&request);
        let remote_ip = remote_ip(&request);
        let bytes = to_bytes(request.into_body(), LOGIN_BODY_MAX_BYTES)
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "Data masuk terlalu besar.",
                )
            })?;
        let body: LoginBody = serde_json::from_slice(&bytes).map_err(|_| {
            NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Data masuk tidak valid.",
            )
        })?;
        let username = normalized_username(body.username.as_deref())?;
        self.allow_login_attempt(&remote_ip, &username)?;
        self.verify_turnstile(body.turnstile_token.as_deref(), &remote_ip)
            .await?;
        let password = body.password.unwrap_or_default();
        if password.is_empty() {
            self.supabase
                .audit_login(
                    &request_id,
                    &username,
                    None,
                    "login_failure",
                    "missing_password",
                )
                .await;
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Username atau kata sandi tidak benar.",
            ));
        }

        let account = self
            .supabase
            .login_account(&username)
            .await?
            .filter(|value| value.active);
        let Some(account) = account else {
            self.supabase
                .audit_login(
                    &request_id,
                    &username,
                    None,
                    "login_failure",
                    "unknown_or_inactive_account",
                )
                .await;
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Username atau kata sandi tidak benar.",
            ));
        };
        let Some(email) = account.email.as_deref().filter(|value| !value.is_empty()) else {
            self.supabase
                .audit_login(
                    &request_id,
                    &username,
                    Some(&account),
                    "login_failure",
                    "account_email_missing",
                )
                .await;
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Username atau kata sandi tidak benar.",
            ));
        };
        let session = match self.supabase.password_login(email, &password).await {
            Ok(session) => session,
            Err(error_value) if error_value.status == StatusCode::UNAUTHORIZED => {
                self.supabase
                    .audit_login(
                        &request_id,
                        &username,
                        Some(&account),
                        "login_failure",
                        "invalid_credentials",
                    )
                    .await;
                return Err(error_value);
            }
            Err(error_value) => return Err(error_value),
        };
        if session.user.id != account.user_id {
            self.supabase.logout(&session.access_token).await;
            self.supabase
                .audit_login(
                    &request_id,
                    &username,
                    Some(&account),
                    "login_failure",
                    "account_mapping_mismatch",
                )
                .await;
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Username atau kata sandi tidak benar.",
            ));
        }
        let profile = validate_profile(
            account.user_id.clone(),
            session.user.email.clone().or_else(|| account.email.clone()),
            account.role.clone(),
            account.village.clone(),
            account.posyandu.clone(),
        )?;
        let identifier = random_identifier(32);
        let browser_session = BrowserSession {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            user: session.user.clone(),
            profile: profile.clone(),
            updated_at: now_iso(),
        };
        self.sessions.put(&identifier, &browser_session)?;
        self.sessions
            .clear_attempts(&Self::rate_limit_keys(&remote_ip, &username));
        self.supabase
            .audit_login(
                &request_id,
                &username,
                Some(&account),
                "login_success",
                "authenticated",
            )
            .await;

        let mut response = response_json(
            StatusCode::OK,
            json!({
                "user": { "id": session.user.id, "email": session.user.email },
                "profile": profile_payload(&profile)
            }),
        );
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&self.set_cookie(&identifier)).map_err(|_| {
                NativeError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "session_error",
                    "Cookie sesi aman tidak dapat dibuat.",
                )
            })?,
        );
        Ok(response)
    }

    pub(crate) async fn session(&self, request: Request) -> Response {
        let headers = request.headers().clone();
        drop(request);
        match self.active_session(headers).await {
            Ok((_, session)) => response_json(
                StatusCode::OK,
                json!({
                    "user": { "id": session.user.id, "email": session.user.email },
                    "profile": profile_payload(&session.profile)
                }),
            ),
            Err(error_value) => error_value.into_response(),
        }
    }

    pub(crate) async fn me(&self, request: Request) -> Response {
        let headers = request.headers().clone();
        drop(request);
        match self.active_session(headers).await {
            Ok((_, session)) => response_json(StatusCode::OK, profile_payload(&session.profile)),
            Err(error_value) => error_value.into_response(),
        }
    }

    pub(crate) async fn logout(&self, request: Request) -> Response {
        let origin_result = self.validate_origin(&request);
        if let Err(error_value) = origin_result {
            return error_value.into_response();
        }
        let headers = request.headers().clone();
        drop(request);
        if let Some(identifier) = self.cookie_identifier(&headers) {
            if let Ok(Some(session)) = self.sessions.get(&identifier) {
                self.supabase.logout(&session.access_token).await;
            }
            self.sessions.delete(&identifier);
        }
        let mut response = response_json(StatusCode::OK, json!({ "signedOut": true }));
        if let Ok(value) = HeaderValue::from_str(&self.clear_cookie()) {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        response.headers_mut().insert(
            HeaderName::from_static("clear-site-data"),
            HeaderValue::from_static("\"cache\", \"cookies\", \"storage\""),
        );
        response
    }
}

fn profile_payload(scope: &AccessScope) -> Value {
    json!({
        "userId": scope.user_id,
        "email": scope.email,
        "role": scope.role,
        "desa": scope.desa,
        "posyandu": scope.posyandu
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_store() -> (SessionStore, PathBuf) {
        let path = env::temp_dir().join(format!(
            "e-posyandu-session-{}.sqlite",
            random_identifier(8)
        ));
        let store = SessionStore::open(&path, [7_u8; 32]).expect("session store");
        (store, path)
    }

    fn sample_session() -> BrowserSession {
        BrowserSession {
            access_token: "access-token".into(),
            refresh_token: "refresh-token".into(),
            user: SupabaseUser {
                id: "user-1".into(),
                email: Some("user@example.test".into()),
            },
            profile: AccessScope {
                user_id: "user-1".into(),
                email: Some("user@example.test".into()),
                role: "Ahli Gizi".into(),
                desa: None,
                posyandu: None,
            },
            updated_at: now_iso(),
        }
    }

    #[test]
    fn session_payload_is_encrypted_at_rest() {
        let (store, path) = temporary_store();
        let session = sample_session();
        store
            .put("test-session-identifier-000000000000", &session)
            .unwrap();
        let raw = fs::read(&path).expect("sqlite database");
        assert!(
            !raw.windows(b"refresh-token".len())
                .any(|value| value == b"refresh-token")
        );
        let restored = store
            .get("test-session-identifier-000000000000")
            .unwrap()
            .expect("stored session");
        assert_eq!(restored.profile.user_id, "user-1");
        drop(store);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn login_rate_limit_is_persistent_and_bounded() {
        let (store, path) = temporary_store();
        for _ in 0..3 {
            assert!(store.consume_attempt("login:test", 3, 60).unwrap());
        }
        assert!(!store.consume_attempt("login:test", 3, 60).unwrap());
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn validates_profile_scope_rules() {
        assert!(
            validate_profile(
                "u1".into(),
                None,
                "Kader Posyandu".into(),
                Some("Desa".into()),
                Some("Posyandu".into())
            )
            .is_ok()
        );
        assert!(
            validate_profile(
                "u1".into(),
                None,
                "Kader Posyandu".into(),
                Some("Desa".into()),
                None
            )
            .is_err()
        );
    }

    #[test]
    fn session_key_requires_exact_aes_256_material() {
        let encoded = general_purpose::STANDARD.encode([1_u8; 32]);
        assert_eq!(decode_session_key(&encoded).unwrap(), [1_u8; 32]);
        assert!(decode_session_key("short").is_err());
    }

    #[test]
    fn normalizes_turnstile_hostnames_separately_from_cors_origins() {
        assert_eq!(
            normalize_hostname(" EPosyandu.App ").as_deref(),
            Some("eposyandu.app")
        );
        assert_eq!(
            normalize_hostname("www.eposyandu.app").as_deref(),
            Some("www.eposyandu.app")
        );
        assert!(normalize_hostname("https://eposyandu.app").is_none());
        assert!(normalize_hostname("eposyandu.app/path").is_none());
        assert_eq!(
            normalize_origin("https://EPosyandu.App/").as_deref(),
            Some("https://eposyandu.app")
        );
    }

    #[test]
    fn remote_ip_accepts_only_canonical_ip_addresses() {
        let cloudflare = Request::builder()
            .header("cf-connecting-ip", "2001:db8::1")
            .header("x-forwarded-for", "192.0.2.10")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(remote_ip(&cloudflare), "2001:db8::1");

        let forwarded = Request::builder()
            .header("x-forwarded-for", "192.0.2.10, 198.51.100.2")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(remote_ip(&forwarded), "192.0.2.10");

        let spoofed = Request::builder()
            .header("cf-connecting-ip", "<script>alert(1)</script>")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(remote_ip(&spoofed), "unknown");
    }
}
