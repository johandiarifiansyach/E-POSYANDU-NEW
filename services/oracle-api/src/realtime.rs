use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::native_auth::AccessScope;

pub const NOTIFY_CHANNEL: &str = "e_posyandu_realtime";
const DEDUPLICATION_WINDOW: Duration = Duration::from_secs(10 * 60);
const CHANNEL_CAPACITY: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeEvent {
    pub id: String,
    pub resource: String,
    pub operation: String,
    pub changed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub village: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posyandu: Option<String>,
}

impl RealtimeEvent {
    pub fn new(
        resource: impl Into<String>,
        operation: impl Into<String>,
        changed_at: impl Into<String>,
        village: Option<String>,
        posyandu: Option<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            resource: resource.into(),
            operation: operation.into(),
            changed_at: changed_at.into(),
            village,
            posyandu,
        }
    }

    pub fn visible_to(&self, scope: &AccessScope) -> bool {
        if matches!(scope.role.as_str(), "Ahli Gizi" | "super_admin") {
            return true;
        }
        match scope.role.as_str() {
            "Kader Posyandu" => self.village == scope.desa && self.posyandu == scope.posyandu,
            "Bidan Desa" => self.village == scope.desa,
            _ => false,
        }
    }

    pub fn public_payload(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "resource": self.resource,
            "operation": self.operation,
            "changedAt": self.changed_at,
        })
    }
}

#[derive(Clone)]
pub struct RealtimeHub {
    sender: broadcast::Sender<RealtimeEvent>,
    seen: Arc<Mutex<HashMap<String, Instant>>>,
}

impl RealtimeHub {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            sender,
            seen: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RealtimeEvent> {
        self.sender.subscribe()
    }

    pub fn publish(&self, event: RealtimeEvent) {
        let now = Instant::now();
        let should_publish = self
            .seen
            .lock()
            .map(|mut seen| {
                seen.retain(|_, timestamp| now.duration_since(*timestamp) < DEDUPLICATION_WINDOW);
                if seen.contains_key(&event.id) {
                    false
                } else {
                    if seen.len() >= CHANNEL_CAPACITY * 8 {
                        if let Some(oldest) = seen
                            .iter()
                            .min_by_key(|(_, timestamp)| *timestamp)
                            .map(|(id, _)| id.clone())
                        {
                            seen.remove(&oldest);
                        }
                    }
                    seen.insert(event.id.clone(), now);
                    true
                }
            })
            .unwrap_or(true);
        if should_publish {
            let _ = self.sender.send(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(role: &str, village: Option<&str>, posyandu: Option<&str>) -> AccessScope {
        AccessScope {
            user_id: "user-1".into(),
            email: None,
            role: role.into(),
            desa: village.map(str::to_owned),
            posyandu: posyandu.map(str::to_owned),
            access_mode: "read".into(),
        }
    }

    #[test]
    fn event_visibility_respects_account_scope() {
        let event = RealtimeEvent::new(
            "children",
            "update",
            "2026-08-26T00:00:00Z",
            Some("Gumukmas".into()),
            Some("Melati".into()),
        );
        assert!(event.visible_to(&scope("Kader Posyandu", Some("Gumukmas"), Some("Melati"))));
        assert!(!event.visible_to(&scope("Kader Posyandu", Some("Gumukmas"), Some("Mawar"))));
        assert!(event.visible_to(&scope("Bidan Desa", Some("Gumukmas"), None)));
        assert!(event.visible_to(&scope("super_admin", None, None)));
    }

    #[test]
    fn public_payload_does_not_include_location_scope() {
        let event = RealtimeEvent::new(
            "measurements",
            "create",
            "2026-08-26T00:00:00Z",
            Some("Gumukmas".into()),
            Some("Melati".into()),
        );
        let payload = event.public_payload();
        assert!(payload.get("changedAt").is_some());
        assert!(payload.get("village").is_none());
        assert!(payload.get("posyandu").is_none());
    }
}
