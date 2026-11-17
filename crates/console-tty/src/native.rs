use crate::{
    auth,
    config::Config,
    ipc,
    private::{self, Paths},
    protocol::{self, Request, Response},
};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncWrite, AsyncWriteExt};

pub const HOST: &str = "dev.console_tty";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub extension_id: String,
}
struct PendingEnrollment {
    request_id: String,
    proof: String,
    daemon_id: String,
    expires: Instant,
}
#[derive(Default)]
struct Host {
    connection: Option<ipc::Connection>,
    pending: Option<PendingEnrollment>,
}

fn transport_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<std::io::Error>().is_some()
        || error
            .downcast_ref::<tokio::time::error::Elapsed>()
            .is_some()
}

pub async fn run(paths: Paths, origin: String) -> Result<()> {
    paths.prepare()?;
    let path = paths.root.join("registration.json");
    private::check(&path)
        .context("register the native host with console-tty native-host install EXTENSION_ID")?;
    let registration: Registration = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        origin == format!("chrome-extension://{}/", registration.extension_id),
        "native host origin does not match registered extension"
    );
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    let mut host = Host::default();
    loop {
        let request: Request = match protocol::read_limited(&mut input, 512 * 1024).await {
            Ok(request) => request,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof) =>
            {
                return Ok(())
            }
            Err(error) => return Err(error),
        };
        let id = request.request_id.clone();
        let retry = matches!(request.kind.as_str(), "config.get" | "status")
            .then(|| Request::new(&request.kind, request.params.clone()));
        let mut result = handle(&paths, &mut host, request).await;
        if result.as_ref().is_err_and(transport_error) {
            host.connection = None;
            if let Some(request) = retry {
                result = handle(&paths, &mut host, request).await;
            }
        }
        if result.as_ref().is_err_and(transport_error) {
            host.connection = None;
        }
        send(&mut output, &Response::new(id, result)).await?;
    }
}

fn pending_info(pending: &PendingEnrollment) -> Value {
    json!({ "state": "pending", "request_id": pending.request_id,
        "expires_in": pending.expires.saturating_duration_since(Instant::now()).as_secs() })
}
async fn require_pairing(stream: &mut ipc::Connection) -> Result<()> {
    let status = ipc::call(stream, "status", json!({})).await?;
    ensure!(
        status["pairing_required"] == true,
        "the running daemon does not require pairing; stop it and start the updated console-tty"
    );
    Ok(())
}
async fn begin(paths: &Paths, host: &mut Host) -> Result<Value> {
    if let Some(stream) = &mut host.connection {
        if let Ok(status) = ipc::call(stream, "status", json!({})).await {
            if status["authenticated"] == true {
                return Ok(json!({ "state": "connected" }));
            }
        }
    }
    host.connection = None;
    let mut stream = ipc::connect(&paths.endpoint(false))
        .await
        .context("daemon unavailable; run console-tty daemon start first")?;
    require_pairing(&mut stream).await?;
    let config = ipc::call(&mut stream, "config.get", json!({})).await?;
    if let Some(pending) = &host.pending {
        if pending.expires > Instant::now() && config["daemon_id"] == pending.daemon_id {
            return Ok(pending_info(pending));
        }
    }
    host.pending = None;
    let proof = auth::secret();
    let request = ipc::call(
        &mut stream,
        "enrollment.request",
        json!({ "verifier": auth::verifier(&proof) }),
    )
    .await?;
    let pending = PendingEnrollment {
        request_id: request["request_id"]
            .as_str()
            .context("missing enrollment request ID")?
            .into(),
        daemon_id: config["daemon_id"]
            .as_str()
            .context("missing daemon identity")?
            .into(),
        expires: Instant::now()
            + Duration::from_secs(
                request["expires_in"]
                    .as_u64()
                    .unwrap_or(auth::ENROLLMENT_SECONDS)
                    .min(auth::ENROLLMENT_SECONDS),
            ),
        proof,
    };
    let result = pending_info(&pending);
    host.pending = Some(pending);
    Ok(result)
}

async fn check(paths: &Paths, host: &mut Host) -> Result<Value> {
    let Some(pending) = &host.pending else {
        return Ok(json!({ "state": "none" }));
    };
    if pending.expires <= Instant::now() {
        host.pending = None;
        return Ok(json!({ "state": "expired" }));
    }
    // Each claim uses a fresh channel so polling cannot exhaust the pre-authentication budget.
    let mut stream = ipc::connect(&paths.endpoint(false))
        .await
        .context("daemon unavailable; run console-tty daemon start first")?;
    require_pairing(&mut stream).await?;
    let config = ipc::call(&mut stream, "config.get", json!({})).await?;
    if config["daemon_id"] != pending.daemon_id {
        host.pending = None;
        return Ok(json!({ "state": "expired" }));
    }
    let claimed = ipc::call(
        &mut stream,
        "enrollment.claim",
        json!({ "request_id": pending.request_id, "proof": pending.proof }),
    )
    .await;
    let grant = match claimed {
        Ok(grant) => grant,
        Err(error) => {
            host.pending = None;
            return Err(error);
        }
    };
    if grant["state"] == "pending" {
        return Ok(pending_info(pending));
    }
    host.pending = None;
    let result = complete(&mut stream, grant).await?;
    host.connection = Some(stream);
    Ok(result)
}

async fn complete(stream: &mut ipc::Connection, grant: Value) -> Result<Value> {
    let id = grant["client_id"]
        .as_str()
        .context("missing client identifier")?;
    let token = grant["credential"].as_str().context("missing credential")?;
    ipc::call(
        stream,
        "authenticate",
        json!({ "client_id": id, "credential": token }),
    )
    .await?;
    Ok(
        json!({ "state": "connected", "authenticated": true, "client_id": id,
        "credential": token, "host_id": grant["host_id"] }),
    )
}

async fn handle(paths: &Paths, host: &mut Host, request: Request) -> Result<Value> {
    ensure!(
        request.version == protocol::VERSION,
        "unsupported native protocol"
    );
    ensure!(
        matches!(
            request.kind.as_str(),
            "config.get"
                | "pair.begin"
                | "pair.check"
                | "authenticate"
                | "status"
                | "create"
                | "list"
                | "attach"
                | "input"
                | "key"
                | "text"
                | "paste"
                | "resize"
                | "scroll"
                | "close"
                | "poll"
        ),
        "unsupported native operation"
    );
    if matches!(request.kind.as_str(), "pair.begin" | "pair.check") {
        ensure!(
            request.params.as_object().is_some_and(|p| p.is_empty()),
            "enrollment takes no arguments"
        );
        return if request.kind == "pair.begin" {
            begin(paths, host).await
        } else {
            check(paths, host).await
        };
    }
    if host.connection.is_none() {
        match ipc::connect(&paths.endpoint(false)).await {
            Ok(mut stream) => {
                require_pairing(&mut stream).await?;
                host.connection = Some(stream);
            }
            Err(_) if request.kind == "config.get" => {
                let config = Config::load(&paths.config())
                    .context("invalid or insecure console.tty configuration; run console-tty daemon foreground locally for details")?;
                return Ok(
                    json!({ "schema_version": 1, "revision": config.revision(), "daemon_available": false,
                    "host_id": null, "daemon_id": null, "settings": config.projection() }),
                );
            }
            Err(_) => bail!("daemon unavailable; run console-tty daemon start first"),
        }
    }
    let stream = host.connection.as_mut().unwrap();
    ipc::call(stream, &request.kind, request.params).await
}

async fn send<W: AsyncWrite + Unpin>(output: &mut W, response: &Response) -> Result<()> {
    let bytes = serde_json::to_vec(response)?;
    if bytes.len() < 850_000 {
        return protocol::write(output, response).await;
    }
    ensure!(
        bytes.len() <= protocol::MAX_FRAME,
        "snapshot exceeds bounded native reassembly limit"
    );
    use base64::{engine::general_purpose::STANDARD, Engine};
    let chunks: Vec<_> = bytes.chunks(500_000).collect();
    for (index, chunk) in chunks.iter().enumerate() {
        protocol::write(
            output,
            &json!({ "type": "chunk", "request_id": response.request_id,
            "index": index, "total": chunks.len(), "data": STANDARD.encode(chunk) }),
        )
        .await?;
    }
    output.flush().await?;
    Ok(())
}

pub fn install(paths: &Paths, extension_id: &str, browser: &str) -> Result<()> {
    ensure!(
        extension_id.len() == 32 && extension_id.bytes().all(|c| (b'a'..=b'p').contains(&c)),
        "extension ID must be Chrome's 32-character a-p ID"
    );
    ensure!(
        matches!(browser, "chrome" | "chromium" | "edge"),
        "browser must be chrome, chromium, or edge"
    );
    paths.prepare()?;
    let executable = private::executable()?;
    let manifest = json!({ "name": HOST, "description": "console.tty local terminal bridge", "path": executable,
        "type": "stdio", "allowed_origins": [format!("chrome-extension://{extension_id}/")] });
    #[cfg(windows)]
    {
        let path = paths.root.join("native-host.json");
        private::write(&path, &serde_json::to_vec_pretty(&manifest)?)?;
        let vendor = match browser {
            "edge" => "Microsoft\\Edge",
            "chromium" => "Chromium",
            _ => "Google\\Chrome",
        };
        let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(format!("Software\\{vendor}\\NativeMessagingHosts\\{HOST}"))?
            .0;
        key.set_value("", &path.to_string_lossy().to_string())?;
    }
    #[cfg(unix)]
    {
        let home = dirs::home_dir().context("no home directory")?;
        #[cfg(target_os = "macos")]
        let directory = home.join(match browser {
            "edge" => "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
            "chromium" => "Library/Application Support/Chromium/NativeMessagingHosts",
            _ => "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        });
        #[cfg(not(target_os = "macos"))]
        let directory = {
            let _ = home;
            dirs::config_dir()
                .context("no config directory")?
                .join(match browser {
                    "edge" => "microsoft-edge/NativeMessagingHosts",
                    "chromium" => "chromium/NativeMessagingHosts",
                    _ => "google-chrome/NativeMessagingHosts",
                })
        };
        std::fs::create_dir_all(&directory)?;
        std::fs::write(
            directory.join(format!("{HOST}.json")),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
    }
    private::write(
        &paths.root.join("registration.json"),
        &serde_json::to_vec(&Registration {
            extension_id: extension_id.into(),
        })?,
    )?;
    println!(
        "Registered {HOST} for {browser}, extension {extension_id}.\nNative host: {}",
        executable.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bootstrap_does_not_expose_admin_or_secret_accepting_pair_methods() {
        let paths = Paths {
            root: std::env::temp_dir().join(format!("ct-native-{}", uuid::Uuid::new_v4())),
        };
        paths.prepare().unwrap();
        let mut host = Host::default();
        let config = handle(&paths, &mut host, Request::new("config.get", json!({})))
            .await
            .unwrap();
        assert_eq!(config["daemon_available"], false);
        assert!(config["settings"].get("security").is_none());
        assert!(config["settings"].get("service").is_none());
        assert!(config["settings"]["terminal"].get("cwd").is_none());
        for kind in ["enrollment.request", "enrollment.approve", "pair"] {
            assert!(handle(&paths, &mut host, Request::new(kind, json!({})))
                .await
                .is_err());
        }
        assert!(handle(
            &paths,
            &mut host,
            Request::new("pair.begin", json!({ "proof": "client-chosen" }))
        )
        .await
        .is_err());
        std::fs::remove_dir(paths.root).unwrap();
    }
    #[tokio::test]
    async fn helper_keeps_proof_private_and_claims_only_its_approved_request_on_a_fresh_channel() {
        let paths = Paths {
            root: std::env::temp_dir().join(format!("ct-claim-{}", uuid::Uuid::new_v4().simple())),
        };
        paths.prepare().unwrap();
        let server = tokio::spawn(crate::daemon::run(paths.clone(), Config::default()));
        for _ in 0..100 {
            if ipc::connect(&paths.endpoint(false)).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut host = Host::default();
        for _ in 0..11 {
            handle(&paths, &mut host, Request::new("config.get", json!({})))
                .await
                .unwrap();
        }
        let pending = handle(&paths, &mut host, Request::new("pair.begin", json!({})))
            .await
            .unwrap();
        assert_eq!(pending["state"], "pending");
        assert!(pending.get("proof").is_none() && pending.get("credential").is_none());
        let repeated = handle(&paths, &mut host, Request::new("pair.begin", json!({})))
            .await
            .unwrap();
        assert_eq!(repeated["request_id"], pending["request_id"]);
        assert_eq!(
            handle(&paths, &mut host, Request::new("pair.check", json!({})))
                .await
                .unwrap()["state"],
            "pending"
        );
        let mut other = Host::default();
        assert_eq!(
            handle(&paths, &mut other, Request::new("pair.check", json!({})))
                .await
                .unwrap()["state"],
            "none"
        );
        assert!(handle(
            &paths,
            &mut other,
            Request::new("pair.check", json!({ "request_id": pending["request_id"] }))
        )
        .await
        .is_err());
        let mut admin = ipc::connect(&paths.endpoint(true)).await.unwrap();
        ipc::call(
            &mut admin,
            "enrollment.approve",
            json!({ "request_id": pending["request_id"] }),
        )
        .await
        .unwrap();
        let grant = handle(&paths, &mut host, Request::new("pair.check", json!({})))
            .await
            .unwrap();
        assert_eq!(grant["state"], "connected");
        assert_eq!(
            handle(&paths, &mut host, Request::new("status", json!({})))
                .await
                .unwrap()["authenticated"],
            true
        );
        assert_eq!(
            handle(&paths, &mut host, Request::new("pair.check", json!({})))
                .await
                .unwrap()["state"],
            "none"
        );
        let mut unauthenticated = ipc::connect(&paths.endpoint(false)).await.unwrap();
        assert!(ipc::call(&mut unauthenticated, "list", json!({}))
            .await
            .is_err());
        let mut admin = ipc::connect(&paths.endpoint(true)).await.unwrap();
        ipc::call(&mut admin, "stop", json!({})).await.unwrap();
        server.await.unwrap().unwrap();
        std::fs::remove_dir(paths.root).unwrap();
    }
    #[tokio::test]
    async fn legacy_enrollment_files_cannot_authenticate_a_new_daemon() {
        let paths = Paths {
            root: std::env::temp_dir().join(format!("ct-store-{}", uuid::Uuid::new_v4().simple())),
        };
        paths.prepare().unwrap();
        private::write(&paths.root.join("native-client.json"), b"invalid metadata").unwrap();
        private::write(&paths.root.join("clients.json"), b"invalid legacy clients").unwrap();
        let server = tokio::spawn(crate::daemon::run(paths.clone(), Config::default()));
        for _ in 0..100 {
            if ipc::connect(&paths.endpoint(false)).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut host = Host::default();
        assert_eq!(
            handle(&paths, &mut host, Request::new("config.get", json!({})))
                .await
                .unwrap()["daemon_available"],
            true
        );
        assert_eq!(
            handle(&paths, &mut host, Request::new("status", json!({})))
                .await
                .unwrap()["authenticated"],
            false
        );
        assert!(handle(&paths, &mut host, Request::new("list", json!({})))
            .await
            .is_err());
        let mut admin = ipc::connect(&paths.endpoint(true)).await.unwrap();
        ipc::call(&mut admin, "stop", json!({})).await.unwrap();
        server.await.unwrap().unwrap();
        std::fs::remove_file(paths.root.join("native-client.json")).unwrap();
        std::fs::remove_file(paths.root.join("clients.json")).unwrap();
        std::fs::remove_dir(paths.root).unwrap();
    }

    #[tokio::test]
    async fn helper_rejects_a_daemon_that_bypasses_pairing() {
        let paths = Paths {
            root: std::env::temp_dir()
                .join(format!("ct-no-bypass-{}", uuid::Uuid::new_v4().simple())),
        };
        paths.prepare().unwrap();
        let mut listener = ipc::Listener::bind(&paths.endpoint(false)).unwrap();
        let server = tokio::spawn(async move {
            let mut stream = listener.accept().await.unwrap();
            let request: Request = protocol::read_limited(&mut stream, 8192).await.unwrap();
            assert_eq!(request.kind, "status");
            protocol::write(
                &mut stream,
                &Response::new(
                    request.request_id,
                    Ok(json!({
                        "pairing_required": false, "authenticated": true
                    })),
                ),
            )
            .await
            .unwrap();
        });
        let mut host = Host::default();
        let error = handle(&paths, &mut host, Request::new("config.get", json!({})))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("does not require pairing"));
        assert!(host.connection.is_none());
        server.await.unwrap();
        std::fs::remove_dir(paths.root).unwrap();
    }

    #[tokio::test]
    async fn native_chunks_stay_below_chrome_limit_and_preserve_utf8() {
        let response = Response::new("large".into(), Ok(json!({ "text": "界".repeat(400000) })));
        let expected = serde_json::to_vec(&response).unwrap();
        let (mut output, mut input) = tokio::io::duplex(protocol::MAX_FRAME);
        send(&mut output, &response).await.unwrap();
        let mut joined = Vec::new();
        use base64::{engine::general_purpose::STANDARD, Engine};
        for index in 0..expected.len().div_ceil(500000) {
            let chunk: Value = protocol::read_limited(&mut input, 1024 * 1024)
                .await
                .unwrap();
            assert_eq!(chunk["index"], index);
            joined.extend(STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap());
        }
        assert_eq!(joined, expected);
    }
}
