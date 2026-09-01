use std::{
    collections::{HashMap, HashSet},
    env, fs,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString, rand_core::OsRng as PasswordOsRng},
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

use crate::native_db::{DatabaseError, NativeDatabase};

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
const ADMIN_MFA_PENDING_TTL_SECONDS: i64 = 5 * 60;
const ADMIN_RECOVERY_CODE_COUNT: usize = 10;
const ACCOUNT_ONLINE_WINDOW_SECONDS: i64 = 3 * 60;
// Presence is only used for the coarse online indicator.  Throttling writes
// keeps the shared SQLite session store from becoming a write hotspot when a
// dashboard fans out several authenticated requests at once.
const PRESENCE_WRITE_INTERVAL_SECONDS: i64 = 30;
const ACCOUNT_PRESENCE_RETENTION_SECONDS: i64 = 90 * 24 * 60 * 60;
const TURNSTILE_VERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ORACLE_ORIGIN_HEADER: &str = "x-e-posyandu-origin";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessScope {
    pub user_id: String,
    pub email: Option<String>,
    pub role: String,
    pub desa: Option<String>,
    pub posyandu: Option<String>,
    #[serde(default = "default_access_mode")]
    pub access_mode: String,
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
    #[serde(default)]
    factors: Vec<SupabaseFactor>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SupabaseFactor {
    id: String,
    status: String,
    factor_type: String,
    friendly_name: Option<String>,
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
    #[serde(default = "default_access_mode")]
    access_mode: String,
}

#[derive(Clone, Debug, Deserialize)]
struct AppUser {
    role: String,
    village: Option<String>,
    posyandu: Option<String>,
    active: bool,
    #[serde(default = "default_access_mode")]
    access_mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct BrowserSession {
    access_token: String,
    refresh_token: String,
    user: SupabaseUser,
    profile: AccessScope,
    updated_at: String,
    #[serde(default = "default_mfa_verified")]
    mfa_verified: bool,
    #[serde(default)]
    mfa_pending_expires_at: Option<i64>,
    /// Method used to complete the administrator's second factor.  Older
    /// encrypted sessions do not have this field and are treated as stale so
    /// they cannot bypass the current MFA ceremony.
    #[serde(default)]
    mfa_method: Option<String>,
    #[serde(default)]
    account_revision: i64,
}

fn default_mfa_verified() -> bool {
    true
}

fn default_access_mode() -> String {
    "write".into()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminAccountBody {
    email: Option<String>,
    username: Option<String>,
    role: Option<String>,
    village: Option<String>,
    posyandu: Option<String>,
    access_mode: Option<String>,
    active: Option<bool>,
}

#[derive(Clone, Debug)]
struct ValidatedAdminAccount {
    email: String,
    username: String,
    role: String,
    village: Option<String>,
    posyandu: Option<String>,
    access_mode: String,
    active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    username: Option<String>,
    password: Option<String>,
    turnstile_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MfaEnrollBody {
    factor_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MfaChallengeBody {
    factor_id: String,
    factor_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MfaVerifyBody {
    factor_id: Option<String>,
    challenge_id: Option<String>,
    factor_type: String,
    code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyVerifyBody {
    challenge_id: String,
    credential: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteInviteBody {
    access_token: String,
    refresh_token: String,
    password: String,
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
    database: Arc<NativeDatabase>,
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
    credential_migration_enabled: bool,
    admin_credential_shadow_enabled: bool,
    admin_security_shadow_enabled: bool,
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} wajib diisi untuk API native Oracle."))
}

fn native_database_error(error: DatabaseError, message: &'static str) -> NativeError {
    NativeError::new(
        if matches!(error, DatabaseError::Invalid | DatabaseError::Conflict) {
            StatusCode::UNPROCESSABLE_ENTITY
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        if matches!(error, DatabaseError::Unavailable) {
            "database_unavailable"
        } else {
            "database_error"
        },
        message,
    )
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

fn unix_iso(value: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp(value)
        .ok()
        .and_then(|timestamp| timestamp.format(&Rfc3339).ok())
}

fn account_is_online(active: bool, last_seen: Option<i64>, now: i64) -> bool {
    active
        && last_seen.is_some_and(|seen| {
            seen >= now.saturating_sub(ACCOUNT_ONLINE_WINDOW_SECONDS)
                && seen <= now.saturating_add(30)
        })
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

fn validated_admin_account(
    body: AdminAccountBody,
    default_active: bool,
) -> Result<ValidatedAdminAccount, NativeError> {
    let email = body.email.unwrap_or_default().trim().to_ascii_lowercase();
    if email.is_empty()
        || email.len() > 254
        || email.bytes().any(|byte| byte.is_ascii_whitespace())
        || email.split_once('@').is_none_or(|(local, domain)| {
            local.is_empty() || domain.is_empty() || !domain.contains('.')
        })
    {
        return Err(NativeError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "Alamat email tidak valid.",
        ));
    }
    let username = normalized_username(body.username.as_deref()).map_err(|_| {
        NativeError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "Username wajib 3–32 karakter dan hanya boleh memuat huruf kecil, angka, titik, garis bawah, atau tanda hubung.",
        )
    })?;
    let role = body.role.unwrap_or_default();
    if !matches!(
        role.as_str(),
        "Kader Posyandu" | "Bidan Desa" | "Ahli Gizi" | "super_admin"
    ) {
        return Err(NativeError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "Role akun tidak valid.",
        ));
    }
    let normalize_scope = |value: Option<String>| {
        value
            .map(|candidate| candidate.trim().to_owned())
            .filter(|candidate| !candidate.is_empty() && candidate.len() <= 80)
    };
    let (village, posyandu) = match role.as_str() {
        "Kader Posyandu" => {
            let village = normalize_scope(body.village).ok_or_else(|| {
                NativeError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "validation_error",
                    "Desa dan Posyandu wajib dipilih untuk Kader Posyandu.",
                )
            })?;
            let posyandu = normalize_scope(body.posyandu).ok_or_else(|| {
                NativeError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "validation_error",
                    "Desa dan Posyandu wajib dipilih untuk Kader Posyandu.",
                )
            })?;
            (Some(village), Some(posyandu))
        }
        "Bidan Desa" => {
            let village = normalize_scope(body.village).ok_or_else(|| {
                NativeError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "validation_error",
                    "Desa wajib dipilih untuk Bidan Desa.",
                )
            })?;
            (Some(village), None)
        }
        _ => (None, None),
    };
    let access_mode = body.access_mode.unwrap_or_else(default_access_mode);
    if !matches!(access_mode.as_str(), "read" | "write")
        || (role == "super_admin" && access_mode != "write")
    {
        return Err(NativeError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_error",
            "Hak akses akun tidak valid. Administrator wajib memiliki akses edit.",
        ));
    }
    Ok(ValidatedAdminAccount {
        email,
        username,
        role,
        village,
        posyandu,
        access_mode,
        active: body.active.unwrap_or(default_active),
    })
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

/// Native sessions that do not carry a Supabase access token cannot be
/// forwarded to the legacy Queue API.  During the staged migration ordinary
/// logins therefore obtain a short-lived Supabase session after the local
/// Argon2 check and keep that token in the browser session.  An empty token is
/// still supported for explicitly native-only sessions and must not enter the
/// Supabase refresh flow.
fn session_needs_refresh(access_token: &str, now: i64) -> bool {
    !access_token.is_empty()
        && jwt_expiration_seconds(access_token)
            .is_none_or(|expires_at| expires_at <= now + SESSION_REFRESH_WINDOW_SECONDS)
}

fn jwt_aal(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice::<Value>(&decoded)
        .ok()?
        .get("aal")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn is_super_admin(role: &str) -> bool {
    role == "super_admin"
}

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn normalized_recovery_code(value: &str) -> Option<String> {
    let normalized = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_uppercase())
        .collect::<String>();
    (normalized.len() == 16).then_some(normalized)
}

fn new_recovery_code() -> (String, String) {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let normalized = bytes
        .iter()
        .map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char)
        .collect::<String>();
    let displayed = normalized
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-");
    (normalized, displayed)
}

fn valid_admin_password(value: &str) -> bool {
    (14..=128).contains(&value.chars().count())
        && value
            .chars()
            .any(|character| character.is_ascii_lowercase())
        && value
            .chars()
            .any(|character| character.is_ascii_uppercase())
        && value.chars().any(|character| character.is_ascii_digit())
        && value
            .chars()
            .any(|character| !character.is_ascii_alphanumeric())
}

fn hash_native_password(value: &str) -> Result<String, &'static str> {
    let salt = SaltString::generate(&mut PasswordOsRng);
    Argon2::default()
        .hash_password(value.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| "hash Argon2id tidak dapat dibuat")
}

fn verify_native_password(password: &str, encoded_hash: &str) -> bool {
    let Ok(parsed_hash) = PasswordHash::new(encoded_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
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
                // Semua domain service membuka store sesi yang sama. Jangan
                // mengubah journal mode dari setiap proses saat startup:
                // SQLite dapat mengembalikan SQLITE_PROTOCOL ketika beberapa
                // container mengaktifkan WAL secara bersamaan. Mode journal
                // yang sudah ada dipertahankan; busy_timeout di atas tetap
                // memberi kesempatan pada transaksi pendek untuk selesai.
                "PRAGMA synchronous=FULL;
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
                    ON login_attempts(reset_at);
                 CREATE TABLE IF NOT EXISTS admin_recovery_codes (
                    user_id_hash TEXT NOT NULL,
                    code_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(user_id_hash, code_hash)
                 );
                 CREATE TABLE IF NOT EXISTS account_presence (
                    user_id_hash TEXT NOT NULL,
                    session_hash TEXT NOT NULL,
                    last_seen INTEGER NOT NULL,
                    PRIMARY KEY(user_id_hash, session_hash)
                 );
                 CREATE INDEX IF NOT EXISTS account_presence_seen_idx
                    ON account_presence(last_seen);
                 CREATE INDEX IF NOT EXISTS account_presence_user_idx
                    ON account_presence(user_id_hash, last_seen DESC);
                 CREATE TABLE IF NOT EXISTS account_session_revisions (
                    user_id_hash TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                 );",
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

    fn touch_presence(&self, user_id: &str, session_identifier: &str) -> Result<(), NativeError> {
        let now = unix_seconds();
        let user_hash = sha256_hex(&format!("presence-user:{user_id}"));
        let session_hash = sha256_hex(&format!("presence-session:{session_identifier}"));
        let connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "presence_unavailable",
                "Status aktivitas akun belum tersedia.",
            )
        })?;
        let previous: Option<i64> = connection
            .query_row(
                "SELECT last_seen FROM account_presence WHERE user_id_hash=?1 AND session_hash=?2",
                params![user_hash, session_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| {
                error!(%error, "presence akun tidak dapat dibaca");
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "presence_unavailable",
                    "Status aktivitas akun belum tersedia.",
                )
            })?;
        if previous.is_some_and(|last_seen| {
            now.saturating_sub(last_seen) < PRESENCE_WRITE_INTERVAL_SECONDS
        }) {
            return Ok(());
        }
        connection
            .execute(
                "INSERT INTO account_presence(user_id_hash, session_hash, last_seen)
                 VALUES (?1, ?2, ?3)
                ON CONFLICT(user_id_hash, session_hash) DO UPDATE SET
                    last_seen=excluded.last_seen",
                params![user_hash, session_hash, now],
            )
            .map_err(|error| {
                error!(%error, "presence akun tidak dapat disimpan");
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "presence_unavailable",
                    "Status aktivitas akun belum tersedia.",
                )
            })?;
        let _ = connection.execute(
            "DELETE FROM account_presence WHERE last_seen < ?1",
            params![now.saturating_sub(ACCOUNT_PRESENCE_RETENTION_SECONDS)],
        );
        Ok(())
    }

    fn clear_presence(&self, user_id: &str, session_identifier: &str) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let _ = connection.execute(
            "DELETE FROM account_presence WHERE user_id_hash=?1 AND session_hash=?2",
            params![
                sha256_hex(&format!("presence-user:{user_id}")),
                sha256_hex(&format!("presence-session:{session_identifier}"))
            ],
        );
    }

    fn clear_all_presence(&self, user_id: &str) {
        let Ok(connection) = self.connection.lock() else {
            return;
        };
        let _ = connection.execute(
            "DELETE FROM account_presence WHERE user_id_hash=?1",
            params![sha256_hex(&format!("presence-user:{user_id}"))],
        );
    }

    fn account_revision(&self, user_id: &str) -> Result<i64, NativeError> {
        let connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "session_unavailable",
                "Penyimpanan sesi aman belum tersedia.",
            )
        })?;
        connection
            .query_row(
                "SELECT revision FROM account_session_revisions WHERE user_id_hash=?1",
                params![sha256_hex(&format!("account-revision:{user_id}"))],
                |row| row.get(0),
            )
            .optional()
            .map(|value| value.unwrap_or(0))
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "session_unavailable",
                    "Penyimpanan sesi aman belum tersedia.",
                )
            })
    }

    fn invalidate_account_sessions(&self, user_id: &str) -> Result<(), NativeError> {
        let connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "session_unavailable",
                "Penyimpanan sesi aman belum tersedia.",
            )
        })?;
        connection
            .execute(
                "INSERT INTO account_session_revisions(user_id_hash, revision, updated_at)
                 VALUES (?1, 1, ?2)
                 ON CONFLICT(user_id_hash) DO UPDATE SET
                    revision=account_session_revisions.revision + 1,
                    updated_at=excluded.updated_at",
                params![
                    sha256_hex(&format!("account-revision:{user_id}")),
                    unix_seconds()
                ],
            )
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "session_unavailable",
                    "Sesi akun belum dapat dibatalkan.",
                )
            })?;
        drop(connection);
        self.clear_all_presence(user_id);
        Ok(())
    }

    fn last_seen_by_user(&self, user_ids: &[String]) -> Result<HashMap<String, i64>, NativeError> {
        let lookup = user_ids
            .iter()
            .map(|user_id| {
                (
                    sha256_hex(&format!("presence-user:{user_id}")),
                    user_id.clone(),
                )
            })
            .collect::<HashMap<_, _>>();
        let connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "presence_unavailable",
                "Status aktivitas akun belum tersedia.",
            )
        })?;
        let mut statement = connection
            .prepare(
                "SELECT user_id_hash, MAX(last_seen) AS last_seen
                 FROM account_presence
                 GROUP BY user_id_hash",
            )
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "presence_unavailable",
                    "Status aktivitas akun belum tersedia.",
                )
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "presence_unavailable",
                    "Status aktivitas akun belum tersedia.",
                )
            })?;
        let mut output = HashMap::new();
        for row in rows {
            let (user_hash, last_seen) = row.map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "presence_unavailable",
                    "Status aktivitas akun belum tersedia.",
                )
            })?;
            if let Some(user_id) = lookup.get(&user_hash) {
                output.insert(user_id.clone(), last_seen);
            }
        }
        Ok(output)
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
        let _ = connection.execute(
            "DELETE FROM account_presence WHERE last_seen < ?1",
            params![now.saturating_sub(ACCOUNT_PRESENCE_RETENTION_SECONDS)],
        );
    }

    fn ensure_recovery_codes(&self, user_id: &str) -> Result<Vec<String>, NativeError> {
        let user_id_hash = sha256_hex(&format!("admin-recovery:{user_id}"));
        let mut connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "recovery_unavailable",
                "Kode pemulihan belum dapat disiapkan.",
            )
        })?;
        let existing: i64 = connection
            .query_row(
                "SELECT count(*) FROM admin_recovery_codes WHERE user_id_hash=?1",
                params![user_id_hash],
                |row| row.get(0),
            )
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "recovery_unavailable",
                    "Kode pemulihan belum dapat disiapkan.",
                )
            })?;
        if existing > 0 {
            return Ok(Vec::new());
        }
        let transaction = connection.transaction().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "recovery_unavailable",
                "Kode pemulihan belum dapat disiapkan.",
            )
        })?;
        let mut displayed = Vec::with_capacity(ADMIN_RECOVERY_CODE_COUNT);
        for _ in 0..ADMIN_RECOVERY_CODE_COUNT {
            let (normalized, code) = new_recovery_code();
            transaction
                .execute(
                    "INSERT INTO admin_recovery_codes(user_id_hash, code_hash, created_at)
                     VALUES (?1, ?2, ?3)",
                    params![
                        user_id_hash,
                        sha256_hex(&format!("recovery-code:{normalized}")),
                        unix_seconds()
                    ],
                )
                .map_err(|_| {
                    NativeError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "recovery_unavailable",
                        "Kode pemulihan belum dapat disiapkan.",
                    )
                })?;
            displayed.push(code);
        }
        transaction.commit().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "recovery_unavailable",
                "Kode pemulihan belum dapat disiapkan.",
            )
        })?;
        Ok(displayed)
    }

    fn has_recovery_codes(&self, user_id: &str) -> Result<bool, NativeError> {
        let connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "recovery_unavailable",
                "Status pemulihan belum dapat diperiksa.",
            )
        })?;
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM admin_recovery_codes WHERE user_id_hash=?1",
                params![sha256_hex(&format!("admin-recovery:{user_id}"))],
                |row| row.get(0),
            )
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "recovery_unavailable",
                    "Status pemulihan belum dapat diperiksa.",
                )
            })?;
        Ok(count > 0)
    }

    fn consume_recovery_code(&self, user_id: &str, code: &str) -> Result<bool, NativeError> {
        let Some(normalized) = normalized_recovery_code(code) else {
            return Ok(false);
        };
        let connection = self.connection.lock().map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "recovery_unavailable",
                "Kode pemulihan belum dapat diperiksa.",
            )
        })?;
        let deleted = connection
            .execute(
                "DELETE FROM admin_recovery_codes WHERE user_id_hash=?1 AND code_hash=?2",
                params![
                    sha256_hex(&format!("admin-recovery:{user_id}")),
                    sha256_hex(&format!("recovery-code:{normalized}"))
                ],
            )
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "recovery_unavailable",
                    "Kode pemulihan belum dapat diperiksa.",
                )
            })?;
        Ok(deleted == 1)
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

    fn public_request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .header("apikey", &self.publishable_key)
            .bearer_auth(&self.publishable_key)
            .header(header::ACCEPT, "application/json")
    }

    fn admin_request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .header("apikey", &self.secret_key)
            .bearer_auth(&self.secret_key)
            .header(header::ACCEPT, "application/json")
    }

    async fn admin_response_json<T: DeserializeOwned>(
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
            let conflict = matches!(
                status,
                reqwest::StatusCode::BAD_REQUEST
                    | reqwest::StatusCode::CONFLICT
                    | reqwest::StatusCode::UNPROCESSABLE_ENTITY
            );
            return Err(NativeError::new(
                if conflict {
                    StatusCode::CONFLICT
                } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    StatusCode::TOO_MANY_REQUESTS
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                if conflict {
                    "account_conflict"
                } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    "rate_limited"
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

    async fn invite_user(&self, email: &str, username: &str) -> Result<SupabaseUser, NativeError> {
        let mut url = self.url("auth/v1/invite")?;
        url.query_pairs_mut()
            .append_pair("redirect_to", "https://eposyandu.app/");
        let response = self
            .admin_request(Method::POST, url)
            .json(&json!({ "email": email, "data": { "username": username } }))
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Undangan akun belum dapat dikirim.",
                )
            })?;
        Self::admin_response_json(
            response,
            "Email sudah digunakan atau undangan belum dapat dikirim.",
        )
        .await
    }

    async fn update_admin_user(
        &self,
        user_id: &str,
        email: &str,
        username: &str,
    ) -> Result<SupabaseUser, NativeError> {
        let url = self.url(&format!("auth/v1/admin/users/{user_id}"))?;
        let response = self
            .admin_request(Method::PUT, url)
            .json(&json!({ "email": email, "user_metadata": { "username": username } }))
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Identitas akun belum dapat diperbarui.",
                )
            })?;
        Self::admin_response_json(
            response,
            "Email sudah digunakan atau identitas akun belum dapat diperbarui.",
        )
        .await
    }

    async fn delete_admin_user(&self, user_id: &str) -> Result<(), NativeError> {
        let url = self.url(&format!("auth/v1/admin/users/{user_id}"))?;
        let response = self
            .admin_request(Method::DELETE, url)
            .json(&json!({ "should_soft_delete": false }))
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Akun belum dapat dihapus dari layanan autentikasi.",
                )
            })?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(NativeError::new(
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                "account_delete_failed",
                "Akun belum dapat dihapus dari layanan autentikasi.",
            ))
        }
    }

    async fn login_account(&self, username: &str) -> Result<Option<LoginAccount>, NativeError> {
        let result = self
            .database
            .get(
                "app_users",
                &[
                    (
                        "select".into(),
                        "user_id,email,role,village,posyandu,active,access_mode".into(),
                    ),
                    ("username".into(), format!("eq.{username}")),
                    ("limit".into(), "1".into()),
                ],
                false,
            )
            .await
            .map_err(|error_value| {
                native_database_error(error_value, "Layanan akun belum tersedia.")
            })?;
        let accounts: Vec<LoginAccount> = serde_json::from_value(result.value).map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_database_response",
                "Layanan akun belum tersedia.",
            )
        })?;
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

    async fn mfa_request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        access_token: &str,
        payload: Option<&Value>,
    ) -> Result<T, NativeError> {
        let url = self.url(path)?;
        let mut request = self
            .http
            .request(method, url)
            .header("apikey", &self.publishable_key)
            .bearer_auth(access_token)
            .header(header::ACCEPT, "application/json");
        if let Some(payload) = payload {
            request = request.json(payload);
        }
        let response = request.send().await.map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "mfa_unavailable",
                "Layanan verifikasi dua langkah belum tersedia.",
            )
        })?;
        Self::response_json(
            response,
            "Verifikasi dua langkah tidak berhasil. Periksa kode atau perangkat lalu coba lagi.",
        )
        .await
    }

    async fn mfa_enroll(
        &self,
        access_token: &str,
        factor_type: &str,
    ) -> Result<Value, NativeError> {
        let friendly_name = if factor_type == "webauthn" {
            "Passkey Administrator"
        } else {
            "TOTP Administrator"
        };
        let payload = if factor_type == "totp" {
            json!({
                "factor_type": factor_type,
                "friendly_name": friendly_name,
                "issuer": "E-Posyandu"
            })
        } else {
            json!({
                "factor_type": factor_type,
                "friendly_name": friendly_name
            })
        };
        self.mfa_request(
            Method::POST,
            "auth/v1/factors",
            access_token,
            Some(&payload),
        )
        .await
    }

    async fn mfa_challenge(
        &self,
        access_token: &str,
        factor_id: &str,
    ) -> Result<Value, NativeError> {
        self.mfa_request(
            Method::POST,
            &format!("auth/v1/factors/{factor_id}/challenge"),
            access_token,
            None,
        )
        .await
    }

    async fn mfa_verify(
        &self,
        access_token: &str,
        factor_id: &str,
        payload: &Value,
    ) -> Result<SupabaseSession, NativeError> {
        self.mfa_request(
            Method::POST,
            &format!("auth/v1/factors/{factor_id}/verify"),
            access_token,
            Some(payload),
        )
        .await
    }

    async fn passkey_request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        access_token: Option<&str>,
        payload: Option<&Value>,
    ) -> Result<T, NativeError> {
        let url = self.url(path)?;
        let mut request = self
            .http
            .request(method, url)
            .header("apikey", &self.publishable_key)
            .header(header::ACCEPT, "application/json");
        request = match access_token {
            Some(token) => request.bearer_auth(token),
            None => request.bearer_auth(&self.publishable_key),
        };
        if let Some(payload) = payload {
            request = request.json(payload);
        }
        let response = request.send().await.map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "passkey_unavailable",
                "Layanan passkey belum tersedia.",
            )
        })?;
        let upstream_code = response
            .headers()
            .get("x-sb-error-code")
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "passkey_unavailable",
                "Respons layanan passkey tidak dapat dibaca.",
            )
        })?;
        if !status.is_success() {
            let body_code = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|body| {
                    body.get("error_code")
                        .or_else(|| body.get("code"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                });
            let code = upstream_code.or(body_code).unwrap_or_default();
            return Err(match code.as_str() {
                "passkey_disabled" => NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "passkey_disabled",
                    "Passkey belum diaktifkan pada project autentikasi.",
                ),
                "insufficient_aal" => NativeError::new(
                    StatusCode::FORBIDDEN,
                    "passkey_requires_mfa",
                    "Verifikasi authenticator terlebih dahulu sebelum mendaftarkan passkey.",
                ),
                "webauthn_challenge_expired" => NativeError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "passkey_challenge_expired",
                    "Permintaan passkey sudah kedaluwarsa. Silakan coba lagi.",
                ),
                _ if status == reqwest::StatusCode::TOO_MANY_REQUESTS => NativeError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limited",
                    "Terlalu banyak percobaan passkey. Silakan tunggu sebentar.",
                ),
                _ => NativeError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "passkey_failed",
                    "Passkey tidak dapat diverifikasi. Periksa perangkat dan domain aplikasi lalu coba lagi.",
                ),
            });
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_upstream_response",
                "Respons layanan passkey tidak dapat dibaca.",
            )
        })
    }

    async fn passkey_registration_options(&self, access_token: &str) -> Result<Value, NativeError> {
        self.passkey_request(
            Method::POST,
            "auth/v1/passkeys/registration/options",
            Some(access_token),
            Some(&json!({})),
        )
        .await
    }

    async fn passkey_registration_verify(
        &self,
        access_token: &str,
        challenge_id: &str,
        credential: &Value,
    ) -> Result<Value, NativeError> {
        self.passkey_request(
            Method::POST,
            "auth/v1/passkeys/registration/verify",
            Some(access_token),
            Some(&json!({ "challenge_id": challenge_id, "credential": credential })),
        )
        .await
    }

    async fn passkey_authentication_options(&self) -> Result<Value, NativeError> {
        self.passkey_request(
            Method::POST,
            "auth/v1/passkeys/authentication/options",
            None,
            Some(&json!({})),
        )
        .await
    }

    async fn passkey_authentication_verify(
        &self,
        challenge_id: &str,
        credential: &Value,
    ) -> Result<SupabaseSession, NativeError> {
        self.passkey_request(
            Method::POST,
            "auth/v1/passkeys/authentication/verify",
            None,
            Some(&json!({ "challenge_id": challenge_id, "credential": credential })),
        )
        .await
    }

    async fn passkey_list(&self, access_token: &str) -> Result<Vec<Value>, NativeError> {
        self.passkey_request(Method::GET, "auth/v1/passkeys", Some(access_token), None)
            .await
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

    async fn logout_local(&self, access_token: &str) {
        let Ok(mut url) = self.url("auth/v1/logout") else {
            return;
        };
        url.query_pairs_mut().append_pair("scope", "local");
        let _ = self
            .http
            .post(url)
            .header("apikey", &self.publishable_key)
            .bearer_auth(access_token)
            .send()
            .await;
    }

    async fn identity(&self, access_token: &str) -> Result<SupabaseUser, NativeError> {
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
        Self::response_json(response, "Tautan undangan tidak lagi valid.").await
    }

    async fn update_password(
        &self,
        access_token: &str,
        password: &str,
    ) -> Result<SupabaseUser, NativeError> {
        let url = self.url("auth/v1/user")?;
        let response = self
            .http
            .put(url)
            .header("apikey", &self.publishable_key)
            .bearer_auth(access_token)
            .json(&json!({ "password": password }))
            .send()
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_unavailable",
                    "Kata sandi administrator belum dapat disimpan.",
                )
            })?;
        Self::response_json(response, "Kata sandi administrator belum dapat disimpan.").await
    }

    async fn profile_for_identity(
        &self,
        identity: &SupabaseUser,
    ) -> Result<AccessScope, NativeError> {
        let result = self
            .database
            .get(
                "app_users",
                &[
                    (
                        "select".into(),
                        "role,village,posyandu,active,access_mode".into(),
                    ),
                    ("user_id".into(), format!("eq.{}", identity.id)),
                    ("limit".into(), "1".into()),
                ],
                false,
            )
            .await
            .map_err(|error_value| {
                native_database_error(error_value, "Layanan profil akun belum tersedia.")
            })?;
        let profiles: Vec<AppUser> = serde_json::from_value(result.value).map_err(|_| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_database_response",
                "Layanan profil akun belum tersedia.",
            )
        })?;
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
            identity.id.clone(),
            identity.email.clone(),
            profile.role,
            profile.village,
            profile.posyandu,
            profile.access_mode,
        )
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

        let profile = self.profile_for_identity(&identity).await?;
        if is_super_admin(&profile.role) && jwt_aal(access_token).as_deref() != Some("aal2") {
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "mfa_required",
                "Verifikasi dua langkah diperlukan untuk akun administrator.",
            ));
        }
        Ok(profile)
    }

    async fn audit_login(
        &self,
        request_id: &str,
        username: &str,
        account: Option<&LoginAccount>,
        action: &str,
        outcome: &str,
    ) {
        let account_key = sha256_hex(&format!("account:{username}"));
        let response = self
            .database
            .write(
                &Method::POST,
                "audit_events",
                &[(
                    "on_conflict".into(),
                    "idempotency_key,action,resource,document_id".into(),
                )],
                Some(&json!({
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
                })),
                Some("resolution=ignore-duplicates,return=minimal"),
            )
            .await;
        if response.is_err() {
            warn!(%request_id, %action, "audit autentikasi native gagal ditulis");
        }
    }

    async fn audit_mfa(&self, scope: &AccessScope, method: &str) {
        let request_id = format!("mfa-{}-{}", unix_seconds(), random_identifier(8));
        let response = self
            .database
            .write(
                &Method::POST,
                "audit_events",
                &[(
                    "on_conflict".into(),
                    "idempotency_key,action,resource,document_id".into(),
                )],
                Some(&json!({
                    "request_id": request_id,
                    "idempotency_key": Value::Null,
                    "actor_user_id": scope.user_id,
                    "actor_role": scope.role,
                    "action": "login_success",
                    "resource": "authentication",
                    "document_id": sha256_hex(&format!("mfa:{}", scope.user_id)),
                    "village": scope.desa,
                    "posyandu": scope.posyandu,
                    "before_data": Value::Null,
                    "after_data": Value::Null,
                    "metadata": { "outcome": "mfa_verified", "method": method, "origin": "oracle-native" }
                })),
                Some("resolution=ignore-duplicates,return=minimal"),
            )
            .await;
        if response.is_err() {
            warn!(%request_id, "audit MFA native gagal ditulis");
        }
    }

    async fn audit_account_admin(
        &self,
        request_id: &str,
        actor: &AccessScope,
        target_user_id: &str,
        action: &str,
        before: Option<&Value>,
        after: Option<&Value>,
    ) {
        let response = self
            .database
            .write(
                &Method::POST,
                "audit_events",
                &[(
                    "on_conflict".into(),
                    "idempotency_key,action,resource,document_id".into(),
                )],
                Some(&json!({
                    "request_id": request_id,
                    "idempotency_key": Value::Null,
                    "actor_user_id": actor.user_id,
                    "actor_role": actor.role,
                    "action": action,
                    "resource": "app_users",
                    "document_id": target_user_id,
                    "village": after.and_then(|value| value.get("village")).cloned().unwrap_or(Value::Null),
                    "posyandu": after.and_then(|value| value.get("posyandu")).cloned().unwrap_or(Value::Null),
                    "before_data": before.cloned().unwrap_or(Value::Null),
                    "after_data": after.cloned().unwrap_or(Value::Null),
                    "metadata": { "origin": "oracle-native", "adminManaged": true }
                })),
                Some("resolution=ignore-duplicates,return=minimal"),
            )
            .await;
        if response.is_err() {
            warn!(%request_id, %action, %target_user_id, "audit administrasi akun gagal ditulis");
        }
    }
}

fn validate_profile(
    user_id: String,
    email: Option<String>,
    role: String,
    desa: Option<String>,
    posyandu: Option<String>,
    access_mode: String,
) -> Result<AccessScope, NativeError> {
    if !matches!(
        role.as_str(),
        "Kader Posyandu" | "Bidan Desa" | "Ahli Gizi" | "super_admin"
    ) {
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
    if is_super_admin(&role) && (desa.is_some() || posyandu.is_some()) {
        return Err(NativeError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Scope administrator tidak valid.",
        ));
    }
    if !matches!(access_mode.as_str(), "read" | "write")
        || (is_super_admin(&role) && access_mode != "write")
    {
        return Err(NativeError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Hak akses akun tidak valid.",
        ));
    }
    Ok(AccessScope {
        user_id,
        email,
        role,
        desa,
        posyandu,
        access_mode,
    })
}

impl NativeAuth {
    pub(crate) fn from_env(
        http: Client,
        database: Option<Arc<NativeDatabase>>,
    ) -> Result<Option<Self>, String> {
        if !env_flag("ORACLE_API_NATIVE_AUTH_ENABLED", false) {
            return Ok(None);
        }
        let database = database.ok_or_else(|| {
            "PostgreSQL native wajib tersedia saat autentikasi Oracle aktif.".to_string()
        })?;

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
        let credential_migration_enabled =
            env_flag("ORACLE_API_NATIVE_CREDENTIAL_MIGRATION_ENABLED", false);
        // Administrator passwords are shadowed only after Supabase verifies
        // them successfully. The administrator still receives the existing
        // Supabase MFA/passkey challenge until that verifier is migrated and
        // tested, so this flag never changes the active admin login path.
        let admin_credential_shadow_enabled =
            env_flag("ORACLE_API_NATIVE_ADMIN_CREDENTIAL_SHADOW_ENABLED", false);
        let admin_security_shadow_enabled =
            env_flag("ORACLE_API_NATIVE_ADMIN_SECURITY_SHADOW_ENABLED", false);
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
                database,
            },
            sessions,
            turnstile_secret: required_env("TURNSTILE_SECRET_KEY")?,
            turnstile_hostnames,
            allowed_origins,
            development,
            local_turnstile_bypass,
            credential_migration_enabled,
            admin_credential_shadow_enabled,
            admin_security_shadow_enabled,
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
            let account_revision = self.sessions.account_revision(&profile.user_id)?;
            // Presence is telemetry only.  A busy SQLite telemetry write must
            // not turn an otherwise valid bearer session into an error.
            let _ = self
                .sessions
                .touch_presence(&profile.user_id, &format!("bearer:{}", sha256_hex(&value)));
            return Ok((
                String::new(),
                BrowserSession {
                    access_token: value,
                    refresh_token: String::new(),
                    user: SupabaseUser {
                        id: profile.user_id.clone(),
                        email: profile.email.clone(),
                        factors: Vec::new(),
                    },
                    profile,
                    updated_at: now_iso(),
                    mfa_verified: true,
                    mfa_pending_expires_at: None,
                    mfa_method: None,
                    account_revision,
                },
            ));
        }

        self.browser_session(headers, true).await
    }

    async fn browser_session(
        &self,
        headers: HeaderMap,
        require_verified_mfa: bool,
    ) -> Result<(String, BrowserSession), NativeError> {
        let identifier = self
            .cookie_identifier(&headers)
            .ok_or_else(NativeError::unauthorized)?;
        let mut session = self
            .sessions
            .get(&identifier)?
            .ok_or_else(NativeError::unauthorized)?;
        if self.sessions.account_revision(&session.profile.user_id)? != session.account_revision {
            self.sessions.delete(&identifier);
            self.sessions
                .clear_presence(&session.profile.user_id, &identifier);
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "account_access_changed",
                "Hak akses akun berubah. Silakan masuk kembali.",
            ));
        }
        // Reads from the dashboard fan out to several domain services at the
        // same time.  Do not rewrite the shared SQLite row for every read:
        // that turns harmless profile/collection reads into competing write
        // transactions and can make a valid session look unauthorized while
        // SQLite is busy.  Persist only when the provider token was refreshed
        // or a legacy MFA flag had to be migrated.
        let mut session_changed = false;
        let expires_soon = session_needs_refresh(&session.access_token, unix_seconds());
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
            session_changed = true;
        }
        // A browser session from an earlier release may have the local
        // `mfa_verified` flag set without recording which factor completed.
        // Treat that legacy state as pending so it cannot bypass the current
        // MFA ceremony. New sessions carry the method explicitly and remain
        // valid when the short-lived provider token is refreshed.
        if is_super_admin(&session.profile.role)
            && session.mfa_verified
            && session.mfa_method.is_none()
        {
            session.mfa_verified = false;
            session.mfa_pending_expires_at = Some(unix_seconds() + ADMIN_MFA_PENDING_TTL_SECONDS);
            session.mfa_method = None;
            session.updated_at = now_iso();
            session_changed = true;
        }
        if is_super_admin(&session.profile.role) && !session.mfa_verified {
            if session
                .mfa_pending_expires_at
                .is_none_or(|expires_at| expires_at <= unix_seconds())
            {
                self.sessions.delete(&identifier);
                return Err(NativeError::new(
                    StatusCode::UNAUTHORIZED,
                    "mfa_session_expired",
                    "Waktu verifikasi dua langkah habis. Silakan masuk kembali.",
                ));
            }
            if require_verified_mfa {
                return Err(NativeError::new(
                    StatusCode::UNAUTHORIZED,
                    "mfa_required",
                    "Verifikasi dua langkah diperlukan untuk akun administrator.",
                ));
            }
        }
        if session_changed {
            self.sessions.put(&identifier, &session)?;
        }
        if !is_super_admin(&session.profile.role) || session.mfa_verified {
            // Presence is telemetry, not an authorization prerequisite.  A
            // transient SQLite write contention must never log a user out of
            // an otherwise valid browser session.
            let _ = self
                .sessions
                .touch_presence(&session.profile.user_id, &identifier);
        }
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
        if session.access_token.is_empty() {
            return Ok(None);
        }
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
        // Super-admin accounts remain on the Supabase path until the native
        // MFA/passkey verifier is migrated. This keeps the existing second
        // factor intact while ordinary migrated accounts can use Oracle only.
        let native_first = !is_super_admin(&account.role);
        let native_hash = if native_first {
            self.supabase
                .database
                .native_password_hash(&account.user_id)
                .await
                .map_err(|error_value| {
                    native_database_error(error_value, "Layanan credential akun belum tersedia.")
                })?
        } else {
            None
        };
        let (session, native_authenticated) = if let Some(encoded_hash) = native_hash {
            if !verify_native_password(&password, &encoded_hash) {
                self.supabase
                    .audit_login(
                        &request_id,
                        &username,
                        Some(&account),
                        "login_failure",
                        "invalid_native_credentials",
                    )
                    .await;
                return Err(NativeError::new(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "Username atau kata sandi tidak benar.",
                ));
            }
            // The analysis queue is still served by the legacy Cloudflare
            // Worker.  It accepts Supabase bearer tokens only, so a local
            // credential login must establish a bridge token after the
            // Argon2 verification.  Keep the local hash as the primary
            // verifier, while preserving the native-only fallback when an
            // account has no email (those accounts cannot authenticate with
            // Supabase until their profile is completed).
            if let Some(email) = account.email.as_deref().filter(|value| !value.is_empty()) {
                let bridge_session = self.supabase.password_login(email, &password).await?;
                (bridge_session, true)
            } else {
                (
                    SupabaseSession {
                        access_token: String::new(),
                        refresh_token: String::new(),
                        user: SupabaseUser {
                            id: account.user_id.clone(),
                            email: account.email.clone(),
                            factors: Vec::new(),
                        },
                    },
                    true,
                )
            }
        } else {
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
            (session, false)
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
            account.access_mode.clone(),
        )?;

        // Dual-run migration: Supabase remains the password verifier. After a
        // successful verification, persist only an Argon2id hash in Oracle so
        // the account can be cut over after all validation is complete. The
        // optional admin shadow writes the password hash for super_admin too,
        // but deliberately leaves the Supabase MFA/passkey path active. A
        // migration write failure must never block the existing login path.
        if self.credential_migration_enabled
            && !native_authenticated
            && (!is_super_admin(&profile.role) || self.admin_credential_shadow_enabled)
        {
            match hash_native_password(&password) {
                Ok(password_hash) => {
                    if let Err(error_value) = self
                        .supabase
                        .database
                        .store_native_password_hash(&profile.user_id, &password_hash)
                        .await
                    {
                        warn!(
                            user_id = %profile.user_id,
                            error = ?error_value,
                            "migrasi credential native gagal; Supabase tetap digunakan"
                        );
                    }
                }
                Err(error_value) => {
                    warn!(
                        user_id = %profile.user_id,
                        error = error_value,
                        "hash credential native gagal; Supabase tetap digunakan"
                    );
                }
            }
        }
        if native_authenticated {
            if let Err(error_value) = self
                .supabase
                .database
                .mark_native_password_login(&profile.user_id)
                .await
            {
                warn!(
                    user_id = %profile.user_id,
                    error = ?error_value,
                    "status login credential native gagal diperbarui"
                );
            }
        }
        let requires_mfa = is_super_admin(&profile.role);
        let factors = if requires_mfa {
            Some(self.admin_mfa_factors(&session).await)
        } else {
            None
        };
        let identifier = random_identifier(32);
        let browser_session = BrowserSession {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            user: session.user.clone(),
            profile: profile.clone(),
            updated_at: now_iso(),
            mfa_verified: !requires_mfa,
            mfa_pending_expires_at: requires_mfa
                .then(|| unix_seconds() + ADMIN_MFA_PENDING_TTL_SECONDS),
            mfa_method: None,
            account_revision: self.sessions.account_revision(&profile.user_id)?,
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
                if requires_mfa {
                    "password_verified_mfa_pending"
                } else {
                    "authenticated"
                },
            )
            .await;

        let payload = if requires_mfa {
            let factors = factors.unwrap_or_default();
            json!({
                "mfaRequired": true,
                "setupRequired": factors.is_empty(),
                "factors": factors,
                "expiresIn": ADMIN_MFA_PENDING_TTL_SECONDS
            })
        } else {
            json!({
                "user": { "id": session.user.id, "email": session.user.email },
                "profile": profile_payload(&profile)
            })
        };
        let mut response = response_json(StatusCode::OK, payload);
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

    async fn admin_mfa_factors(&self, session: &SupabaseSession) -> Vec<Value> {
        let mut factors = session
            .user
            .factors
            .iter()
            .filter(|factor| factor.status == "verified")
            .filter(|factor| factor.factor_type == "totp")
            .map(|factor| {
                json!({
                    "id": factor.id,
                    "type": "totp",
                    "name": factor.friendly_name
                })
            })
            .collect::<Vec<_>>();
        let mut passkey_count = Some(0_i32);

        // Supabase passkeys are credentials, not MFA factors. Include them in
        // the pending administrator response so the UI can choose the correct
        // passkey ceremony without pretending they are `/factors` records.
        match self.supabase.passkey_list(&session.access_token).await {
            Ok(passkeys) => {
                passkey_count = i32::try_from(passkeys.len()).ok();
                factors.extend(passkeys.into_iter().filter_map(|passkey| {
                    let id = passkey.get("id").and_then(Value::as_str)?.to_owned();
                    Some(json!({
                        "id": id,
                        "type": "webauthn",
                        "name": passkey.get("friendly_name").cloned().unwrap_or(Value::Null)
                    }))
                }));
            }
            Err(error_value) if error_value.code == "passkey_disabled" => {}
            Err(error_value) => {
                passkey_count = None;
                warn!(code = error_value.code, "daftar passkey tidak dapat dimuat");
            }
        }
        if self.admin_security_shadow_enabled {
            let totp_count = factors
                .iter()
                .filter(|factor| factor.get("type").and_then(Value::as_str) == Some("totp"))
                .count();
            if let Some(passkey_count) = passkey_count {
                if let Err(error_value) = self
                    .supabase
                    .database
                    .record_admin_security_shadow(
                        &session.user.id,
                        i32::try_from(totp_count).unwrap_or(i32::MAX),
                        passkey_count,
                    )
                    .await
                {
                    warn!(
                        user_id = %session.user.id,
                        error = ?error_value,
                        "metadata MFA/passkey administrator gagal disinkronkan"
                    );
                }
            }
        }
        factors
    }

    async fn mfa_body<T: DeserializeOwned>(&self, request: Request) -> Result<T, NativeError> {
        let bytes = to_bytes(request.into_body(), LOGIN_BODY_MAX_BYTES)
            .await
            .map_err(|_| {
                NativeError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "Data verifikasi terlalu besar.",
                )
            })?;
        serde_json::from_slice(&bytes).map_err(|_| {
            NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Data verifikasi tidak valid.",
            )
        })
    }

    pub(crate) async fn complete_invite(&self, request: Request) -> Response {
        match self.complete_invite_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn complete_invite_result(&self, request: Request) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let request_id = request_id(&request);
        let body: CompleteInviteBody = self.mfa_body(request).await?;
        if body.access_token.len() > 8 * 1024
            || body.refresh_token.is_empty()
            || body.refresh_token.len() > 8 * 1024
            || !valid_admin_password(&body.password)
        {
            return Err(NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Kata sandi wajib minimal 14 karakter dan memuat huruf besar, huruf kecil, angka, serta simbol.",
            ));
        }
        let identity = self.supabase.identity(&body.access_token).await?;
        let profile = self.supabase.profile_for_identity(&identity).await?;
        let requires_mfa = is_super_admin(&profile.role);
        if requires_mfa && self.sessions.has_recovery_codes(&profile.user_id)? {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "invite_not_allowed",
                "Undangan akun ini tidak dapat digunakan.",
            ));
        }
        let email = identity
            .email
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                NativeError::new(
                    StatusCode::FORBIDDEN,
                    "invite_not_allowed",
                    "Email akun belum terverifikasi.",
                )
            })?;
        let updated = self
            .supabase
            .update_password(&body.access_token, &body.password)
            .await?;
        if updated.id != profile.user_id {
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_invite",
                "Tautan undangan tidak sesuai dengan akun.",
            ));
        }
        self.supabase.logout_local(&body.access_token).await;
        let session = self.supabase.password_login(email, &body.password).await?;
        if session.user.id != profile.user_id {
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_invite",
                "Tautan undangan tidak sesuai dengan akun.",
            ));
        }

        let factors = if requires_mfa {
            Some(self.admin_mfa_factors(&session).await)
        } else {
            None
        };
        let identifier = random_identifier(32);
        self.sessions.put(
            &identifier,
            &BrowserSession {
                access_token: session.access_token,
                refresh_token: session.refresh_token,
                user: session.user.clone(),
                profile: profile.clone(),
                updated_at: now_iso(),
                mfa_verified: !requires_mfa,
                mfa_pending_expires_at: requires_mfa
                    .then(|| unix_seconds() + ADMIN_MFA_PENDING_TTL_SECONDS),
                mfa_method: None,
                account_revision: self.sessions.account_revision(&profile.user_id)?,
            },
        )?;
        let account = LoginAccount {
            user_id: profile.user_id.clone(),
            email: profile.email.clone(),
            role: profile.role.clone(),
            village: profile.desa.clone(),
            posyandu: profile.posyandu.clone(),
            active: true,
            access_mode: profile.access_mode.clone(),
        };
        self.supabase
            .audit_login(
                &request_id,
                "invite",
                Some(&account),
                "login_success",
                if requires_mfa {
                    "invite_completed_mfa_pending"
                } else {
                    "invite_completed_authenticated"
                },
            )
            .await;
        let payload = if requires_mfa {
            let factors = factors.unwrap_or_default();
            json!({
                "mfaRequired": true,
                "setupRequired": factors.is_empty(),
                "factors": factors,
                "expiresIn": ADMIN_MFA_PENDING_TTL_SECONDS
            })
        } else {
            json!({
                "mfaRequired": false,
                "user": { "id": session.user.id, "email": session.user.email },
                "profile": profile_payload(&profile)
            })
        };
        let mut response = response_json(StatusCode::OK, payload);
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

    pub(crate) async fn mfa_enroll(&self, request: Request) -> Response {
        match self.mfa_enroll_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn mfa_enroll_result(&self, request: Request) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let headers = request.headers().clone();
        let body: MfaEnrollBody = self.mfa_body(request).await?;
        let (_, session) = self.browser_session(headers, false).await?;
        if !is_super_admin(&session.profile.role) || body.factor_type != "totp" {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Metode verifikasi tidak diizinkan.",
            ));
        }
        let factor = self
            .supabase
            .mfa_enroll(&session.access_token, &body.factor_type)
            .await?;
        Ok(response_json(StatusCode::OK, json!({ "factor": factor })))
    }

    pub(crate) async fn mfa_challenge(&self, request: Request) -> Response {
        match self.mfa_challenge_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn mfa_challenge_result(&self, request: Request) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let headers = request.headers().clone();
        let body: MfaChallengeBody = self.mfa_body(request).await?;
        let (_, session) = self.browser_session(headers, false).await?;
        if !is_super_admin(&session.profile.role)
            || !valid_uuid(&body.factor_id)
            || body.factor_type != "totp"
        {
            return Err(NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Faktor verifikasi tidak valid.",
            ));
        }
        let challenge = self
            .supabase
            .mfa_challenge(&session.access_token, &body.factor_id)
            .await?;
        Ok(response_json(
            StatusCode::OK,
            json!({ "challenge": challenge }),
        ))
    }

    pub(crate) async fn mfa_verify(&self, request: Request) -> Response {
        match self.mfa_verify_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn mfa_verify_result(&self, request: Request) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let headers = request.headers().clone();
        let body: MfaVerifyBody = self.mfa_body(request).await?;
        let (identifier, mut session) = self.browser_session(headers, false).await?;
        if !is_super_admin(&session.profile.role) {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Verifikasi administrator tidak diizinkan.",
            ));
        }
        if !matches!(body.factor_type.as_str(), "totp" | "recovery") {
            return Err(NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Metode verifikasi tidak valid.",
            ));
        }

        let mut recovery_codes = Vec::new();
        if body.factor_type == "recovery" {
            let allowed = self.sessions.consume_attempt(
                &format!("mfa:recovery:{}", session.profile.user_id),
                5,
                5 * 60,
            )?;
            let valid = allowed
                && body.code.as_deref().is_some_and(|code| {
                    self.sessions
                        .consume_recovery_code(&session.profile.user_id, code)
                        .unwrap_or(false)
                });
            if !valid {
                return Err(NativeError::new(
                    StatusCode::UNAUTHORIZED,
                    "invalid_recovery_code",
                    "Kode pemulihan tidak valid atau sudah pernah digunakan.",
                ));
            }
        } else {
            let factor_id = body
                .factor_id
                .as_deref()
                .filter(|value| valid_uuid(value))
                .ok_or_else(|| {
                    NativeError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "validation_error",
                        "Faktor verifikasi tidak valid.",
                    )
                })?;
            let challenge_id = body
                .challenge_id
                .as_deref()
                .filter(|value| valid_uuid(value))
                .ok_or_else(|| {
                    NativeError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "validation_error",
                        "Challenge verifikasi tidak valid.",
                    )
                })?;
            let code = body
                .code
                .as_deref()
                .map(str::trim)
                .filter(|value| value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit()))
                .ok_or_else(|| {
                    NativeError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "validation_error",
                        "Kode authenticator harus berisi 6 angka.",
                    )
                })?;
            let payload = json!({ "challenge_id": challenge_id, "code": code });
            let verified = self
                .supabase
                .mfa_verify(&session.access_token, factor_id, &payload)
                .await?;
            // Supabase's MFA endpoint has already checked the challenge and
            // code. Some Auth deployments omit the optional `aal` claim from
            // the returned JWT, so the local browser session must not reject
            // an otherwise valid provider session solely because that claim
            // is absent. Raw bearer requests remain protected by the strict
            // AAL2 check in `verify_bearer`.
            let verified_aal = jwt_aal(&verified.access_token);
            if verified.user.id != session.profile.user_id
                || verified.access_token.is_empty()
                || verified_aal
                    .as_deref()
                    .is_some_and(|aal| !matches!(aal, "aal1" | "aal2"))
            {
                self.sessions.delete(&identifier);
                return Err(NativeError::new(
                    StatusCode::UNAUTHORIZED,
                    "mfa_failed",
                    "Verifikasi dua langkah tidak menghasilkan sesi administrator yang aman.",
                ));
            }
            session.access_token = verified.access_token;
            session.refresh_token = verified.refresh_token;
            session.user = verified.user;
            recovery_codes = self
                .sessions
                .ensure_recovery_codes(&session.profile.user_id)?;
        }
        session.mfa_verified = true;
        session.mfa_pending_expires_at = None;
        session.mfa_method = Some(body.factor_type.clone());
        session.updated_at = now_iso();
        self.sessions.put(&identifier, &session)?;
        // Recording presence is best-effort and must never invalidate a
        // successful MFA ceremony when the shared session database is busy.
        let _ = self
            .sessions
            .touch_presence(&session.profile.user_id, &identifier);
        self.supabase
            .audit_mfa(&session.profile, &body.factor_type)
            .await;

        Ok(response_json(
            StatusCode::OK,
            json!({
                "user": { "id": session.user.id, "email": session.user.email },
                "profile": profile_payload(&session.profile),
                "recoveryCodes": recovery_codes
            }),
        ))
    }

    pub(crate) async fn passkey_registration_options(&self, request: Request) -> Response {
        match self.passkey_registration_options_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn passkey_registration_options_result(
        &self,
        request: Request,
    ) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let headers = request.headers().clone();
        let (_, session) = self.browser_session(headers, false).await?;
        if !is_super_admin(&session.profile.role) {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Pendaftaran passkey hanya tersedia untuk administrator.",
            ));
        }
        let challenge = self
            .supabase
            .passkey_registration_options(&session.access_token)
            .await?;
        let challenge_id = challenge
            .get("challenge_id")
            .and_then(Value::as_str)
            .filter(|value| valid_uuid(value))
            .ok_or_else(|| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "invalid_upstream_response",
                    "Challenge pendaftaran passkey tidak valid.",
                )
            })?;
        let options = challenge.get("options").cloned().ok_or_else(|| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_upstream_response",
                "Opsi pendaftaran passkey tidak tersedia.",
            )
        })?;
        Ok(response_json(
            StatusCode::OK,
            json!({
                "challenge": {
                    "id": challenge_id,
                    "options": options,
                    "expiresAt": challenge.get("expires_at").cloned().unwrap_or(Value::Null)
                }
            }),
        ))
    }

    pub(crate) async fn passkey_registration_verify(&self, request: Request) -> Response {
        match self.passkey_registration_verify_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn passkey_registration_verify_result(
        &self,
        request: Request,
    ) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let headers = request.headers().clone();
        let body: PasskeyVerifyBody = self.mfa_body(request).await?;
        if !valid_uuid(&body.challenge_id) || !body.credential.is_object() {
            return Err(NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Data verifikasi passkey tidak valid.",
            ));
        }
        let (identifier, mut session) = self.browser_session(headers, false).await?;
        if !is_super_admin(&session.profile.role) {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Pendaftaran passkey hanya tersedia untuk administrator.",
            ));
        }
        self.supabase
            .passkey_registration_verify(
                &session.access_token,
                &body.challenge_id,
                &body.credential,
            )
            .await?;
        let recovery_codes = self
            .sessions
            .ensure_recovery_codes(&session.profile.user_id)?;
        // Registration creates a credential but does not authenticate it.
        // Initial setup must continue with a passkey-authentication ceremony
        // before accessing the application.  A registration performed from
        // an already verified session remains verified.
        let authenticated = session.mfa_verified && session.mfa_method.is_some();
        session.mfa_verified = authenticated;
        session.mfa_pending_expires_at = (!authenticated)
            .then(|| unix_seconds() + ADMIN_MFA_PENDING_TTL_SECONDS);
        if authenticated {
            session.mfa_method = Some("webauthn".into());
        } else {
            session.mfa_method = None;
        }
        session.updated_at = now_iso();
        self.sessions.put(&identifier, &session)?;
        if authenticated {
            let _ = self
                .sessions
                .touch_presence(&session.profile.user_id, &identifier);
            self.supabase.audit_mfa(&session.profile, "webauthn").await;
        }
        Ok(response_json(
            StatusCode::OK,
            json!({
                "mfaRequired": !authenticated,
                "user": { "id": session.user.id, "email": session.user.email },
                "profile": profile_payload(&session.profile),
                "recoveryCodes": recovery_codes
            }),
        ))
    }

    pub(crate) async fn passkey_authentication_options(&self, request: Request) -> Response {
        match self.passkey_authentication_options_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn passkey_authentication_options_result(
        &self,
        request: Request,
    ) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let headers = request.headers().clone();
        let (_, session) = self.browser_session(headers, false).await?;
        if !is_super_admin(&session.profile.role) {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Verifikasi passkey hanya tersedia untuk administrator.",
            ));
        }
        let challenge = self.supabase.passkey_authentication_options().await?;
        let challenge_id = challenge
            .get("challenge_id")
            .and_then(Value::as_str)
            .filter(|value| valid_uuid(value))
            .ok_or_else(|| {
                NativeError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "invalid_upstream_response",
                    "Challenge autentikasi passkey tidak valid.",
                )
            })?;
        let options = challenge.get("options").cloned().ok_or_else(|| {
            NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_upstream_response",
                "Opsi autentikasi passkey tidak tersedia.",
            )
        })?;
        Ok(response_json(
            StatusCode::OK,
            json!({
                "challenge": {
                    "id": challenge_id,
                    "options": options,
                    "expiresAt": challenge.get("expires_at").cloned().unwrap_or(Value::Null)
                }
            }),
        ))
    }

    pub(crate) async fn passkey_authentication_verify(&self, request: Request) -> Response {
        match self.passkey_authentication_verify_result(request).await {
            Ok(response) => response,
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn passkey_authentication_verify_result(
        &self,
        request: Request,
    ) -> Result<Response, NativeError> {
        self.validate_origin(&request)?;
        let headers = request.headers().clone();
        let body: PasskeyVerifyBody = self.mfa_body(request).await?;
        if !valid_uuid(&body.challenge_id) || !body.credential.is_object() {
            return Err(NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Data verifikasi passkey tidak valid.",
            ));
        }
        let (identifier, mut session) = self.browser_session(headers, false).await?;
        if !is_super_admin(&session.profile.role) {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Verifikasi passkey hanya tersedia untuk administrator.",
            ));
        }
        let verified = self
            .supabase
            .passkey_authentication_verify(&body.challenge_id, &body.credential)
            .await?;
        if verified.user.id != session.profile.user_id {
            self.supabase.logout(&verified.access_token).await;
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "passkey_account_mismatch",
                "Passkey tersebut bukan milik akun administrator yang sedang masuk.",
            ));
        }
        // Passkeys are verified by Supabase's WebAuthn endpoint rather than
        // the TOTP MFA factor API. The resulting JWT may be AAL1 or omit the
        // optional `aal` claim, so local MFA state records the successful
        // ceremony while bearer authorization keeps its strict AAL2 policy.
        let verified_aal = jwt_aal(&verified.access_token);
        if verified.access_token.is_empty()
            || verified_aal
                .as_deref()
                .is_some_and(|aal| !matches!(aal, "aal1" | "aal2"))
        {
            self.supabase.logout(&verified.access_token).await;
            return Err(NativeError::new(
                StatusCode::UNAUTHORIZED,
                "mfa_failed",
                "Verifikasi passkey tidak menghasilkan sesi administrator yang aman.",
            ));
        }
        session.access_token = verified.access_token;
        session.refresh_token = verified.refresh_token;
        session.user = verified.user;
        let recovery_codes = self
            .sessions
            .ensure_recovery_codes(&session.profile.user_id)?;
        session.mfa_verified = true;
        session.mfa_pending_expires_at = None;
        session.mfa_method = Some("webauthn".into());
        session.updated_at = now_iso();
        self.sessions.put(&identifier, &session)?;
        let _ = self
            .sessions
            .touch_presence(&session.profile.user_id, &identifier);
        self.supabase.audit_mfa(&session.profile, "webauthn").await;
        Ok(response_json(
            StatusCode::OK,
            json!({
                "user": { "id": session.user.id, "email": session.user.email },
                "profile": profile_payload(&session.profile),
                "recoveryCodes": recovery_codes
            }),
        ))
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

    pub(crate) async fn presence(&self, request: Request) -> Response {
        if let Err(error_value) = self.validate_origin(&request) {
            return error_value.into_response();
        }
        let headers = request.headers().clone();
        drop(request);
        match self.active_session(headers).await {
            Ok(_) => response_json(
                StatusCode::OK,
                json!({ "online": true, "checkedAt": now_iso() }),
            ),
            Err(error_value) => error_value.into_response(),
        }
    }

    async fn verified_admin(&self, headers: HeaderMap) -> Result<BrowserSession, NativeError> {
        let (_, session) = self.active_session(headers).await?;
        if !is_super_admin(&session.profile.role) || !session.mfa_verified {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Administrasi akun hanya tersedia untuk Administrator terverifikasi.",
            ));
        }
        Ok(session)
    }

    /// Returns only the authorization scope for domain services that expose a
    /// stream over gRPC. The access token and refresh token never cross the
    /// service boundary.
    pub(crate) async fn authorize_scope(
        &self,
        headers: HeaderMap,
    ) -> Result<AccessScope, Response> {
        self.authorize(headers).await.map(|session| session.scope)
    }

    pub(crate) async fn require_verified_admin(&self, headers: HeaderMap) -> Result<(), Response> {
        self.verified_admin(headers)
            .await
            .map(|_| ())
            .map_err(NativeError::into_response)
    }

    async fn account_row(&self, user_id: &str) -> Result<Value, NativeError> {
        if !valid_uuid(user_id) {
            return Err(NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "ID akun tidak valid.",
            ));
        }
        let result = self
            .supabase
            .database
            .get(
                "app_users",
                &[
                    ("user_id".into(), format!("eq.{user_id}")),
                    ("limit".into(), "1".into()),
                ],
                false,
            )
            .await
            .map_err(|error| native_database_error(error, "Akun belum dapat dimuat."))?;
        result
            .value
            .as_array()
            .and_then(|rows| rows.first())
            .cloned()
            .ok_or_else(|| {
                NativeError::new(StatusCode::NOT_FOUND, "not_found", "Akun tidak ditemukan.")
            })
    }

    async fn active_super_admin_count(&self) -> Result<usize, NativeError> {
        let result = self
            .supabase
            .database
            .get(
                "app_users",
                &[
                    ("role".into(), "eq.super_admin".into()),
                    ("active".into(), "eq.true".into()),
                    ("limit".into(), "500".into()),
                ],
                false,
            )
            .await
            .map_err(|error| {
                native_database_error(error, "Administrator aktif belum dapat diperiksa.")
            })?;
        Ok(result.value.as_array().map_or(0, Vec::len))
    }

    pub(crate) async fn create_admin_account(&self, request: Request) -> Response {
        match self.create_admin_account_result(request).await {
            Ok(value) => response_json(StatusCode::CREATED, value),
            Err(error) => error.into_response(),
        }
    }

    async fn create_admin_account_result(&self, request: Request) -> Result<Value, NativeError> {
        self.validate_origin(&request)?;
        let request_id = request_id(&request);
        let headers = request.headers().clone();
        let admin = self.verified_admin(headers).await?;
        let body = validated_admin_account(self.mfa_body(request).await?, true)?;
        if !body.active {
            return Err(NativeError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "Akun undangan baru harus aktif.",
            ));
        }
        let invited = self
            .supabase
            .invite_user(&body.email, &body.username)
            .await?;
        if !valid_uuid(&invited.id) {
            return Err(NativeError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_upstream_response",
                "ID akun undangan tidak valid.",
            ));
        }
        let after = json!({
            "user_id": invited.id,
            "email": body.email,
            "username": body.username,
            "role": body.role,
            "village": body.village,
            "posyandu": body.posyandu,
            "access_mode": body.access_mode,
            "active": true
        });
        if let Err(error) = self
            .supabase
            .database
            .write(
                &Method::POST,
                "app_users",
                &[],
                Some(&after),
                Some("return=representation"),
            )
            .await
        {
            let _ = self.supabase.delete_admin_user(&invited.id).await;
            return Err(native_database_error(
                error,
                "Username atau email sudah digunakan oleh akun lain.",
            ));
        }
        self.supabase
            .audit_account_admin(
                &request_id,
                &admin.profile,
                &invited.id,
                "create",
                None,
                Some(&after),
            )
            .await;
        Ok(json!({
            "created": true,
            "userId": invited.id,
            "message": "Undangan akun berhasil dikirim melalui email."
        }))
    }

    pub(crate) async fn update_admin_account(&self, request: Request, user_id: String) -> Response {
        match self.update_admin_account_result(request, &user_id).await {
            Ok(value) => response_json(StatusCode::OK, value),
            Err(error) => error.into_response(),
        }
    }

    async fn update_admin_account_result(
        &self,
        request: Request,
        user_id: &str,
    ) -> Result<Value, NativeError> {
        self.validate_origin(&request)?;
        let request_id = request_id(&request);
        let headers = request.headers().clone();
        let admin = self.verified_admin(headers).await?;
        if admin.profile.user_id == user_id {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "self_account_protected",
                "Akun Administrator yang sedang digunakan tidak dapat diedit dari halaman ini.",
            ));
        }
        let before = self.account_row(user_id).await?;
        let body = validated_admin_account(self.mfa_body(request).await?, true)?;
        let was_last_admin = before.get("role").and_then(Value::as_str) == Some("super_admin")
            && before
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && (body.role != "super_admin" || !body.active)
            && self.active_super_admin_count().await? <= 1;
        if was_last_admin {
            return Err(NativeError::new(
                StatusCode::CONFLICT,
                "last_admin_protected",
                "Administrator aktif terakhir tidak dapat dinonaktifkan atau diubah rolenya.",
            ));
        }
        let previous_email = before
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let previous_username = before
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.supabase
            .update_admin_user(user_id, &body.email, &body.username)
            .await?;
        let after = json!({
            "email": body.email,
            "username": body.username,
            "role": body.role,
            "village": body.village,
            "posyandu": body.posyandu,
            "access_mode": body.access_mode,
            "active": body.active,
            "updated_at": now_iso()
        });
        if let Err(error) = self
            .supabase
            .database
            .write(
                &Method::PATCH,
                "app_users",
                &[("user_id".into(), format!("eq.{user_id}"))],
                Some(&after),
                Some("return=representation"),
            )
            .await
        {
            let _ = self
                .supabase
                .update_admin_user(user_id, previous_email, previous_username)
                .await;
            return Err(native_database_error(
                error,
                "Username atau email sudah digunakan oleh akun lain.",
            ));
        }
        self.sessions.invalidate_account_sessions(user_id)?;
        self.supabase
            .audit_account_admin(
                &request_id,
                &admin.profile,
                user_id,
                "update",
                Some(&before),
                Some(&after),
            )
            .await;
        Ok(json!({ "updated": true, "userId": user_id }))
    }

    pub(crate) async fn delete_admin_account(&self, request: Request, user_id: String) -> Response {
        match self.delete_admin_account_result(request, &user_id).await {
            Ok(value) => response_json(StatusCode::OK, value),
            Err(error) => error.into_response(),
        }
    }

    async fn delete_admin_account_result(
        &self,
        request: Request,
        user_id: &str,
    ) -> Result<Value, NativeError> {
        self.validate_origin(&request)?;
        let request_id = request_id(&request);
        let headers = request.headers().clone();
        let admin = self.verified_admin(headers).await?;
        if admin.profile.user_id == user_id {
            return Err(NativeError::new(
                StatusCode::FORBIDDEN,
                "self_account_protected",
                "Akun Administrator yang sedang digunakan tidak dapat dihapus.",
            ));
        }
        let before = self.account_row(user_id).await?;
        if before.get("role").and_then(Value::as_str) == Some("super_admin")
            && before
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && self.active_super_admin_count().await? <= 1
        {
            return Err(NativeError::new(
                StatusCode::CONFLICT,
                "last_admin_protected",
                "Administrator aktif terakhir tidak dapat dihapus.",
            ));
        }
        self.sessions.invalidate_account_sessions(user_id)?;
        self.supabase.delete_admin_user(user_id).await?;
        self.supabase
            .database
            .write(
                &Method::DELETE,
                "app_users",
                &[("user_id".into(), format!("eq.{user_id}"))],
                None,
                None,
            )
            .await
            .map_err(|error| native_database_error(error, "Profil akun belum dapat dihapus."))?;
        self.supabase
            .audit_account_admin(
                &request_id,
                &admin.profile,
                user_id,
                "delete",
                Some(&before),
                None,
            )
            .await;
        Ok(json!({ "deleted": true, "userId": user_id }))
    }

    pub(crate) async fn admin_accounts(&self, headers: HeaderMap) -> Result<Value, Response> {
        let session = self
            .verified_admin(headers)
            .await
            .map_err(NativeError::into_response)?;
        let result = self
            .supabase
            .database
            .get(
                "app_users",
                &[
                    ("order".into(), "role.asc,username.asc".into()),
                    ("limit".into(), "500".into()),
                ],
                false,
            )
            .await
            .map_err(|error| {
                native_database_error(error, "Daftar akun belum dapat dimuat.").into_response()
            })?;
        let rows = result.value.as_array().cloned().unwrap_or_default();
        let user_ids = rows
            .iter()
            .filter_map(|row| {
                row.get("user_id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>();
        let presence = self
            .sessions
            .last_seen_by_user(&user_ids)
            .map_err(NativeError::into_response)?;
        let now = unix_seconds();
        let mut online_count = 0_usize;
        let mut active_count = 0_usize;
        let accounts = rows
            .iter()
            .filter_map(|row| {
                let user_id = row.get("user_id")?.as_str()?;
                let active = row.get("active").and_then(Value::as_bool).unwrap_or(false);
                if active {
                    active_count += 1;
                }
                let last_seen = presence.get(user_id).copied();
                let online = account_is_online(active, last_seen, now);
                if online {
                    online_count += 1;
                }
                Some(json!({
                    "userId": user_id,
                    "username": row.get("username").cloned().unwrap_or(Value::Null),
                    "email": row.get("email").cloned().unwrap_or(Value::Null),
                    "role": row.get("role").cloned().unwrap_or(Value::Null),
                    "village": row.get("village").cloned().unwrap_or(Value::Null),
                    "posyandu": row.get("posyandu").cloned().unwrap_or(Value::Null),
                    "active": active,
                    "accessMode": row.get("access_mode").cloned().unwrap_or_else(|| json!("write")),
                    "isCurrentAccount": user_id == session.profile.user_id,
                    "presenceStatus": if online { "online" } else { "offline" },
                    "lastSeenAt": last_seen.and_then(unix_iso),
                    "createdAt": row.get("created_at").cloned().unwrap_or(Value::Null)
                }))
            })
            .collect::<Vec<_>>();
        let total = accounts.len();
        Ok(json!({
            "checkedAt": now_iso(),
            "onlineWindowSeconds": ACCOUNT_ONLINE_WINDOW_SECONDS,
            "access": {
                "role": "super_admin",
                "level": "full",
                "scope": "global",
                "allApplicationData": true,
                "accountMonitoring": true,
                "systemMonitoring": true,
                "auditAccess": true
            },
            "summary": {
                "total": total,
                "active": active_count,
                "online": online_count,
                "offline": total.saturating_sub(online_count)
            },
            "accounts": accounts
        }))
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
                if !session.access_token.is_empty() {
                    // Only revoke the token used by this browser session.
                    // Supabase's default logout scope is `global`, which
                    // would invalidate the same account on every device.
                    self.supabase.logout_local(&session.access_token).await;
                }
                self.sessions
                    .clear_presence(&session.profile.user_id, &identifier);
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
        "posyandu": scope.posyandu,
        "accessMode": scope.access_mode
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
                factors: Vec::new(),
            },
            profile: AccessScope {
                user_id: "user-1".into(),
                email: Some("user@example.test".into()),
                role: "Ahli Gizi".into(),
                desa: None,
                posyandu: None,
                access_mode: "write".into(),
            },
            updated_at: now_iso(),
            mfa_verified: true,
            mfa_pending_expires_at: None,
            mfa_method: None,
            account_revision: 0,
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
    fn recovery_codes_are_one_time_and_not_stored_as_plaintext() {
        let (store, path) = temporary_store();
        let codes = store.ensure_recovery_codes("admin-user").unwrap();
        assert_eq!(codes.len(), ADMIN_RECOVERY_CODE_COUNT);
        let first = codes.first().expect("recovery code");
        let raw = fs::read(&path).expect("sqlite database");
        assert!(
            !raw.windows(first.len())
                .any(|value| value == first.as_bytes())
        );
        assert!(store.consume_recovery_code("admin-user", first).unwrap());
        assert!(!store.consume_recovery_code("admin-user", first).unwrap());
        assert!(
            store
                .ensure_recovery_codes("admin-user")
                .unwrap()
                .is_empty()
        );
        drop(store);
        let _ = fs::remove_file(&path);
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
    fn account_presence_is_hashed_and_can_be_cleared() {
        let (store, path) = temporary_store();
        store
            .touch_presence("account-user-1", "browser-session-1")
            .unwrap();
        let raw = fs::read(&path).expect("sqlite database");
        assert!(
            !raw.windows("account-user-1".len())
                .any(|value| value == b"account-user-1")
        );
        assert!(
            store
                .last_seen_by_user(&["account-user-1".into()])
                .unwrap()
                .contains_key("account-user-1")
        );
        store.clear_presence("account-user-1", "browser-session-1");
        assert!(
            store
                .last_seen_by_user(&["account-user-1".into()])
                .unwrap()
                .is_empty()
        );
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn account_changes_invalidate_existing_sessions_and_presence() {
        let (store, path) = temporary_store();
        assert_eq!(store.account_revision("account-user-1").unwrap(), 0);
        store
            .touch_presence("account-user-1", "browser-session-1")
            .unwrap();
        store.invalidate_account_sessions("account-user-1").unwrap();
        assert_eq!(store.account_revision("account-user-1").unwrap(), 1);
        assert!(
            store
                .last_seen_by_user(&["account-user-1".into()])
                .unwrap()
                .is_empty()
        );
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn account_online_status_uses_three_minute_activity_window() {
        let now = 10_000;
        assert!(account_is_online(true, Some(now), now));
        assert!(account_is_online(
            true,
            Some(now - ACCOUNT_ONLINE_WINDOW_SECONDS),
            now
        ));
        assert!(!account_is_online(
            true,
            Some(now - ACCOUNT_ONLINE_WINDOW_SECONDS - 1),
            now
        ));
        assert!(!account_is_online(false, Some(now), now));
        assert!(!account_is_online(true, None, now));
    }

    #[test]
    fn native_password_hash_verifies_only_the_original_password() {
        let encoded = hash_native_password("Valid-password-123!").expect("argon2id hash");
        assert!(
            encoded.starts_with("$argon2id$")
                && verify_native_password("Valid-password-123!", &encoded)
        );
        assert!(!verify_native_password("wrong-password", &encoded));
        assert!(!verify_native_password(
            "Valid-password-123!",
            "not-a-password-hash"
        ));
    }

    #[test]
    fn native_session_without_supabase_token_never_refreshes() {
        assert!(!session_needs_refresh("", unix_seconds()));
        // A non-empty malformed/expired token still follows the existing
        // refresh policy, while native-only sessions remain Oracle-local.
        assert!(session_needs_refresh("not-a-jwt", unix_seconds()));
    }

    #[test]
    fn validates_profile_scope_rules() {
        assert!(
            validate_profile(
                "u1".into(),
                None,
                "Kader Posyandu".into(),
                Some("Desa".into()),
                Some("Posyandu".into()),
                "write".into()
            )
            .is_ok()
        );
        assert!(
            validate_profile(
                "u1".into(),
                None,
                "Kader Posyandu".into(),
                Some("Desa".into()),
                None,
                "write".into()
            )
            .is_err()
        );
        assert!(
            validate_profile(
                "u1".into(),
                None,
                "Ahli Gizi".into(),
                None,
                None,
                "read".into()
            )
            .is_ok()
        );
        assert!(
            validate_profile(
                "u1".into(),
                None,
                "super_admin".into(),
                None,
                None,
                "read".into()
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
