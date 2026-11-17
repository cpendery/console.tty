use crate::config::{self, Config};
use crate::shell::{self, Shell};
use anyhow::{ensure, Context, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Instant,
};

mod engine;
use engine::{Model, Scroll};

// [grapheme, display width (0 = continuation), foreground RGB, background RGB, style flags]
#[derive(Serialize)]
pub struct Cell(pub String, pub u8, pub u32, pub u32, pub u8);
#[derive(Serialize)]
pub struct Snapshot {
    pub session_id: String,
    pub revision: u64,
    pub cols: u16,
    pub rows: u16,
    pub cells: Vec<Cell>,
    pub cursor: Cursor,
    pub alternate_screen: bool,
    pub scrollback: Scrollback,
    pub exited: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Serialize)]
pub struct Scrollback {
    pub offset: usize,
    pub history_lines: usize,
}
#[derive(Serialize)]
pub struct Cursor {
    pub x: usize,
    pub y: usize,
    pub visible: bool,
    pub shape: String,
}

pub struct Session {
    pub id: String,
    pub tab: String,
    pub document: String,
    pub client: String,
    pub controller: String,
    pub shell: Shell,
    pub last_snapshot: Instant,
    model: Arc<Mutex<Model>>,
    writer: std::sync::mpsc::SyncSender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    closed: bool,
    waiter: Option<std::thread::JoinHandle<()>>,
    #[cfg(unix)]
    pid: Option<u32>,
    #[cfg(windows)]
    job: Arc<Job>,
}
impl Session {
    pub fn spawn(
        config: &Config,
        cols: u16,
        rows: u16,
        tab: String,
        document: String,
        client: String,
        controller: String,
    ) -> Result<Self> {
        config::dimensions(cols, rows)?;
        let shell = config.terminal.shell.unwrap_or_else(Shell::user_default);
        let executable = shell.resolve()?;
        let cwd = shell::starting_directory(config.terminal.cwd.as_ref())?;
        let model = Arc::new(Mutex::new(Model::new(
            cols,
            rows,
            config.terminal.scrollback_lines,
        )?));
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let mut command = CommandBuilder::new(executable);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = pair
            .slave
            .spawn_command(command)
            .context("failed to start configured shell")?;
        drop(pair.slave);
        #[cfg(unix)]
        let pid = child.process_id();
        #[cfg(windows)]
        let job = match Job::attach(
            child
                .as_raw_handle()
                .context("missing PTY child process handle")?,
        ) {
            Ok(job) => Arc::new(job),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let killer = child.clone_killer();
        let (write_tx, write_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(32);
        let reply_tx = write_tx.clone();
        let mut read_killer = child.clone_killer();
        let mut write_killer = child.clone_killer();
        let write_model = model.clone();
        std::thread::spawn(move || {
            for bytes in write_rx {
                if writer
                    .write_all(&bytes)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    write_model.lock().unwrap().error =
                        Some("PTY input/output channel closed".into());
                    let _ = write_killer.kill();
                    break;
                }
            }
        });
        let read_model = model.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let mut state = read_model.lock().unwrap();
                let replies = match state.advance(&buffer[..n]) {
                    Ok(replies) => replies,
                    Err(error) => {
                        state.error = Some(format!("Terminal processing failed: {error}"));
                        let _ = read_killer.kill();
                        break;
                    }
                };
                if !replies.is_empty() && reply_tx.try_send(replies).is_err() {
                    state.error = Some("PTY write queue full; terminal closed".into());
                    let _ = read_killer.kill();
                    break;
                }
            }
            let mut state = read_model.lock().unwrap();
            state.drained = true;
            state.revision += 1;
        });
        let exit_model = model.clone();
        #[cfg(windows)]
        let exit_job = job.clone();
        let waiter = std::thread::spawn(move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            #[cfg(windows)]
            exit_job.terminate();
            #[cfg(unix)]
            if let Some(pid) = pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let mut state = exit_model.lock().unwrap();
            state.exit = Some(code);
            state.revision += 1;
        });
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            tab,
            document,
            client,
            controller,
            shell,
            last_snapshot: Instant::now() - std::time::Duration::from_secs(1),
            model,
            writer: write_tx,
            master: pair.master,
            killer,
            closed: false,
            waiter: Some(waiter),
            #[cfg(unix)]
            pid,
            #[cfg(windows)]
            job,
        })
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.model.lock().unwrap().snapshot(&self.id)
    }
    pub fn input(
        &mut self,
        kind: &str,
        value: &str,
        ctrl: bool,
        alt: bool,
        shift: bool,
    ) -> Result<()> {
        let mut model = self.model.lock().unwrap();
        ensure!(model.exit.is_none(), "session has exited");
        let Some(bytes) = model.prepare_input(kind, value, ctrl, alt, shift)? else {
            return Ok(());
        };
        self.writer.try_send(bytes).map_err(|_| {
            anyhow::anyhow!("PTY input queue is full or closed; input was not accepted")
        })?;
        Ok(())
    }
    pub fn scroll(&mut self, lines: i32) -> Result<()> {
        ensure!(
            (-100000..=100000).contains(&lines),
            "scroll delta must be between -100000 and 100000 lines"
        );
        self.model.lock().unwrap().scroll(Scroll::Delta(lines))
    }
    pub fn wheel(&mut self, lines: i32, shift: bool, alt: bool) -> Result<()> {
        let mut model = self.model.lock().unwrap();
        let Some(bytes) = model.wheel(lines, shift, alt)? else {
            return Ok(());
        };
        ensure!(model.exit.is_none(), "session has exited");
        self.writer.try_send(bytes).map_err(|_| {
            anyhow::anyhow!("PTY input queue is full or closed; input was not accepted")
        })?;
        Ok(())
    }
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        config::dimensions(cols, rows)?;
        let mut model = self.model.lock().unwrap();
        self.master.resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let replies = model.resize(cols, rows)?;
        if !replies.is_empty() && self.writer.try_send(replies).is_err() {
            model.error = Some("PTY write queue full; terminal closed".into());
            model.revision += 1;
            let _ = self.killer.kill();
            anyhow::bail!("PTY write queue full; terminal closed");
        }
        Ok(())
    }
    pub fn live(&self) -> bool {
        let model = self.model.lock().unwrap();
        model.exit.is_none() || !model.drained
    }
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        #[cfg(unix)]
        if let Some(pid) = self
            .pid
            .filter(|_| self.model.lock().unwrap().exit.is_none())
        {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        self.job.terminate();
        let _ = self.killer.kill();
        if let Some(waiter) = self.waiter.take() {
            let _ = waiter.join();
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
// Job handles are process-wide kernel objects, with no thread-affine operations.
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}
#[cfg(windows)]
impl Job {
    fn attach(process: std::os::windows::io::RawHandle) -> Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            ensure!(!handle.is_null(), "cannot create terminal process job");
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            ensure!(
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32
                ) != 0,
                "cannot configure terminal process job"
            );
            ensure!(
                AssignProcessToJobObject(handle, process) != 0,
                "cannot contain terminal process in a user job"
            );
            Ok(job)
        }
    }
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::engine::palette;
    use super::*;
    #[test]
    fn scrollback_snapshots_preserve_cells_anchor_on_output_and_return_live_on_input() {
        let mut model = Model::new(20, 3, 5).unwrap();
        model
            .advance("\x1b[31mA界e\u{301}\x1b[0m\r\none\r\ntwo\r\nthree\r\n".as_bytes())
            .unwrap();
        assert!(model.snapshot("history").unwrap().scrollback.history_lines > 0);
        model.scroll(Scroll::Top).unwrap();
        let old = model.snapshot("history").unwrap();
        assert!(old.scrollback.offset > 0);
        assert!(!old.cursor.visible);
        assert_eq!(old.cells[0].0, "A");
        assert_eq!(old.cells[0].2, palette(1));
        assert_eq!(old.cells[1].1, 2);
        assert_eq!(old.cells[3].0, "e\u{301}");
        let text: String = old.cells.iter().map(|cell| cell.0.as_str()).collect();
        model.advance(b"four\r\n").unwrap();
        let anchored = model.snapshot("history").unwrap();
        assert_eq!(
            anchored
                .cells
                .iter()
                .map(|cell| cell.0.as_str())
                .collect::<String>(),
            text
        );
        assert_eq!(anchored.scrollback.offset, old.scrollback.offset + 1);
        assert!(!model.advance(b"\x1b[6n").unwrap().is_empty());
        assert_eq!(
            model.snapshot("history").unwrap().scrollback.offset,
            anchored.scrollback.offset
        );
        assert_eq!(
            model
                .prepare_input("text", "x", false, false, false)
                .unwrap(),
            Some(b"x".to_vec())
        );
        assert_eq!(model.snapshot("history").unwrap().scrollback.offset, 0);
        for _ in 0..20 {
            model.advance(b"more\r\n").unwrap();
        }
        model.scroll(Scroll::Top).unwrap();
        assert_eq!(
            model.snapshot("history").unwrap().scrollback.history_lines,
            5
        );
        assert_eq!(model.snapshot("history").unwrap().scrollback.offset, 5);
        assert!(model.advance(b"").unwrap().is_empty());
    }

    #[test]
    fn history_keys_do_not_enter_the_pty_but_alternate_screen_keys_do() {
        let mut model = Model::new(20, 3, 10).unwrap();
        for _ in 0..8 {
            model.advance(b"line\r\n").unwrap();
        }
        assert!(model
            .prepare_input("key", "PageUp", false, false, true)
            .unwrap()
            .is_none());
        assert!(model.snapshot("history").unwrap().scrollback.offset > 0);
        assert!(model
            .prepare_input("key", "End", false, false, true)
            .unwrap()
            .is_none());
        assert_eq!(model.snapshot("history").unwrap().scrollback.offset, 0);
        model.advance(b"\x1b[?1049happlication").unwrap();
        model.scroll(Scroll::Top).unwrap();
        assert_eq!(model.snapshot("history").unwrap().scrollback.offset, 0);
        assert_eq!(
            model
                .prepare_input("key", "PageUp", false, false, true)
                .unwrap(),
            Some(b"\x1b[5;2~".to_vec())
        );
        model.advance(b"\x1b[?1049l").unwrap();
        model.scroll(Scroll::Top).unwrap();
        assert!(model.snapshot("history").unwrap().scrollback.offset > 0);
        model.resize(16, 4).unwrap();
        let resized = model.snapshot("history").unwrap();
        assert_eq!(resized.cells.len(), 64);
        assert!(resized.scrollback.offset <= resized.scrollback.history_lines);
        let mut disabled = Model::new(20, 3, 0).unwrap();
        for _ in 0..8 {
            disabled.advance(b"line\r\n").unwrap();
        }
        disabled.scroll(Scroll::Top).unwrap();
        assert_eq!(
            disabled
                .snapshot("history")
                .unwrap()
                .scrollback
                .history_lines,
            0
        );
        assert_eq!(disabled.snapshot("history").unwrap().scrollback.offset, 0);
    }

    #[test]
    fn wheel_routes_to_app_mouse_protocols_and_shift_overrides_to_history() {
        for tracking in [1000, 1002, 1003] {
            let mut model = Model::new(20, 4, 10).unwrap();
            for _ in 0..8 {
                model.advance(b"line\r\n").unwrap();
            }
            model
                .advance(format!("\x1b[?{tracking}h\x1b[?1006h").as_bytes())
                .unwrap();
            assert_eq!(
                model.wheel(2, false, false).unwrap(),
                Some(b"\x1b[<64;11;3M\x1b[<64;11;3M".to_vec())
            );
            assert_eq!(model.snapshot("app").unwrap().scrollback.offset, 0);
            assert!(model.wheel(2, true, false).unwrap().is_none());
            assert_eq!(model.snapshot("app").unwrap().scrollback.offset, 2);
            assert_eq!(
                model.wheel(-1, false, true).unwrap(),
                Some(b"\x1b[<73;11;3M".to_vec())
            );
            assert_eq!(model.snapshot("app").unwrap().scrollback.offset, 0);
            model
                .advance(format!("\x1b[?{tracking}l").as_bytes())
                .unwrap();
            assert!(model.wheel(1, false, false).unwrap().is_none());
            assert_eq!(model.snapshot("app").unwrap().scrollback.offset, 1);
        }
        let mut model = Model::new(240, 4, 0).unwrap();
        model.advance(b"\x1b[?1000h").unwrap();
        assert_eq!(
            model.wheel(1, false, false).unwrap(),
            Some(vec![27, b'[', b'M', 96, 153, 35])
        );
        model.advance(b"\x1b[?1005h").unwrap();
        assert_eq!(
            model.wheel(-1, false, false).unwrap(),
            Some("\x1b[Ma\u{99}#".as_bytes().to_vec())
        );
        assert!(model.wheel(100000, false, false).is_err());
        assert!(model.wheel(100001, false, false).is_err());
    }

    #[test]
    fn alternate_scroll_uses_application_arrows_unless_mouse_reporting_or_shift_takes_precedence() {
        let mut model = Model::new(20, 4, 10).unwrap();
        for _ in 0..8 {
            model.advance(b"line\r\n").unwrap();
        }
        model.advance(b"\x1b[?1049h").unwrap();
        assert_eq!(model.snapshot("app").unwrap().scrollback.history_lines, 0);
        assert_eq!(
            model.wheel(1, false, false).unwrap(),
            Some(b"\x1b[A".to_vec())
        );
        model.advance(b"\x1b[?1h").unwrap();
        assert_eq!(
            model.wheel(-2, false, false).unwrap(),
            Some(b"\x1bOB\x1bOB".to_vec())
        );
        model.advance(b"\x1b[?1000h\x1b[?1006h").unwrap();
        assert_eq!(
            model.wheel(1, false, false).unwrap(),
            Some(b"\x1b[<64;11;3M".to_vec())
        );
        assert!(model.wheel(1, true, false).unwrap().is_none());
        model.advance(b"\x1b[?1000l\x1b[?1007l").unwrap();
        assert!(model.wheel(1, false, false).unwrap().is_none());
        model.advance(b"\x1b[?1049l").unwrap();
        assert!(model.wheel(2, false, false).unwrap().is_none());
        assert_eq!(model.snapshot("shell").unwrap().scrollback.offset, 2);
    }

    #[test]
    fn real_pty_app_receives_wheel_then_restores_terminal_history_scrolling() {
        if !std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
        {
            return;
        }
        let mut config = Config::default();
        config.terminal.shell = Some(if cfg!(windows) { Shell::Cmd } else { Shell::Sh });
        let mut session = Session::spawn(
            &config,
            60,
            8,
            "wheel".into(),
            "fixture".into(),
            "client".into(),
            "controller".into(),
        )
        .unwrap();
        let script = r"process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[HAPP_MOUSE_READY');process.stdin.on('data',d=>{const s=d.toString();if(s.includes('[<64;'))process.stdout.write('\x1b[2;1HAPP_WHEEL_UP');if(s.includes('[<65;'))process.stdout.write('\x1b[3;1HAPP_WHEEL_DOWN');if(s.includes('t')){process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1049l\r\n');for(let i=0;i<40;i++)process.stdout.write('APP_HISTORY_'+i+'\r\n');}});";
        session
            .input(
                "input",
                &format!("node -e \"{script}\"\r"),
                false,
                false,
                false,
            )
            .unwrap();
        let wait_for = |session: &Session, marker: &str, alternate: bool| {
            let until = Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let snapshot = session.snapshot().unwrap();
                if snapshot.alternate_screen == alternate
                    && snapshot.cells.chunks(60).any(|line| {
                        line.iter()
                            .map(|cell| cell.0.as_str())
                            .collect::<String>()
                            .trim()
                            == marker
                    })
                {
                    break snapshot;
                }
                assert!(
                    Instant::now() < until,
                    "PTY fixture did not produce {marker}"
                );
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        };
        wait_for(&session, "APP_MOUSE_READY", true);
        session.wheel(1, false, false).unwrap();
        wait_for(&session, "APP_WHEEL_UP", true);
        session.wheel(-1, false, false).unwrap();
        wait_for(&session, "APP_WHEEL_DOWN", true);
        session.input("text", "t", false, false, false).unwrap();
        let live = wait_for(&session, "APP_HISTORY_39", false);
        assert!(live.scrollback.history_lines > 2);
        session.wheel(2, false, false).unwrap();
        let history = session.snapshot().unwrap();
        assert_eq!(history.scrollback.offset, 2);
        assert_ne!(
            history
                .cells
                .iter()
                .map(|cell| cell.0.as_str())
                .collect::<String>(),
            live.cells
                .iter()
                .map(|cell| cell.0.as_str())
                .collect::<String>()
        );
        session.close();
    }

    #[test]
    fn installed_named_shells_accept_interactive_input() {
        for shell in [Shell::Nu, Shell::Bash, Shell::Pwsh] {
            if shell.resolve().is_err() {
                continue;
            }
            let mut config = Config::default();
            config.terminal.shell = Some(shell);
            let mut session = Session::spawn(
                &config,
                100,
                24,
                "shell-test".into(),
                shell.name().into(),
                "client".into(),
                "controller".into(),
            )
            .unwrap();
            let marker = format!("CTTY_{}_INTERACTIVE", shell.name().to_ascii_uppercase());
            let command = match shell {
                Shell::Nu => format!("print '{marker}'\r"),
                Shell::Bash => format!("printf '{marker}\\n'\r"),
                Shell::Pwsh => format!("Write-Output '{marker}'\r"),
                _ => unreachable!(),
            };
            session
                .input("input", &command, false, false, false)
                .unwrap();
            let until = Instant::now() + std::time::Duration::from_secs(8);
            let mut found = false;
            while Instant::now() < until {
                let snapshot = session.snapshot().unwrap();
                if snapshot.cells.chunks(100).any(|line| {
                    line.iter()
                        .map(|cell| cell.0.as_str())
                        .collect::<String>()
                        .trim()
                        == marker
                }) {
                    found = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            session.close();
            assert!(found, "{} did not execute interactive input", shell.name());
        }
    }

    #[test]
    fn named_shell_starts_in_the_configured_directory() {
        let cwd = std::env::temp_dir().join(format!("ctty-cwd-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&cwd).unwrap();
        let mut config = Config::default();
        config.terminal.cwd = Some(cwd.clone());
        config.terminal.shell = Some(if cfg!(windows) { Shell::Cmd } else { Shell::Sh });
        let mut session = Session::spawn(
            &config,
            100,
            20,
            "tab".into(),
            "doc".into(),
            "client".into(),
            "controller".into(),
        )
        .unwrap();
        session
            .input(
                "input",
                if cfg!(windows) { "cd\r" } else { "pwd\r" },
                false,
                false,
                false,
            )
            .unwrap();
        let marker = cwd.file_name().unwrap().to_string_lossy();
        let until = Instant::now() + std::time::Duration::from_secs(3);
        let mut found = false;
        while Instant::now() < until {
            let text: String = session
                .snapshot()
                .unwrap()
                .cells
                .into_iter()
                .map(|cell| cell.0)
                .collect();
            if text.contains(marker.as_ref()) {
                found = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        session.close();
        drop(session);
        std::fs::remove_dir(cwd).unwrap();
        assert!(found, "the configured directory must reach the real shell");
    }

    #[test]
    fn emulator_preserves_utf8_styles_wide_cells_and_alternate_screen() {
        let mut m = Model::new(20, 4, 20).unwrap();
        let bytes = "\x1b[31mA界e\u{301}".as_bytes();
        for byte in bytes {
            m.advance(&[*byte]).unwrap();
        }
        let s = m.snapshot("test").unwrap();
        assert_eq!(s.cells[0].0, "A");
        assert_eq!(s.cells[0].2, palette(1));
        assert_eq!(s.cells[1].1, 2);
        assert_eq!(s.cells[2].1, 0);
        assert_eq!(s.cells[3].0, "e\u{301}");
        m.advance(b"\x1b[?1049hOTHER").unwrap();
        assert!(m.snapshot("test").unwrap().alternate_screen);
        m.advance(b"\x1b[?1049l").unwrap();
        assert_eq!(m.snapshot("test").unwrap().cells[0].0, "A");
    }
    #[test]
    fn replies_and_mode_aware_input_work_without_browser() {
        let mut m = Model::new(20, 4, 20).unwrap();
        assert!(!m.advance(b"\x1b[6n").unwrap().is_empty());
        assert_eq!(
            m.encode("key", "ArrowUp", false, false, false).unwrap(),
            b"\x1b[A"
        );
        m.advance(b"\x1b[?1h\x1b[?2004h").unwrap();
        assert_eq!(
            m.encode("key", "ArrowUp", false, false, false).unwrap(),
            b"\x1bOA"
        );
        assert_eq!(
            m.encode("paste", "hello", false, false, false).unwrap(),
            b"\x1b[200~hello\x1b[201~"
        );
        assert_eq!(m.encode("key", "c", true, false, false).unwrap(), b"\x03");
        assert_eq!(
            m.encode("key", "Enter", false, false, false).unwrap(),
            b"\r"
        );
        assert!(m.encode("key", "9", true, false, true).is_err());
    }

    #[test]
    fn ghostty_callbacks_answer_geometry_and_colors_without_clipboard_access() {
        let mut model = Model::new(20, 4, 20).unwrap();
        let replies = model
            .advance(b"\x1b[c\x1b[18t\x1b[16t\x1b]4;1;?\x1b\\")
            .unwrap();
        let replies = String::from_utf8(replies).unwrap();
        assert!(replies.contains("\x1b[?62;22c"));
        assert!(replies.contains("\x1b[8;4;20t"));
        assert!(replies.contains("\x1b[6;16;8t"));
        assert!(replies.contains("rgb:cccc/6666/6666"));
        model.resize(42, 8).unwrap();
        assert_eq!(model.advance(b"\x1b[18t").unwrap(), b"\x1b[8;8;42t");
        assert!(model.advance(b"\x1b]52;c;c2VjcmV0\x07").unwrap().is_empty());
        assert!(model.advance(&b"\x1b[6n".repeat(20000)).is_err());
    }

    #[test]
    fn ghostty_keyboard_encoding_preserves_controls_and_tracks_kitty_modes() {
        let mut model = Model::new(20, 4, 20).unwrap();
        for (key, expected) in [
            ("c", 3),
            ("F", 6),
            ("i", 9),
            ("m", 13),
            ("@", 0),
            (" ", 0),
            ("[", 27),
            ("\\", 28),
            ("]", 29),
            ("^", 30),
            ("_", 31),
        ] {
            assert_eq!(
                model.encode("key", key, true, false, false).unwrap(),
                [expected],
                "{key}"
            );
        }
        assert_eq!(
            model.encode("key", "x", false, true, false).unwrap(),
            b"\x1bx"
        );
        assert_eq!(
            model
                .encode("key", "Backspace", true, false, false)
                .unwrap(),
            b"\x08"
        );
        model.advance(b"\x1b[>1u").unwrap();
        assert_eq!(
            model.encode("key", "c", true, false, false).unwrap(),
            b"\x1b[99;5u"
        );
        for (key, code) in [("i", 105), ("m", 109), ("[", 91)] {
            assert_eq!(
                model.encode("key", key, true, false, false).unwrap(),
                format!("\x1b[{code};5u").as_bytes()
            );
        }
        model.advance(b"\x1b[<u").unwrap();
        assert_eq!(
            model.encode("key", "c", true, false, false).unwrap(),
            b"\x03"
        );
    }

    #[test]
    fn ghostty_screen_switches_preserve_live_follow_with_coalesced_output() {
        for mode in [47, 1047, 1049] {
            let mut model = Model::new(20, 3, 10).unwrap();
            model
                .advance(format!("\x1b[?{mode}happlication").as_bytes())
                .unwrap();
            assert!(model.snapshot("screen").unwrap().alternate_screen);
            model
                .advance(b"\x1b[?1049lone\r\ntwo\r\nthree\r\nfour\r\n")
                .unwrap();
            let snapshot = model.snapshot("screen").unwrap();
            assert!(!snapshot.alternate_screen);
            assert_eq!(snapshot.scrollback.offset, 0);
            assert!(snapshot.scrollback.history_lines > 0);
            assert!(snapshot.cells.chunks(20).any(|line| line
                .iter()
                .map(|cell| cell.0.as_str())
                .collect::<String>()
                .trim()
                == "four"));
        }
    }

    #[test]
    fn ghostty_cells_preserve_styles_inverse_hidden_and_dynamic_colors() {
        let mut model = Model::new(20, 4, 20).unwrap();
        model
            .advance(b"\x1b[1;2;3;4;9;31;44mX\x1b[0m\x1b[7;32;45mY\x1b[0m\x1b[8mZ\x1b[0m")
            .unwrap();
        let frame = model.snapshot("styles").unwrap();
        assert_eq!(frame.cells[0].4, 31);
        assert_eq!(frame.cells[0].2, 0xd54e53);
        assert_eq!(frame.cells[0].3, 0x81a2be);
        assert_eq!((frame.cells[1].2, frame.cells[1].3), (0xb294bb, 0xb5bd68));
        assert_eq!(frame.cells[2].0, " ");
        model.advance(b"\x1b]4;1;#102030\x1b\\\x1b[31mC").unwrap();
        assert_eq!(model.snapshot("styles").unwrap().cells[3].2, 0x102030);
    }
}
