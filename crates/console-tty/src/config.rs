use crate::shell::Shell;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub schema_version: Version,
    pub terminal: Terminal,
    pub render: Render,
    pub input: Input,
    pub limits: Limits,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Version(pub u32);
impl Default for Version {
    fn default() -> Self {
        Self(1)
    }
}

macro_rules! settings {
    ($name:ident { $($field:ident : $ty:ty = $value:expr),* $(,)? }) => {
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(default, deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),* }
        impl Default for $name {
            fn default() -> Self { Self { $($field: $value),* } }
        }
    };
}
settings!(Terminal {
    cols: u16 = 100, rows: u16 = 30, scrollback_lines: usize = 5000,
    shell: Option<Shell> = None,
    cwd: Option<std::path::PathBuf> = None
});
settings!(Render {
    max_fps: u16 = 15,
    responsive: bool = true,
    padding_cols: u16 = 2,
    padding_rows: u16 = 1,
    frame_spacing: bool = true
});
settings!(Input {
    dim_opacity: f64 = 0.12,
    show_key_hints: bool = true
});
settings!(Limits {
    max_live_sessions: usize = 8,
    max_live_sessions_per_tab: usize = 2,
    max_start_requests_per_minute: usize = 10
});

pub fn dimensions(cols: u16, rows: u16) -> Result<()> {
    ensure!(
        (2..=240).contains(&cols)
            && (2..=100).contains(&rows)
            && usize::from(cols) * usize::from(rows) <= 12000,
        "terminal dimensions must be 2..240 columns, 2..100 rows, at most 12000 cells"
    );
    Ok(())
}

impl Config {
    pub fn parse(source: &str) -> Result<Self> {
        let config: Self = toml::from_str(source).context("invalid config.toml")?;
        config.validate()?;
        Ok(config)
    }

    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        crate::private::check(path)?;
        Self::parse(&std::fs::read_to_string(path)?)
            .with_context(|| format!("configuration: {}", path.display()))
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version.0 == 1,
            "unsupported schema_version; expected 1"
        );
        dimensions(self.terminal.cols, self.terminal.rows)?;
        ensure!(
            self.terminal.scrollback_lines <= 100000,
            "scrollback_lines must be <= 100000"
        );
        ensure!(
            (1..=30).contains(&self.render.max_fps),
            "max_fps must be 1..30"
        );
        ensure!(
            self.render.padding_cols <= 8 && self.render.padding_rows <= 4,
            "render padding must be <= 8 columns and <= 4 rows"
        );
        ensure!(
            self.input.dim_opacity.is_finite() && (0.0..=0.8).contains(&self.input.dim_opacity),
            "dim_opacity must be finite and between 0 and 0.8"
        );
        ensure!(
            (1..=32).contains(&self.limits.max_live_sessions),
            "max_live_sessions must be 1..32"
        );
        ensure!(
            (1..=self.limits.max_live_sessions).contains(&self.limits.max_live_sessions_per_tab),
            "max_live_sessions_per_tab must be positive and <= max_live_sessions"
        );
        ensure!(
            (1..=120).contains(&self.limits.max_start_requests_per_minute),
            "max_start_requests_per_minute must be 1..120"
        );
        if let Some(cwd) = &self.terminal.cwd {
            ensure!(
                cwd.is_absolute() && cwd.is_dir(),
                "terminal.cwd must be an existing absolute directory"
            );
        }
        Ok(())
    }

    pub fn revision(&self) -> String {
        hex::encode(Sha256::digest(
            serde_json::to_vec(self).expect("serializable config"),
        ))
    }

    pub fn projection(&self) -> serde_json::Value {
        serde_json::json!({
            "render": self.render, "input": self.input,
            "terminal": { "cols": self.terminal.cols, "rows": self.terminal.rows,
                "shell": self.terminal.shell.unwrap_or_else(Shell::user_default) },
            "limits": self.limits
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_fail_closed_and_projection_is_sanitized() {
        let c = Config::parse("").unwrap();
        assert!(c.projection()["terminal"]["shell"].is_string());
        assert!(c.projection()["terminal"].get("cwd").is_none());
        assert_eq!(c.input.dim_opacity, 0.12);
        let generated = toml::to_string_pretty(&c).unwrap();
        assert_eq!(Config::parse(&generated).unwrap().revision(), c.revision());
    }
    #[test]
    fn invalid_config_never_falls_back() {
        for text in [
            "schema_version = 2",
            "unknown = true",
            "[security]\nrequire_pairing = 'false'",
            "[security]\nrequire_pairing = false",
            "[security]\nrequire_pairing = true",
            "[service]\nautostart = true",
            "[service]\nautostart = false",
            "[credentials]\nstore = 'keyring'",
            "[input]\ndim_opacity = nan",
            "[credentials]\nstore = 'plaintext'",
            "[terminal]\ncols = 0",
            "[render]\nmax_fps = 0",
            "[render]\npadding_cols = 9",
            "[render]\npadding_rows = 5",
            "[browser]\nsite_patterns = ['file:///*']",
            "[terminal]\nshell = 'bash -c whoami'",
            "[terminal]\nshell = '/bin/bash'",
            "[terminal]\ncwd = 'relative-directory'",
            "[input]\nshortcut = 'Ctrl+Y'",
            "[limits]\nmax_live_sessions = 0",
        ] {
            assert!(Config::parse(text).is_err(), "{text}");
        }
    }

    #[test]
    fn named_default_and_starting_directory_are_validated_without_exposing_paths() {
        let mut c = Config::parse("[terminal]\nshell = 'nu'").unwrap();
        c.terminal.cwd = Some(std::env::temp_dir());
        c.validate().unwrap();
        assert_eq!(c.projection()["terminal"]["shell"], "nu");
        assert!(c.projection()["terminal"].get("cwd").is_none());
        let generated = toml::to_string_pretty(&c).unwrap();
        assert_eq!(
            Config::parse(&generated).unwrap().terminal.cwd,
            c.terminal.cwd
        );
    }
}
