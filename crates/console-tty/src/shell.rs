use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    Bash,
    Zsh,
    Fish,
    Nu,
    Xonsh,
    Sh,
    Cmd,
    Powershell,
    Pwsh,
}

impl Shell {
    pub fn name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
            Self::Nu => "nu",
            Self::Xonsh => "xonsh",
            Self::Sh => "sh",
            Self::Cmd => "cmd",
            Self::Powershell => "powershell",
            Self::Pwsh => "pwsh",
        }
    }

    pub fn user_default() -> Self {
        #[cfg(windows)]
        {
            Self::Cmd
        }
        #[cfg(unix)]
        {
            let path = std::env::var("SHELL").ok().map(PathBuf::from);
            path.and_then(|path| {
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .and_then(|name| serde_json::from_value(serde_json::json!(name)).ok())
            })
            .unwrap_or(Self::Sh)
        }
    }

    pub fn resolve(self) -> Result<PathBuf> {
        #[cfg(not(windows))]
        if matches!(self, Self::Cmd | Self::Powershell) {
            bail!("{} is only supported on Windows", self.name());
        }
        #[cfg(windows)]
        if self == Self::Bash {
            // Prefer Git Bash over the Windows bash.exe/WSL launcher.
            if let Some(path) = self.git_bash_candidates().into_iter().find(|p| p.is_file()) {
                return Ok(path);
            }
        }
        if let Ok(path) = which::which(self.name()) {
            return Ok(path);
        }
        let executable = if cfg!(windows) {
            format!("{}.exe", self.name())
        } else {
            self.name().into()
        };
        let mut candidates = Vec::new();
        if let Some(home) = dirs::home_dir() {
            candidates.extend([
                home.join(".cargo").join("bin").join(&executable),
                home.join(".local").join("bin").join(&executable),
            ]);
            #[cfg(windows)]
            candidates.push(home.join("scoop").join("shims").join(&executable));
        }
        #[cfg(windows)]
        {
            if let Some(local) = dirs::data_local_dir() {
                candidates.push(
                    local
                        .join("Microsoft")
                        .join("WinGet")
                        .join("Links")
                        .join(&executable),
                );
            }
            if let Some(programs) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
                match self {
                    Self::Pwsh => {
                        candidates.push(programs.join("PowerShell").join("7").join(&executable))
                    }
                    Self::Nu => {
                        candidates.push(programs.join("nu").join("bin").join(&executable));
                        candidates.push(programs.join("NuShell").join("bin").join(&executable));
                    }
                    _ => {}
                }
            }
            if let Some(windows) = std::env::var_os("SystemRoot").map(PathBuf::from) {
                match self {
                    Self::Cmd => candidates.push(windows.join("System32").join(&executable)),
                    Self::Powershell => candidates.push(
                        windows
                            .join("System32")
                            .join("WindowsPowerShell")
                            .join("v1.0")
                            .join(&executable),
                    ),
                    _ => {}
                }
            }
        }
        #[cfg(unix)]
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin").join(&executable),
            PathBuf::from("/usr/local/bin").join(&executable),
        ]);
        for candidate in candidates {
            if let Ok(path) = which::which(candidate) {
                return Ok(path);
            }
        }
        bail!(
            "{} was not found; install that shell and put it on the daemon's PATH",
            self.name()
        )
    }

    #[cfg(windows)]
    fn git_bash_candidates(self) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Ok(git) = which::which("git.exe") {
            if let Some(root) = git.parent().and_then(|p| p.parent()) {
                roots.push(root.to_path_buf());
            }
        }
        for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable) {
                roots.push(PathBuf::from(root).join("Git"));
            }
        }
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("scoop").join("apps").join("git").join("current"));
            roots.push(
                home.join("scoop")
                    .join("apps")
                    .join("git-with-openssh")
                    .join("current"),
            );
        }
        roots
            .into_iter()
            .flat_map(|root| {
                [
                    root.join("bin").join("bash.exe"),
                    root.join("usr").join("bin").join("bash.exe"),
                ]
            })
            .collect()
    }
}

pub fn starting_directory(configured: Option<&PathBuf>) -> Result<PathBuf> {
    configured
        .cloned()
        .or_else(dirs::home_dir)
        .context("no default starting directory")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn executable_paths_arguments_and_unknown_shells_are_not_shell_names() {
        for value in [
            "bash -c whoami",
            "nu;whoami",
            "/bin/bash",
            "C:\\Windows\\cmd.exe",
            "python",
            "",
            "BASH",
        ] {
            assert!(
                serde_json::from_value::<Shell>(serde_json::json!(value)).is_err(),
                "{value}"
            );
        }
        for value in ["bash", "nu", "fish", "pwsh", "cmd"] {
            assert_eq!(
                serde_json::from_value::<Shell>(serde_json::json!(value))
                    .unwrap()
                    .name(),
                value
            );
        }
    }
    #[test]
    fn default_shell_is_discovered_without_interpreting_a_command_line() {
        assert!(Shell::user_default().resolve().unwrap().is_absolute());
    }
}
