# console.tty

`console.tty` is a real terminal built into your web browser's console. `console.tty` supports Windows, Linux, & macOS using a browser extension and rust executable for managing terminal sessions.

https://github.com/user-attachments/assets/3b3dd8c2-a683-4cc1-8400-d8149b8cdbb5

## Get started

### Install CLI & Browser Extension

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/cpendery/console.tty/main/install.sh | sh
```

Windows:

```powershell
irm https://raw.githubusercontent.com/cpendery/console.tty/main/install.ps1 | iex
```

For a private repository, authenticate with `gh auth login`, then use:

```powershell
gh api repos/cpendery/console.tty/contents/install.ps1 -H "Accept: application/vnd.github.raw+json" | Out-String | Invoke-Expression
```

The PowerShell installer uses `gh` to download private release assets when needed.
Set `$env:CONSOLE_TTY_VERSION = "v0.1.0"` before installing to select that release;
otherwise, the latest release is installed.

### Browser setup

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable Developer mode
3. Select **Load unpacked** and select the extension folder provided in the install script's output
4. After loading, select **Details** on the extension and copy the extension id
5. Run `console-tty native-host install YOUR_EXTENSION_ID` (add `--browser edge` for edge)

## Usage

1. On any website, run `console.tty.pair()` to get a new session id (required during each browser restart)
2. Run `console-tty pair SESSION_ID` in the CLI
3. Run `console.tty("SHELL")` to start a new browser shell. Shell is optional and supports `bash`, `zsh`, `fish`, `nu`, `xonsh`, `sh`, `pwsh`, `cmd` (Windows exclusive), and `powershell` (Windows exclusive)

Focus the main webpage and type **Control-Shift-9** to activate the input detection for the terminal.

## Configuration

Create and locate your [toml](https://toml.io/) configuration:

```powershell
console-tty config init
console-tty config path
```

### Configuration

```toml
schema_version = 1

[terminal]
cols = 100
rows = 30
scrollback_lines = 5000
shell = "pwsh"  # defaults to "cmd" on Windows and sh (or $SHELL) on macOS & Linux
cwd = 'C:\projects' # defaults to homedir, must be absolute path

[render]
max_fps = 15
responsive = true # autofits when devtools is docked
padding_cols = 2
padding_rows = 1
frame_spacing = true

[input]
dim_opacity = 0.12
show_key_hints = true

[limits]
max_live_sessions = 8
max_live_sessions_per_tab = 2
max_start_requests_per_minute = 10
```
