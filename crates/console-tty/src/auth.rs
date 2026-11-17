use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

pub const ENROLLMENT_SECONDS: u64 = 300;
pub fn secret() -> String {
    let mut bytes = [0; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn verifier(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

struct Pending {
    verifier: [u8; 32],
    expires: Instant,
    approved: bool,
}
#[derive(Clone, Serialize)]
pub struct PendingInfo {
    pub request_id: String,
    pub expires_in: u64,
    pub approved: bool,
}
pub struct Auth {
    pub host_id: String,
    clients: HashMap<String, [u8; 32]>,
    pending: HashMap<String, Pending>,
    requested: VecDeque<Instant>,
}
impl Default for Auth {
    fn default() -> Self {
        Self {
            host_id: uuid::Uuid::new_v4().to_string(),
            clients: HashMap::new(),
            pending: HashMap::new(),
            requested: VecDeque::new(),
        }
    }
}
impl Auth {
    fn prune(&mut self) {
        self.pending
            .retain(|_, pending| pending.expires > Instant::now());
        while self
            .requested
            .front()
            .is_some_and(|time| time.elapsed() >= Duration::from_secs(60))
        {
            self.requested.pop_front();
        }
    }
    fn info(id: &str, pending: &Pending) -> PendingInfo {
        PendingInfo {
            request_id: id.into(),
            expires_in: pending
                .expires
                .saturating_duration_since(Instant::now())
                .as_secs()
                .max(1),
            approved: pending.approved,
        }
    }
    pub fn request(&mut self, hash: [u8; 32]) -> Result<PendingInfo> {
        self.prune();
        if let Some((id, pending)) = self
            .pending
            .iter()
            .find(|(_, p)| bool::from(p.verifier.ct_eq(&hash)))
        {
            return Ok(Self::info(id, pending));
        }
        ensure!(
            self.pending.len() < 8,
            "too many pending enrollments; wait for unused requests to expire"
        );
        ensure!(
            self.requested.len() < 10,
            "enrollment request rate limit; wait one minute"
        );
        let id = loop {
            let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
            if !self.pending.contains_key(&id) {
                break id;
            }
        };
        let pending = Pending {
            verifier: hash,
            expires: Instant::now() + Duration::from_secs(ENROLLMENT_SECONDS),
            approved: false,
        };
        let info = Self::info(&id, &pending);
        self.pending.insert(id, pending);
        self.requested.push_back(Instant::now());
        Ok(info)
    }
    pub fn pending(&mut self) -> Vec<PendingInfo> {
        self.prune();
        let mut requests: Vec<_> = self
            .pending
            .iter()
            .map(|(id, p)| Self::info(id, p))
            .collect();
        requests.sort_by(|a, b| a.request_id.cmp(&b.request_id));
        requests
    }
    pub fn approve(&mut self, id: &str) -> Result<PendingInfo> {
        self.prune();
        let pending = self
            .pending
            .get_mut(id)
            .context("request not found or expired; run console.tty.pair() again")?;
        pending.approved = true;
        Ok(Self::info(id, pending))
    }
    pub fn claim(&mut self, id: &str, proof: &str) -> Result<Option<(String, String)>> {
        self.prune();
        let expected = self.pending.get(id).map(|p| p.verifier).unwrap_or([0; 32]);
        ensure!(
            proof.len() == 43
                && bool::from(expected.ct_eq(&verifier(proof)))
                && self.pending.contains_key(id),
            "enrollment proof invalid or request expired"
        );
        if !self.pending[id].approved {
            return Ok(None);
        }
        ensure!(
            self.clients.len() < 64,
            "client enrollment limit reached; revoke unused clients"
        );
        self.pending.remove(id);
        let client_id = uuid::Uuid::new_v4().to_string();
        let token = secret();
        self.clients.insert(client_id.clone(), verifier(&token));
        Ok(Some((client_id, token)))
    }
    pub fn authenticate(&self, id: &str, token: &str) -> bool {
        let expected = self.clients.get(id).copied().unwrap_or([0; 32]);
        bool::from(expected.ct_eq(&verifier(token)))
            && self.clients.contains_key(id)
            && token.len() == 43
    }
    pub fn active(&self, id: &str) -> bool {
        self.clients.contains_key(id)
    }
    pub fn revoke(&mut self, id: &str) {
        self.clients.remove(id);
    }
    pub fn clients(&self) -> Vec<String> {
        self.clients.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_and_private_proof_are_both_required_and_claim_is_one_use() {
        let mut auth = Auth::default();
        let proof = secret();
        let request = auth.request(verifier(&proof)).unwrap();
        assert_eq!(
            auth.request(verifier(&proof)).unwrap().request_id,
            request.request_id
        );
        assert!(auth.claim(&request.request_id, &proof).unwrap().is_none());
        auth.approve(&request.request_id).unwrap();
        assert!(auth
            .claim(&request.request_id, &request.request_id)
            .is_err());
        assert!(auth.claim(&request.request_id, &secret()).is_err());
        let (id, token) = auth.claim(&request.request_id, &proof).unwrap().unwrap();
        assert!(auth.authenticate(&id, &token));
        assert!(auth.claim(&request.request_id, &proof).is_err());
        assert!(!Auth::default().authenticate(&id, &token));
        auth.revoke(&id);
        assert!(!auth.authenticate(&id, &token));
        let expired = auth.request(verifier(&secret())).unwrap();
        auth.pending.get_mut(&expired.request_id).unwrap().expires =
            Instant::now() - Duration::from_secs(1);
        assert!(auth.approve(&expired.request_id).is_err());
        assert!(auth.pending().is_empty());
        for _ in 0..8 {
            auth.request(verifier(&secret())).unwrap();
        }
        assert!(auth.request(verifier(&secret())).is_err());
    }
}
