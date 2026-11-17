# console.tty

`console.tty` is a real terminal built into your web browser's console. `console.tty` supports Windows, Linux, & macOS using a browser extension and rust executable for managing terminal sessions.

https://github.com/user-attachments/assets/3b3dd8c2-a683-4cc1-8400-d8149b8cdbb5

```js
console.tty("bash");
```

Press **Ctrl+Shift+9** to type through the extension's lightly dimmed input iframe, with a small live indicator at the bottom left. Press it again to return to the page. Moving focus to DevTools disarms input; the shell keeps running. On macOS this uses Control, not Command.

**This is a writable demo, not a command sandbox.** After installation and pairing, normal HTTP(S) pages can start known local shells without confirmation. The allowlist rejects executable paths, commands, arguments, and execution options; local shell startup files still execute. Pages receive no terminal input, output, credentials, or writable handle. Read the [trust model](SECURITY.md).

## Get started

Building requires Rust 1.90+, Git, Zig 0.16.0 on PATH, Node.js 22+, and a Chromium browser supporting Manifest V3 and Native Messaging. Zig is only a build dependency; the installed executable statically links the Ghostty VT library.

```powershell
npm ci
npm run build
cargo install --path .\crates\console-tty --locked
```

The Ghostty binding is pinned to the same revision and Zig version used by tui-test. Put Zig 0.16.0 first on PATH when another Zig version is installed; the pinned build script invokes `zig` directly. Its first build fetches the pinned Ghostty source and Zig packages. Offline builds can prefetch these and set `GHOSTTY_SOURCE_DIR` and `GHOSTTY_ZIG_SYSTEM_DIR`.

1. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, and **Load unpacked** from `dist\extension`.
2. Copy the extension's ID and register the installed binary:

   ```powershell
   console-tty native-host install YOUR_EXTENSION_ID
   # For Edge, append: --browser edge
   ```

3. Run `console-tty`. It starts a background daemon and waits for readiness; it does not print an enrollment secret.
4. In the page console, run `console.tty.pair()`. Match the non-secret request ID with the extension toolbar tooltip, then run `console-tty pair` in your local terminal and approve that request. No secret is pasted into the page.
5. On a normal HTTP(S) page, open DevTools in the ordinary page context and run `console.tty()` or `console.tty("nu")`. Press the fixed shortcut to enter input mode.

If you change the unpacked extension's location/ID or reinstall the binary elsewhere, repeat native-host registration. The browser must launch the installed absolute executable path, not `cargo run`. No browser registration, persistent service, or OS credentials are installed by a build.

For an update on Windows, stop the daemon and close the extension's native connection (temporarily disabling the extension does this) before reinstalling, otherwise Windows may lock the executable. Then reload the extension and restart/pair. Restarting a manual daemon closes its shells and invalidates its browser credentials.

After upgrading from an older extension build, refresh the webpage itself once. Reloading the extension alone does not remove its old listeners from an already-open page; re-pairing cannot repair that invalidated JavaScript context. Current builds retire stale renderers automatically on subsequent extension reloads.

## Controls

| Action                              | Behavior                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `console.tty()` in the page         | Start the configured/default shell or reuse this document's selected session. Returns no handle.                        |
| `console.tty("nu")`                 | Select a known shell. Reuse that document's matching live session, or start another without killing the previous shell. |
| `console.tty.resize(120, 32)`       | Resize the selected terminal and pin a manual size.                                                                     |
| `console.tty.resize()`              | Restore automatic fitting.                                                                                              |
| `console.tty.close()`               | Close only this document's selected session; other sessions and tabs stay running.                                      |
| Ctrl+Shift+9                        | Toggle the extension-origin input iframe. Requires an existing terminal.                                                |
| Wheel                               | Let mouse-aware apps scroll their own content; otherwise scroll terminal history.                                       |
| Shift+wheel / Shift+PageUp/PageDown | Browse terminal history, bypassing application mouse capture.                                                           |
| Shift+Home / Shift+End              | Jump to oldest retained output / return to live output.                                                                 |
| Return to page                      | Accessible extension-owned input exit control.                                                                          |
| `console.tty.status()`              | Print minimal, non-secret connection status.                                                                            |
| `console.tty.connect()`             | Retry an already-approved connection; being unpaired is a status, not a disabled UI.                                    |
| `console.tty.pair()`                | Request local approval. Takes no arguments and never accepts a secret.                                                  |
| `console.tty.help()`                | Print usage without requiring a working backend.                                                                        |
| Toolbar icon                        | Toggle input; its tooltip shows the pending enrollment ID while pairing. There is no popup.                             |
| `console-tty daemon stop`           | Stop the daemon and terminate its terminal processes.                                                                   |

There are no console write, list, or attach methods, and no separate writable API in the isolated context. Supported names are `bash`, `zsh`, `fish`, `nu`, `xonsh`, `sh`, `pwsh`, and Windows-only `cmd`/`powershell`. The backend finds the executable using PATH and standard installation locations, preferring Git Bash on Windows. A missing shell is an error, not a fallback to another executable.

Multiple sessions may run, subject to the TOML quotas; there is no popup or session-list UI. Exit a shell through its normal terminal input. Detached shells remain alive until they exit or the daemon stops. Calls for another shell disarm input before changing the selected destination.

The daemon owns sessions by UUID. The service worker maps `(tabId, documentId)` to that document's selected session, shell, and snapshot revision, and keeps routing metadata in trusted `chrome.storage.session` across worker restarts. Same-shell calls within a document reuse its live session; choosing another shell leaves the earlier one in the daemon. Navigation currently detaches rather than closes: the previous shell remains alive and counted toward quotas, but the new document cannot enumerate or select it by ID through the page API. Exit a shell through its normal terminal input. Detached shells remain alive until they exit or the daemon stops. Calls for another shell disarm input before changing the selected destination.

Output uses Text.js `CellBuffer` and `CssConsoleDriver`, never a page DOM mirror or browser-side ANSI emulator. Frames have inner padding, a viewport-height spacer separating previous output, and a shortcut/live-state footer. They append without clearing other console messages. Use DevTools' normal clear action when desired.

Rows and the frame separator use consistent whole-pixel typography to avoid fractional scroll-position wobble as animated frames append. The slightly larger line spacing is also used by automatic sizing; no console clearing or backend resize loop is needed to stabilize redraws.

The terminal automatically fits **docked** DevTools width and height using Text.js's viewport estimator. Undocked consoles, console drawers, and DevTools-specific zoom cannot be measured reliably; the configured terminal size is the fallback. Use `console.tty.resize(cols, rows)` to choose a manual size.

Committed text and key events are forwarded immediately in input-port order, without waiting for Enter or a frame timer. Only display snapshots are coalesced at the configured render rate (15 FPS by default). IME pre-edit text stays local until committed.

Scroll over the live input overlay to scroll a mouse-aware application's content or, outside mouse capture, the terminal history. Hold Shift while wheeling to bypass application capture and browse the terminal's own history. Its indicator and console footer show the distance from live output; typing returns to the bottom. History stays in the daemon, bounded by `terminal.scrollback_lines` (5,000 by default), and is lost when its session closes or the daemon restarts.

Alternate-screen applications receive mouse-wheel reports when requested, otherwise arrow keys when alternate scrolling is enabled. Shifted navigation keys remain available to those apps; their alternate screen has no terminal scrollback of its own. Wheel reports target the terminal center because DevTools exposes no cell-level pointer coordinates to the input overlay. Scrolling DevTools itself still scrolls console messages, not the terminal viewport.

## Configuration and startup

```powershell
console-tty config init
console-tty config path
```

Edit that one TOML file and restart the daemon. The extension fetches the backend's effective revision and cannot override settings. See [configuration](docs/configuration.md).

Start explicitly with `console-tty daemon start`; bare `console-tty` is shorthand for the same operation. No service or login startup is installed. Pairing is always required and cannot be disabled in TOML. Approve the matching browser request with local `console-tty pair`. Credentials last only for the running daemon and trusted browser session; restarting the daemon requires pairing again. See [platform setup and limitations](docs/platforms.md).

```powershell
console-tty daemon start
console-tty daemon stop
console-tty daemon foreground
console-tty daemon status
console-tty client list
console-tty client revoke CLIENT_ID
```




## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
