#![cfg(windows)]

use std::{os::windows::process::CommandExt, process::Command};

#[test]
fn installed_executable_is_launchable_by_windows_command_shell() {
    let path = dunce::canonicalize(env!("CARGO_BIN_EXE_console-tty")).unwrap();
    let output = Command::new(std::env::var_os("COMSPEC").unwrap())
        .raw_arg(format!(r#"/d /s /c ""{}" --version""#, path.display()))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).starts_with("console-tty "));
}
