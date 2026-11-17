mod auth;
mod config;
mod daemon;
mod ipc;
mod native;
mod private;
mod protocol;
mod shell;
mod terminal;

use anyhow::{bail, ensure, Context, Result};
use clap::{Parser, Subcommand};
use private::Paths;
use serde_json::{json, Value};
use std::{
    process::{Command, Stdio},
    time::Duration,
};

#[derive(Parser)]
#[command(version, about = "A local terminal in your browser DevTools console")]
struct Cli {
    #[command(subcommand)]
    command: Option<Action>,
}
#[derive(Subcommand)]
enum Action {
    /// Start, stop, or inspect the daemon.
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },
    /// List or revoke paired clients.
    Client {
        #[command(subcommand)]
        action: ClientAction,
    },
    /// Approve a pending browser enrollment, matching its public request ID.
    Pair { request_id: Option<String> },
    /// Locate or create your user configuration file.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Register the browser extension's connection to the local daemon.
    NativeHost {
        #[command(subcommand)]
        action: NativeAction,
    },
}
#[derive(Subcommand)]
enum DaemonAction {
    /// Start the background daemon.
    Start,
    /// Stop the daemon and terminate its shells.
    Stop,
    /// Run the daemon in the foreground.
    Foreground,
    /// Show daemon status.
    Status,
}
#[derive(Subcommand)]
enum ClientAction {
    /// List paired client IDs, not credentials.
    List,
    /// Revoke a client and disconnect its active native connections.
    Revoke { client_id: String },
}
#[derive(Subcommand)]
enum ConfigAction {
    /// Create config.toml with default settings without overwriting an existing file.
    ///
    /// Creates the per-user configuration directory and writes default settings.
    /// Prints the file path on success. Use "config path" to locate an existing
    /// configuration; existing files are never overwritten.
    Init,
    /// Print the full path to your config.toml file.
    ///
    /// Shows where console-tty reads user settings, even if the file does not
    /// exist. Does not create or modify files. Run "config init" to create the
    /// file with default settings.
    Path,
}
#[derive(Subcommand)]
enum NativeAction {
    /// Register this executable as the browser extension's local connection bridge.
    ///
    /// Creates a Native Messaging manifest for this executable and registers it
    /// for the current user in the selected browser. This lets the extension
    /// launch the local helper and connect to an already-running daemon.
    ///
    /// Run this after loading the unpacked extension. Repeat it if the extension
    /// ID or executable path changes. It does not start the daemon, install a
    /// service, or approve pairing.
    Install {
        /// Extension ID shown on chrome://extensions or edge://extensions.
        extension_id: String,
        /// Browser to register with: chrome, chromium, or edge.
        #[arg(long, default_value = "chrome")]
        browser: String,
    },
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("console-tty: {error:#}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let paths = Paths::discover()?;
    // Chrome supplies this argument when launching the exact executable in the host manifest.
    if let Some(origin) = std::env::args()
        .nth(1)
        .filter(|a| a.starts_with("chrome-extension://"))
    {
        return native::run(paths, origin).await;
    }
    let cli = Cli::parse();
    if let Some(Action::Config { action }) = &cli.command {
        match action {
            ConfigAction::Path => println!("{}", paths.config().display()),
            ConfigAction::Init => {
                paths.prepare()?;
                ensure!(
                    !paths.config().exists(),
                    "configuration already exists; not overwriting {}",
                    paths.config().display()
                );
                private::write(
                    &paths.config(),
                    toml::to_string_pretty(&config::Config::default())?.as_bytes(),
                )?;
                println!("{}", paths.config().display());
            }
        }
        return Ok(());
    }
    paths.prepare()?;
    match cli.command.unwrap_or(Action::Daemon {
        action: DaemonAction::Start,
    }) {
        Action::Daemon { action } => match action {
            DaemonAction::Start => {
                if let Ok(mut connection) = ipc::connect(&paths.endpoint(false)).await {
                    let value = ipc::call(&mut connection, "status", json!({})).await?;
                    ensure!(value["pairing_required"] == true, "the running daemon does not require pairing; stop it and start the updated daemon");
                    println!("Daemon already running: {value}\nRun console.tty.pair() in the browser, then console-tty pair to approve it.");
                    return Ok(());
                }
                config::Config::load(&paths.config())?;
                if start_background(&paths).await? {
                    println!("Daemon ready. Run console.tty.pair() in the page console, then console-tty pair in this terminal.");
                } else {
                    status(&paths).await?;
                    println!("No enrollment approved; use console.tty.pair() and console-tty pair explicitly.");
                }
            }
            DaemonAction::Foreground => {
                private::ordinary()?;
                let config = config::Config::load(&paths.config())?;
                daemon::run(paths, config).await?;
            }
            DaemonAction::Stop => {
                admin(&paths, "stop", json!({})).await?;
                println!("Daemon stopped; its terminal sessions are terminated.");
            }
            DaemonAction::Status => status(&paths).await?,
        },
        Action::Pair { request_id } => approve_pair(&paths, request_id).await?,
        Action::Client { action } => match action {
            ClientAction::List => {
                println!("{}", admin(&paths, "clients", json!({})).await?);
            }
            ClientAction::Revoke { client_id } => {
                admin(&paths, "revoke", json!({ "client_id": client_id })).await?;
                println!("Client revoked. Commands already executed are not undone.");
            }
        },
        Action::NativeHost {
            action:
                NativeAction::Install {
                    extension_id,
                    browser,
                },
        } => native::install(&paths, &extension_id, &browser)?,
        Action::Config { .. } => unreachable!(),
    }
    Ok(())
}
async fn admin(paths: &Paths, kind: &str, params: Value) -> Result<Value> {
    let mut stream = ipc::connect(&paths.endpoint(true))
        .await
        .context("daemon unavailable; run console-tty first")?;
    ipc::call(&mut stream, kind, params).await
}
async fn approve_pair(paths: &Paths, selected: Option<String>) -> Result<()> {
    use std::io::{IsTerminal, Write};
    let pending = admin(paths, "enrollment.pending", json!({})).await?;
    let requests = pending
        .as_array()
        .context("invalid pending-enrollment response")?;
    if requests.is_empty() {
        println!(
            "No pending browser enrollment. Run console.tty.pair() in the page console first."
        );
        return Ok(());
    }
    if let Some(id) = selected {
        ensure!(
            requests.iter().any(|request| request["request_id"] == id),
            "request not found or expired"
        );
        admin(paths, "enrollment.approve", json!({ "request_id": id })).await?;
        println!("Approved browser request {id}.");
        return Ok(());
    }
    println!("Pending browser enrollments (request IDs are not credentials):");
    for request in requests {
        println!(
            "  {}  expires in {}s{}",
            request["request_id"].as_str().unwrap_or("?"),
            request["expires_in"],
            if request["approved"] == true {
                " (approved)"
            } else {
                ""
            }
        );
    }
    println!("Match the ID with the console.tty toolbar tooltip. Page text alone does not prove browser provenance.");
    if !std::io::stdin().is_terminal() {
        println!("To explicitly approve a matching request: console-tty pair REQUEST_ID");
        return Ok(());
    }
    let id = if requests.len() == 1 {
        requests[0]["request_id"].as_str().unwrap().to_string()
    } else {
        print!("Request ID to approve: ");
        std::io::stdout().flush()?;
        let mut id = String::new();
        std::io::stdin().read_line(&mut id)?;
        id.trim().to_string()
    };
    ensure!(
        requests.iter().any(|request| request["request_id"] == id),
        "request not found"
    );
    print!("Approve browser request {id}? [y/N] ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    if !matches!(answer.trim(), "y" | "Y" | "yes" | "YES") {
        println!("Not approved.");
        return Ok(());
    }
    admin(paths, "enrollment.approve", json!({ "request_id": id })).await?;
    println!("Approved browser request {id}.");
    Ok(())
}
pub async fn status(paths: &Paths) -> Result<()> {
    let mut stream = ipc::connect(&paths.endpoint(false))
        .await
        .context("daemon not running")?;
    println!("{}", ipc::call(&mut stream, "status", json!({})).await?);
    Ok(())
}
pub async fn start_background(paths: &Paths) -> Result<bool> {
    if let Ok(mut stream) = ipc::connect(&paths.endpoint(false)).await {
        let value = ipc::call(&mut stream, "status", json!({})).await?;
        ensure!(
            value["pairing_required"] == true,
            "the running daemon does not require pairing; stop it and start the updated daemon"
        );
        return Ok(false);
    }
    let mut command = Command::new(std::env::current_exe()?.canonicalize()?);
    command.args(["daemon", "foreground"]);
    command.stdin(Stdio::null()).stdout(Stdio::null());
    let log_path = paths.root.join("daemon.log");
    if log_path.exists() {
        private::check(&log_path)?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    private::restrict(&log_path)?;
    command.stderr(log);
    command.current_dir(dirs::home_dir().context("no user home directory")?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn()?;
    for _ in 0..150 {
        if let Some(status) = child.try_wait()? {
            bail!(
                "daemon exited ({status}); inspect {} or run console-tty daemon foreground",
                log_path.display()
            );
        }
        if let Ok(mut stream) = ipc::connect(&paths.endpoint(false)).await {
            let value = ipc::call(&mut stream, "status", json!({})).await?;
            ensure!(
                value["pairing_required"] == true,
                "a daemon without mandatory pairing won the startup race"
            );
            if value["pid"].as_u64() == Some(u64::from(child.id())) {
                return Ok(true);
            }
            let _ = child.kill();
            let _ = child.wait();
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill();
    bail!("daemon readiness timeout; inspect {}", log_path.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_service_commands_and_daemon_flag_are_rejected() {
        for args in [
            vec!["console-tty", "service", "install"],
            vec!["console-tty", "service", "uninstall"],
            vec!["console-tty", "daemon", "--service"],
            vec!["console-tty", "daemon", "foreground", "--service"],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
        assert!(matches!(
            Cli::try_parse_from(["console-tty", "daemon", "foreground"])
                .unwrap()
                .command,
            Some(Action::Daemon {
                action: DaemonAction::Foreground
            })
        ));
    }

    #[test]
    fn grouped_commands_require_subcommands_and_reject_flat_legacy_commands() {
        for args in [
            vec!["console-tty", "daemon"],
            vec!["console-tty", "client"],
            vec!["console-tty", "start"],
            vec!["console-tty", "stop"],
            vec!["console-tty", "status"],
            vec!["console-tty", "clients"],
            vec!["console-tty", "revoke", "client-id"],
            vec!["console-tty", "client", "revoke"],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn daemon_and_client_subcommands_route_to_the_requested_actions() {
        let daemon = |name| match Cli::try_parse_from(["console-tty", "daemon", name])
            .unwrap()
            .command
            .unwrap()
        {
            Action::Daemon { action } => action,
            _ => panic!("expected daemon action"),
        };
        assert!(matches!(daemon("start"), DaemonAction::Start));
        assert!(matches!(daemon("stop"), DaemonAction::Stop));
        assert!(matches!(daemon("foreground"), DaemonAction::Foreground));
        assert!(matches!(daemon("status"), DaemonAction::Status));
        assert!(matches!(
            Cli::try_parse_from(["console-tty", "client", "list"])
                .unwrap()
                .command,
            Some(Action::Client {
                action: ClientAction::List
            })
        ));
        match Cli::try_parse_from(["console-tty", "client", "revoke", "test-client"])
            .unwrap()
            .command
        {
            Some(Action::Client {
                action: ClientAction::Revoke { client_id },
            }) => assert_eq!(client_id, "test-client"),
            _ => panic!("expected client revoke action"),
        }
    }
}
