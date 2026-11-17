use crate::{
    auth::Auth,
    config::Config,
    ipc,
    private::Paths,
    protocol::{self, Request, Response},
    shell::Shell,
    terminal::Session,
};
use anyhow::{bail, ensure, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, Semaphore};

struct State {
    daemon_id: String,
    config: Config,
    auth: Auth,
    sessions: HashMap<String, Session>,
    starts: VecDeque<Instant>,
    failures: VecDeque<Instant>,
}

#[derive(Default)]
struct Client {
    id: Option<String>,
    connection: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollmentRequest {
    verifier: [u8; 32],
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollmentClaim {
    request_id: String,
    proof: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    client_id: String,
    credential: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    tab: String,
    document: String,
    cols: u16,
    rows: u16,
    #[serde(default)]
    shell: Option<Shell>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    session_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Poll {
    session_id: String,
    revision: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    session_id: String,
    value: String,
    #[serde(default)]
    ctrl: bool,
    #[serde(default)]
    alt: bool,
    #[serde(default)]
    shift: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resize {
    session_id: String,
    cols: u16,
    rows: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scroll {
    session_id: String,
    lines: i32,
    #[serde(default)]
    shift: bool,
    #[serde(default)]
    alt: bool,
}

fn params<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    Ok(serde_json::from_value(value)?)
}
fn trim(queue: &mut VecDeque<Instant>) {
    while queue
        .front()
        .is_some_and(|time| time.elapsed() >= Duration::from_secs(60))
    {
        queue.pop_front();
    }
}
impl State {
    fn config(&self) -> Value {
        json!({ "schema_version": 1, "revision": self.config.revision(), "daemon_available": true,
            "host_id": self.auth.host_id, "daemon_id": self.daemon_id, "settings": self.config.projection() })
    }
    fn request(&mut self, client: &mut Client, request: Request) -> Result<Value> {
        ensure!(
            request.version == protocol::VERSION,
            "unsupported protocol version"
        );
        ensure!(
            !request.request_id.is_empty() && request.request_id.len() <= 100,
            "invalid request ID"
        );
        match request.kind.as_str() {
            "config.get" => return Ok(self.config()),
            "status" => {
                return Ok(
                    json!({ "host_id": self.auth.host_id, "daemon_id": self.daemon_id, "pid": std::process::id(), "pairing_required": true,
                "sessions": self.sessions.len(), "authenticated": client.id.as_ref().is_some_and(|id| self.auth.active(id)) }),
                )
            }
            "enrollment.request" => {
                let p: EnrollmentRequest = params(request.params)?;
                return Ok(serde_json::to_value(self.auth.request(p.verifier)?)?);
            }
            "enrollment.claim" | "authenticate" => {
                trim(&mut self.failures);
                ensure!(
                    self.failures.len() < 30,
                    "authentication failure rate limit; wait one minute"
                );
                let result = if request.kind == "enrollment.claim" {
                    let p: EnrollmentClaim = params(request.params)?;
                    self.auth
                        .claim(&p.request_id, &p.proof)
                        .map(|grant| match grant {
                            Some((id, token)) => json!({ "state": "granted", "client_id": id,
                            "credential": token, "host_id": self.auth.host_id }),
                            None => json!({ "state": "pending", "request_id": p.request_id }),
                        })
                } else {
                    let p: Credentials = params(request.params)?;
                    if self.auth.authenticate(&p.client_id, &p.credential) {
                        client.id = Some(p.client_id);
                        Ok(json!({ "authenticated": true, "host_id": self.auth.host_id }))
                    } else {
                        bail_auth()
                    }
                };
                if result.is_err() {
                    self.failures.push_back(Instant::now());
                }
                return result;
            }
            _ => {}
        }
        let client_id = client.id.clone().filter(|id| self.auth.active(id))
            .ok_or_else(|| anyhow::anyhow!("pairing required; run console.tty.pair() and approve the matching request with console-tty pair"))?;
        match request.kind.as_str() {
            "create" => {
                let p: Create = params(request.params)?;
                let shell = p
                    .shell
                    .or(self.config.terminal.shell)
                    .unwrap_or_else(Shell::user_default);
                ensure!(
                    !p.tab.is_empty()
                        && p.tab.len() <= 100
                        && !p.document.is_empty()
                        && p.document.len() <= 100,
                    "invalid document binding"
                );
                if let Some(session) = self.sessions.values_mut().find(|s| {
                    s.client == client_id
                        && s.tab == p.tab
                        && s.document == p.document
                        && s.shell == shell
                        && s.live()
                }) {
                    session.controller = client.connection.clone();
                    session.scroll(-100000)?;
                    return Ok(
                        json!({ "session_id": session.id, "shell": session.shell, "created": false, "snapshot": session.snapshot()? }),
                    );
                }
                trim(&mut self.starts);
                ensure!(
                    self.starts.len() < self.config.limits.max_start_requests_per_minute,
                    "shell-start rate limit; wait one minute"
                );
                self.starts.push_back(Instant::now());
                if self.sessions.len() >= self.config.limits.max_live_sessions + 16 {
                    if let Some(id) = self
                        .sessions
                        .values()
                        .filter(|s| !s.live())
                        .min_by_key(|s| s.last_snapshot)
                        .map(|s| s.id.clone())
                    {
                        self.sessions.remove(&id);
                    }
                }
                ensure!(
                    self.sessions.values().filter(|s| s.live()).count()
                        < self.config.limits.max_live_sessions,
                    "live-session quota reached; exit an existing shell before starting another"
                );
                ensure!(
                    self.sessions
                        .values()
                        .filter(|s| s.client == client_id && s.tab == p.tab && s.live())
                        .count()
                        < self.config.limits.max_live_sessions_per_tab,
                    "tab session quota reached, including detached sessions"
                );
                let mut session_config = self.config.clone();
                session_config.terminal.shell = Some(shell);
                let session = Session::spawn(
                    &session_config,
                    p.cols,
                    p.rows,
                    p.tab,
                    p.document,
                    client_id,
                    client.connection.clone(),
                )?;
                let result = json!({ "session_id": session.id, "shell": session.shell, "created": true, "snapshot": session.snapshot()? });
                self.sessions.insert(session.id.clone(), session);
                Ok(result)
            }
            "list" => {
                Ok(json!(self.sessions.values().map(|s| json!({
                "session_id": s.id, "label": format!("Shell {}", &s.id[..8]), "live": s.live()
            })).collect::<Vec<_>>()))
            }
            "attach" => {
                let p: Id = params(request.params)?;
                let session = self
                    .sessions
                    .get_mut(&p.session_id)
                    .ok_or_else(|| anyhow::anyhow!("unknown session"))?;
                session.controller = client.connection.clone();
                session.scroll(-100000)?;
                Ok(
                    json!({ "session_id": session.id, "shell": session.shell, "snapshot": session.snapshot()? }),
                )
            }
            "poll" => {
                let p: Poll = params(request.params)?;
                let fps = self.config.render.max_fps;
                let session = self.controlled(&p.session_id, client)?;
                if session.last_snapshot.elapsed() < Duration::from_secs_f64(1.0 / f64::from(fps)) {
                    return Ok(Value::Null);
                }
                session.last_snapshot = Instant::now();
                let snapshot = session.snapshot()?;
                Ok(if snapshot.revision == p.revision {
                    Value::Null
                } else {
                    serde_json::to_value(snapshot)?
                })
            }
            "input" | "text" | "paste" | "key" => {
                let p: Input = params(request.params)?;
                self.controlled(&p.session_id, client)?.input(
                    &request.kind,
                    &p.value,
                    p.ctrl,
                    p.alt,
                    p.shift,
                )?;
                Ok(json!({ "ok": true }))
            }
            "resize" => {
                let p: Resize = params(request.params)?;
                self.controlled(&p.session_id, client)?
                    .resize(p.cols, p.rows)?;
                Ok(json!({ "ok": true }))
            }
            "scroll" => {
                let p: Scroll = params(request.params)?;
                self.controlled(&p.session_id, client)?
                    .wheel(p.lines, p.shift, p.alt)?;
                Ok(json!({ "ok": true }))
            }
            "close" => {
                let p: Id = params(request.params)?;
                self.controlled(&p.session_id, client)?;
                if let Some(mut session) = self.sessions.remove(&p.session_id) {
                    session.close();
                }
                Ok(json!({ "ok": true }))
            }
            _ => bail!("unsupported request"),
        }
    }
    fn controlled(&mut self, id: &str, client: &Client) -> Result<&mut Session> {
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session"))?;
        ensure!(
            session.controller == client.connection,
            "attachment superseded; explicitly reattach this session"
        );
        Ok(session)
    }
}
fn bail_auth() -> Result<Value> {
    bail!("authentication failed; pair again")
}

pub async fn run(paths: Paths, config: Config) -> Result<()> {
    paths.prepare()?;
    let mut listener = ipc::Listener::bind(&paths.endpoint(false))?;
    let mut admin = ipc::Listener::bind(&paths.endpoint(true))?;
    let auth = Auth::default();
    let state = Arc::new(Mutex::new(State {
        daemon_id: uuid::Uuid::new_v4().to_string(),
        config,
        auth,
        sessions: HashMap::new(),
        starts: VecDeque::new(),
        failures: VecDeque::new(),
    }));
    let slots = Arc::new(Semaphore::new(32));
    let admin_slots = Arc::new(Semaphore::new(4));
    let (revocations, _) = broadcast::channel::<String>(64);
    let (shutdown, mut stop) = tokio::sync::mpsc::channel::<()>(1);
    let signal = shutdown_signal();
    tokio::pin!(signal);
    loop {
        tokio::select! {
            stream = listener.accept() => {
                let stream = stream?;
                if let Ok(permit) = slots.clone().try_acquire_owned() {
                    let state = state.clone();
                    let revoked = revocations.subscribe();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let _ = serve(stream, state, revoked).await;
                    });
                }
            },
            stream = admin.accept() => {
                let mut stream = stream?;
                let Ok(permit) = admin_slots.clone().try_acquire_owned() else { continue; };
                let state = state.clone();
                let revoked = revocations.clone();
                let shutdown = shutdown.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let Ok(Ok(request)) = tokio::time::timeout(Duration::from_secs(5), protocol::read_limited::<_, Request>(&mut stream, 8192)).await else { return; };
                    let id = request.request_id.clone();
                    let stopping = request.kind == "stop";
                    let result = tokio::task::spawn_blocking(move || {
                        ensure!(request.version == protocol::VERSION, "unsupported protocol");
                        let mut state = state.lock().unwrap();
                        match request.kind.as_str() {
                            "enrollment.pending" => Ok(serde_json::to_value(state.auth.pending())?),
                            "enrollment.approve" => {
                                let id = request.params["request_id"].as_str().ok_or_else(|| anyhow::anyhow!("request_id required"))?;
                                Ok(serde_json::to_value(state.auth.approve(id)?)?)
                            },
                            "clients" => Ok(json!(state.auth.clients())),
                            "revoke" => {
                                let client = request.params["client_id"].as_str().ok_or_else(|| anyhow::anyhow!("client_id required"))?;
                                state.auth.revoke(client);
                                let _ = revoked.send(client.into());
                                Ok(json!({ "ok": true }))
                            },
                            "stop" => Ok(json!({ "ok": true })),
                            _ => bail!("unsupported administrative action"),
                        }
                    }).await.unwrap_or_else(|_| Err(anyhow::anyhow!("administrative operation failed")));
                    let success = result.is_ok();
                    let _ = protocol::write(&mut stream, &Response::new(id, result)).await;
                    if stopping && success { let _ = shutdown.send(()).await; }
                });
            },
            _ = stop.recv() => break,
            _ = &mut signal => break,
        }
    }
    for session in state.lock().unwrap().sessions.values_mut() {
        session.close();
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    if let Ok(mut terminate) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        tokio::select! { _ = terminate.recv() => {}, _ = ctrl_c => {} }
        return;
    }
    ctrl_c.await;
}

async fn serve(
    mut stream: ipc::Connection,
    state: Arc<Mutex<State>>,
    mut revoked: broadcast::Receiver<String>,
) -> Result<()> {
    let mut client = Client {
        id: None,
        connection: uuid::Uuid::new_v4().to_string(),
    };
    let mut unauthenticated_requests = 0;
    loop {
        let authenticated = client.id.is_some();
        let max = if authenticated { 512 * 1024 } else { 8192 };
        let timeout = if authenticated { 3600 } else { 30 };
        let request = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(timeout), protocol::read_limited::<_, Request>(&mut stream, max)) => result??,
            _ = async {
                loop {
                    match revoked.recv().await {
                        Ok(id) if client.id.as_ref() != Some(&id) => continue,
                        _ => break,
                    }
                }
            } => {
                break;
            }
        };
        if !authenticated {
            unauthenticated_requests += 1;
            ensure!(
                unauthenticated_requests <= 12,
                "too many unauthenticated requests"
            );
        }
        let id = request.request_id.clone();
        let request_state = state.clone();
        let (next_client, result) = tokio::task::spawn_blocking(move || {
            let result = request_state.lock().unwrap().request(&mut client, request);
            (client, result)
        })
        .await?;
        client = next_client;
        protocol::write(&mut stream, &Response::new(id, result)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn private_daemon_pairing_shell_reconnect_resize_revocation() {
        let paths = Paths {
            root: std::env::temp_dir().join(format!("ct-{}", uuid::Uuid::new_v4().simple())),
        };
        paths.prepare().unwrap();
        let daemon_paths = paths.clone();
        let server = tokio::spawn(run(daemon_paths, Config::default()));
        let mut connection = loop {
            if let Ok(c) = ipc::connect(&paths.endpoint(false)).await {
                break c;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        for kind in [
            "create", "list", "attach", "poll", "input", "resize", "scroll", "close",
        ] {
            assert!(ipc::call(&mut connection, kind, json!({}))
                .await
                .unwrap_err()
                .to_string()
                .contains("pairing required"));
        }
        assert!(ipc::call(&mut connection, "config.get", json!({}))
            .await
            .unwrap()["daemon_available"]
            .as_bool()
            .unwrap());
        let mut first = ipc::connect(&paths.endpoint(false)).await.unwrap();
        let mut second = ipc::connect(&paths.endpoint(false)).await.unwrap();
        let proof = crate::auth::secret();
        let pending = ipc::call(
            &mut first,
            "enrollment.request",
            json!({
                "verifier": crate::auth::verifier(&proof)
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            ipc::call(
                &mut first,
                "enrollment.claim",
                json!({
                    "request_id": pending["request_id"], "proof": proof
                })
            )
            .await
            .unwrap()["state"],
            "pending"
        );
        let mut admin = ipc::connect(&paths.endpoint(true)).await.unwrap();
        ipc::call(
            &mut admin,
            "enrollment.approve",
            json!({ "request_id": pending["request_id"] }),
        )
        .await
        .unwrap();
        let (one, two) = tokio::join!(
            ipc::call(
                &mut first,
                "enrollment.claim",
                json!({ "request_id": pending["request_id"], "proof": proof })
            ),
            ipc::call(
                &mut second,
                "enrollment.claim",
                json!({ "request_id": pending["request_id"], "proof": proof })
            )
        );
        assert_ne!(
            one.is_ok(),
            two.is_ok(),
            "concurrent enrollment must succeed exactly once"
        );
        let grant = one.or(two).unwrap();
        drop(first);
        drop(second);
        let credential =
            json!({ "client_id": grant["client_id"], "credential": grant["credential"] });
        // Redeeming does not grant session access until this connection authenticates.
        assert!(ipc::call(&mut connection, "list", json!({})).await.is_err());
        ipc::call(&mut connection, "authenticate", credential.clone())
            .await
            .unwrap();
        let create = json!({ "tab": "test-tab", "document": "test-doc", "cols": 80, "rows": 24 });
        let session = ipc::call(&mut connection, "create", create.clone())
            .await
            .unwrap();
        let id = session["session_id"].as_str().unwrap();
        assert_eq!(
            ipc::call(&mut connection, "create", create).await.unwrap()["session_id"],
            id
        );
        ipc::call(
            &mut connection,
            "input",
            json!({ "session_id": id, "value": "echo CONSOLE_TTY_LIVE_TEST\r" }),
        )
        .await
        .unwrap();
        let mut found = false;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(75)).await;
            let snapshot = ipc::call(
                &mut connection,
                "poll",
                json!({ "session_id": id, "revision": 0 }),
            )
            .await
            .unwrap();
            if let Some(cells) = snapshot["cells"].as_array() {
                let executed = cells.chunks(80).any(|line| {
                    let text: String = line.iter().filter_map(|cell| cell[0].as_str()).collect();
                    text.trim() == "CONSOLE_TTY_LIVE_TEST"
                });
                if executed {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "real shell output not observed");
        for turn in 0..3 {
            let idle = ipc::call(
                &mut connection,
                "poll",
                json!({
                    "session_id": id, "revision": u64::MAX
                }),
            )
            .await
            .unwrap();
            if !idle.is_null() {
                assert!(ipc::call(
                    &mut connection,
                    "poll",
                    json!({
                        "session_id": id, "revision": idle["revision"]
                    })
                )
                .await
                .unwrap()
                .is_null());
            }
            let marker = format!("CTTY_KEYSTROKES_{turn}");
            for character in format!("echo {marker}").chars() {
                ipc::call(
                    &mut connection,
                    "text",
                    json!({
                        "session_id": id, "value": character.to_string()
                    }),
                )
                .await
                .unwrap();
            }
            ipc::call(
                &mut connection,
                "key",
                json!({
                    "session_id": id, "value": "Enter"
                }),
            )
            .await
            .unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    tokio::time::sleep(Duration::from_millis(70)).await;
                    let frame = ipc::call(
                        &mut connection,
                        "poll",
                        json!({
                            "session_id": id, "revision": 0
                        }),
                    )
                    .await
                    .unwrap();
                    if frame["cells"].as_array().is_some_and(|cells| {
                        cells.chunks(80).any(|line| {
                            line.iter()
                                .filter_map(|cell| cell[0].as_str())
                                .collect::<String>()
                                .trim()
                                == marker
                        })
                    }) {
                        break;
                    }
                }
            })
            .await
            .expect("keystrokes must produce shell output promptly after idle polls");
        }
        ipc::call(
            &mut connection,
            "input",
            json!({
                "session_id": id,
                "value": (0..40).map(|i| format!("echo CTTY_HISTORY_{i}\r")).collect::<String>()
            }),
        )
        .await
        .unwrap();
        let live = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame = ipc::call(
                    &mut connection,
                    "poll",
                    json!({
                        "session_id": id, "revision": 0
                    }),
                )
                .await
                .unwrap();
                if frame["scrollback"]["history_lines"].as_u64().unwrap_or(0) >= 20
                    && frame["cells"].as_array().is_some_and(|cells| {
                        cells.chunks(80).any(|line| {
                            line.iter()
                                .filter_map(|cell| cell[0].as_str())
                                .collect::<String>()
                                .trim()
                                == "CTTY_HISTORY_39"
                        })
                    })
                {
                    break frame;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("real PTY output must populate bounded scrollback");
        assert!(ipc::call(
            &mut connection,
            "scroll",
            json!({
                "session_id": id, "lines": 100001
            })
        )
        .await
        .is_err());
        ipc::call(
            &mut connection,
            "scroll",
            json!({ "session_id": id, "lines": 20 }),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let history = ipc::call(
                    &mut connection,
                    "poll",
                    json!({
                        "session_id": id, "revision": 0
                    }),
                )
                .await
                .unwrap();
                if history["scrollback"]["offset"].as_u64().unwrap_or(0) >= 20 {
                    assert_ne!(history["cells"], live["cells"]);
                    assert_eq!(history["cursor"]["visible"], false);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("scroll RPC must return historical PTY cells");
        drop(connection);
        let mut next = ipc::connect(&paths.endpoint(false)).await.unwrap();
        assert!(ipc::call(&mut next, "list", json!({})).await.is_err());
        ipc::call(&mut next, "authenticate", credential)
            .await
            .unwrap();
        assert!(
            ipc::call(&mut next, "scroll", json!({ "session_id": id, "lines": 1 }))
                .await
                .is_err()
        );
        let attached = ipc::call(&mut next, "attach", json!({ "session_id": id }))
            .await
            .unwrap();
        assert_eq!(attached["snapshot"]["scrollback"]["offset"], 0);
        ipc::call(
            &mut next,
            "resize",
            json!({ "session_id": id, "cols": 90, "rows": 25 }),
        )
        .await
        .unwrap();
        let mut admin = ipc::connect(&paths.endpoint(true)).await.unwrap();
        ipc::call(
            &mut admin,
            "revoke",
            json!({ "client_id": grant["client_id"] }),
        )
        .await
        .unwrap();
        assert!(ipc::call(&mut next, "list", json!({})).await.is_err());
        let mut admin = ipc::connect(&paths.endpoint(true)).await.unwrap();
        ipc::call(&mut admin, "stop", json!({})).await.unwrap();
        server.await.unwrap().unwrap();
        let _ = std::fs::remove_dir(&paths.root);
    }

    #[test]
    fn detached_sessions_and_starts_are_bounded_by_backend_policy() {
        let mut config = Config::default();
        config.limits.max_live_sessions = 2;
        config.limits.max_live_sessions_per_tab = 1;
        config.limits.max_start_requests_per_minute = 4;
        let mut state = State {
            daemon_id: "test".into(),
            config,
            auth: Auth::default(),
            sessions: HashMap::new(),
            starts: VecDeque::new(),
            failures: VecDeque::new(),
        };
        let mut client = Client {
            id: None,
            connection: "first".into(),
        };
        for kind in [
            "create", "list", "attach", "poll", "input", "text", "key", "paste", "resize",
            "scroll", "close",
        ] {
            assert!(
                state
                    .request(&mut client, Request::new(kind, json!({})))
                    .unwrap_err()
                    .to_string()
                    .contains("pairing required"),
                "{kind}"
            );
        }
        let proof = crate::auth::secret();
        let pending = state.auth.request(crate::auth::verifier(&proof)).unwrap();
        state.auth.approve(&pending.request_id).unwrap();
        let (id, token) = state
            .auth
            .claim(&pending.request_id, &proof)
            .unwrap()
            .unwrap();
        state
            .request(
                &mut client,
                Request::new(
                    "authenticate",
                    json!({
                        "client_id": id, "credential": token
                    }),
                ),
            )
            .unwrap();
        for shell in ["/bin/bash", "bash -c whoami", "python"] {
            assert!(state.request(&mut client, Request::new("create", json!({
                "tab": "test", "document": "test", "cols": 40, "rows": 10, "shell": shell
            }))).is_err());
        }
        assert!(state.sessions.is_empty() && state.starts.is_empty());
        let make = |tab: &str, doc: &str| {
            Request::new(
                "create",
                json!({ "tab": tab, "document": doc, "cols": 40, "rows": 10 }),
            )
        };
        let session = state.request(&mut client, make("tab", "doc")).unwrap();
        client.connection = "after-browser-disconnect".into();
        let error = state
            .request(&mut client, make("tab", "new-document"))
            .unwrap_err();
        assert!(error.to_string().contains("tab session quota"));
        state
            .request(&mut client, make("other-tab", "doc"))
            .unwrap();
        assert!(state
            .request(&mut client, make("third-tab", "doc"))
            .unwrap_err()
            .to_string()
            .contains("live-session quota"));
        assert!(state
            .request(&mut client, make("fourth-tab", "doc"))
            .unwrap_err()
            .to_string()
            .contains("rate limit"));
        assert!(state
            .request(
                &mut client,
                Request::new(
                    "input",
                    json!({
                        "session_id": session["session_id"], "value": "bad"
                    })
                )
            )
            .unwrap_err()
            .to_string()
            .contains("superseded"));
        state.sessions.clear();
    }
}
