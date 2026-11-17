use super::{Cell, Cursor, Scrollback, Snapshot};
use crate::protocol::MAX_INPUT;
use anyhow::{anyhow, bail, ensure, Context, Result};
use ghostty_vt::{
    key::{self, Key, Mods},
    mouse,
    render::{CellIterator, CursorVisualStyle, RowIterator},
    screen::{CellWide, Screen},
    style::{Palette, PaletteIndex, RgbColor, StyleColor, Underline},
    terminal::{
        ColorScheme, ConformanceLevel, DeviceAttributeFeature, DeviceAttributes, DeviceType, Mode,
        PrimaryDeviceAttributes, ScrollViewport, SecondaryDeviceAttributes, SizeReportSize,
        TertiaryDeviceAttributes,
    },
    RenderState, Terminal,
};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::mpsc::{self, SyncSender},
    thread::{self, JoinHandle},
};

#[derive(Clone, Copy)]
pub(super) enum Scroll {
    Delta(i32),
    PageUp,
    PageDown,
    Top,
    Bottom,
}

type Job = Box<dyn FnOnce(&mut Core) + Send>;

// Only owned messages cross threads. Ghostty and its callbacks stay on their creating thread.
pub(super) struct Model {
    jobs: Option<SyncSender<Job>>,
    worker: Option<JoinHandle<()>>,
    pub(super) revision: u64,
    pub(super) exit: Option<u32>,
    pub(super) drained: bool,
    pub(super) error: Option<String>,
}

impl Model {
    pub(super) fn new(cols: u16, rows: u16, history: usize) -> Result<Self> {
        let (jobs, receiver) = mpsc::sync_channel::<Job>(32);
        let (ready, started) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("console-tty-ghostty".into())
            .spawn(move || match Core::new(cols, rows, history) {
                Ok(mut core) => {
                    if ready.send(Ok(())).is_err() {
                        return;
                    }
                    while let Ok(job) = receiver.recv() {
                        job(&mut core);
                    }
                }
                Err(error) => {
                    let _ = ready.send(Err(format!("{error:#}")));
                }
            })
            .context("starting Ghostty worker")?;
        let model = Self {
            jobs: Some(jobs),
            worker: Some(worker),
            revision: 0,
            exit: None,
            drained: false,
            error: None,
        };
        started
            .recv()
            .context("Ghostty worker disconnected during startup")?
            .map_err(|error| anyhow!(error))?;
        Ok(model)
    }

    fn call<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Core) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (reply, result) = mpsc::sync_channel(1);
        self.jobs
            .as_ref()
            .context("Ghostty worker is shutting down")?
            .send(Box::new(move |core| {
                let _ = reply.send(operation(core));
            }))
            .map_err(|_| anyhow!("Ghostty worker stopped"))?;
        result.recv().context("Ghostty worker disconnected")?
    }

    pub(super) fn advance(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        let bytes = bytes.to_vec();
        self.call(move |core| core.advance(&bytes))
    }

    pub(super) fn snapshot(&self, id: &str) -> Result<Snapshot> {
        let id = id.to_owned();
        let mut snapshot = self.call(move |core| core.snapshot(id))?;
        snapshot.revision += self.revision;
        snapshot.exited = if self.drained { self.exit } else { None };
        snapshot.error.clone_from(&self.error);
        Ok(snapshot)
    }

    pub(super) fn scroll(&mut self, scroll: Scroll) -> Result<()> {
        self.call(move |core| core.scroll(scroll))
    }

    pub(super) fn resize(&mut self, cols: u16, rows: u16) -> Result<Vec<u8>> {
        self.call(move |core| core.resize(cols, rows))
    }

    pub(super) fn prepare_input(
        &mut self,
        kind: &str,
        value: &str,
        ctrl: bool,
        alt: bool,
        shift: bool,
    ) -> Result<Option<Vec<u8>>> {
        let kind = kind.to_owned();
        let value = value.to_owned();
        self.call(move |core| {
            if kind == "key" && shift && !ctrl && !alt && !core.alternate()? {
                let scroll = match value.as_str() {
                    "PageUp" => Some(Scroll::PageUp),
                    "PageDown" => Some(Scroll::PageDown),
                    "Home" => Some(Scroll::Top),
                    "End" => Some(Scroll::Bottom),
                    _ => None,
                };
                if let Some(scroll) = scroll {
                    core.scroll(scroll)?;
                    return Ok(None);
                }
            }
            let bytes = core.encode(&kind, &value, ctrl, alt, shift)?;
            core.scroll(Scroll::Bottom)?;
            Ok(Some(bytes))
        })
    }

    #[cfg(test)]
    pub(super) fn encode(
        &self,
        kind: &str,
        value: &str,
        ctrl: bool,
        alt: bool,
        shift: bool,
    ) -> Result<Vec<u8>> {
        let kind = kind.to_owned();
        let value = value.to_owned();
        self.call(move |core| core.encode(&kind, &value, ctrl, alt, shift))
    }

    pub(super) fn wheel(&mut self, lines: i32, shift: bool, alt: bool) -> Result<Option<Vec<u8>>> {
        self.call(move |core| core.wheel(lines, shift, alt))
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        self.jobs.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Core {
    terminal: Terminal<'static, 'static>,
    render: RenderState<'static>,
    rows_iter: RowIterator<'static>,
    cells_iter: CellIterator<'static>,
    pending: Rc<RefCell<(Vec<u8>, bool)>>,
    cols: u16,
    rows: u16,
    history: usize,
    revision: u64,
}

impl Core {
    fn new(cols: u16, rows: u16, history: usize) -> Result<Self> {
        let mut terminal = Terminal::new(cols, rows)?;
        terminal
            .set_scrollback_max_bytes(None)?
            .set_scrollback_max_lines(Some(history))?
            .set_default_fg_color(Some(rgb(0xc5c8c6)))?
            .set_default_bg_color(Some(rgb(0x1d1f21)))?
            .set_default_mode(Mode::ALT_SCROLL, true)?
            .set_apc_max_bytes(Some(MAX_INPUT))?
            .set_continuation_max_bytes(MAX_INPUT)?;
        terminal.resize(cols, rows, 8, 16)?;
        let mut colors = Palette::default();
        for i in 0..=255 {
            colors.set(PaletteIndex(i), rgb(palette(i as usize)));
        }
        terminal.set_default_color_palette(Some(colors))?;
        let pending = Rc::new(RefCell::new((Vec::<u8>::new(), false)));
        terminal
            .on_pty_write({
                let pending = pending.clone();
                move |_, data| {
                    let mut pending = pending.borrow_mut();
                    if data.len() <= MAX_INPUT.saturating_sub(pending.0.len()) {
                        pending.0.extend_from_slice(data);
                    } else {
                        pending.1 = true;
                    }
                }
            })?
            .on_size(|terminal| {
                Some(SizeReportSize {
                    rows: terminal.rows().ok()?,
                    columns: terminal.cols().ok()?,
                    cell_width: 8,
                    cell_height: 16,
                })
            })?
            .on_color_scheme(|_| Some(ColorScheme::Dark))?
            .on_device_attributes(|_| {
                Some(DeviceAttributes {
                    primary: PrimaryDeviceAttributes::new(
                        ConformanceLevel::VT220,
                        &[DeviceAttributeFeature::ANSI_COLOR],
                    ),
                    secondary: SecondaryDeviceAttributes {
                        device_type: DeviceType::VT220,
                        firmware_version: 1,
                        rom_cartridge: 0,
                    },
                    tertiary: TertiaryDeviceAttributes { unit_id: 0 },
                })
            })?;
        Ok(Self {
            terminal,
            render: RenderState::new()?,
            rows_iter: RowIterator::new()?,
            cells_iter: CellIterator::new()?,
            pending,
            cols,
            rows,
            history,
            revision: 1,
        })
    }

    fn alternate(&self) -> Result<bool> {
        Ok(self.terminal.active_screen()? == Screen::Alternate)
    }

    fn viewport(&self) -> Result<Scrollback> {
        let history = self.terminal.scrollback_rows()?;
        let top = usize::try_from(self.terminal.scrollbar()?.offset)?;
        Ok(Scrollback {
            offset: history.saturating_sub(top),
            history_lines: history.min(self.history),
        })
    }

    fn normalize_viewport(&mut self) -> Result<()> {
        let viewport = self.viewport()?;
        if viewport.offset == 0 {
            self.terminal.scroll_viewport(ScrollViewport::Bottom);
        } else if viewport.offset > viewport.history_lines {
            self.terminal.scroll_viewport(ScrollViewport::Row(
                self.terminal.scrollback_rows()? - viewport.history_lines,
            ));
        }
        Ok(())
    }

    fn take_replies(&mut self) -> Result<Vec<u8>> {
        let (bytes, overflow) = std::mem::take(&mut *self.pending.borrow_mut());
        ensure!(!overflow, "terminal replies exceed 64 KiB");
        Ok(bytes)
    }

    fn advance(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        let follow = self.viewport()?.offset == 0;
        self.terminal.vt_write(bytes);
        // Keep live-follow pinned when an alternate-screen exit and output share a read.
        if follow {
            self.terminal.scroll_viewport(ScrollViewport::Bottom);
        }
        self.normalize_viewport()?;
        self.revision += 1;
        self.take_replies()
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<Vec<u8>> {
        let follow = self.viewport()?.offset == 0;
        self.terminal.resize(cols, rows, 8, 16)?;
        self.cols = cols;
        self.rows = rows;
        if follow {
            self.terminal.scroll_viewport(ScrollViewport::Bottom);
        }
        self.normalize_viewport()?;
        self.revision += 1;
        self.take_replies()
    }

    fn scroll(&mut self, scroll: Scroll) -> Result<()> {
        if self.alternate()? {
            return Ok(());
        }
        let viewport = self.viewport()?;
        let offset = match scroll {
            Scroll::Delta(lines) => viewport.offset.saturating_add_signed(lines as isize),
            Scroll::PageUp => viewport.offset.saturating_add(self.rows as usize),
            Scroll::PageDown => viewport.offset.saturating_sub(self.rows as usize),
            Scroll::Top => viewport.history_lines,
            Scroll::Bottom => 0,
        }
        .min(viewport.history_lines);
        self.terminal.scroll_viewport(if offset == 0 {
            ScrollViewport::Bottom
        } else {
            ScrollViewport::Row(self.terminal.scrollback_rows()? - offset)
        });
        if offset != viewport.offset {
            self.revision += 1;
        }
        Ok(())
    }

    fn snapshot(&mut self, id: String) -> Result<Snapshot> {
        let scrollback = self.viewport()?;
        let alternate_screen = self.alternate()?;
        let foreground = self.terminal.fg_color()?.unwrap_or(rgb(0xc5c8c6));
        let background = self.terminal.bg_color()?.unwrap_or(rgb(0x1d1f21));
        let colors = self.terminal.color_palette()?;
        let cursor_x = self.terminal.cursor_x()?.min(self.cols - 1) as usize;
        let cursor_y = self.terminal.cursor_y()?.min(self.rows - 1) as usize;
        let frame = self.render.update(&self.terminal)?;
        let cursor = Cursor {
            x: cursor_x,
            y: cursor_y,
            visible: scrollback.offset == 0 && frame.cursor_visible()?,
            shape: match frame.cursor_visual_style()? {
                CursorVisualStyle::Bar => "Beam",
                CursorVisualStyle::Underline => "Underline",
                _ => "Block",
            }
            .into(),
        };
        let mut cells = Vec::with_capacity(self.cols as usize * self.rows as usize);
        let mut rows = self.rows_iter.update(&frame)?;
        while let Some(row) = rows.next() {
            let mut columns = self.cells_iter.update(row)?;
            while let Some(cell) = columns.next() {
                let style = cell.style()?;
                let wide = cell.raw_cell()?.wide()?;
                let width = match wide {
                    CellWide::Wide => 2,
                    CellWide::SpacerTail => 0,
                    _ => 1,
                };
                let mut text = String::new();
                if !matches!(wide, CellWide::SpacerHead | CellWide::SpacerTail) {
                    cell.graphemes_utf8(&mut text)?;
                }
                if text.is_empty() || style.invisible {
                    text = " ".into();
                }
                let mut fg = match style.fg_color {
                    StyleColor::Palette(PaletteIndex(i)) if style.bold && i < 8 => {
                        packed(colors.0[i as usize + 8])
                    }
                    _ => packed(cell.fg_color()?.unwrap_or(foreground)),
                };
                let mut bg = packed(cell.bg_color()?.unwrap_or(background));
                if style.inverse {
                    std::mem::swap(&mut fg, &mut bg);
                }
                let flags = u8::from(style.bold)
                    | (u8::from(style.italic) << 1)
                    | (u8::from(style.underline != Underline::None) << 2)
                    | (u8::from(style.faint) << 3)
                    | (u8::from(style.strikethrough) << 4);
                cells.push(Cell(text, width, fg, bg, flags));
            }
        }
        ensure!(
            cells.len() == self.cols as usize * self.rows as usize,
            "Ghostty returned an incomplete viewport"
        );
        Ok(Snapshot {
            session_id: id,
            revision: self.revision,
            cols: self.cols,
            rows: self.rows,
            cells,
            cursor,
            alternate_screen,
            scrollback,
            exited: None,
            error: None,
        })
    }

    fn encode(
        &self,
        kind: &str,
        value: &str,
        ctrl: bool,
        alt: bool,
        shift: bool,
    ) -> Result<Vec<u8>> {
        ensure!(value.len() <= MAX_INPUT, "input exceeds 64 KiB");
        match kind {
            "input" | "text" => Ok(value.as_bytes().to_vec()),
            "paste" => {
                let text = value.replace('\x1b', "");
                Ok(if self.terminal.mode(Mode::BRACKETED_PASTE)? {
                    format!("\x1b[200~{text}\x1b[201~").into_bytes()
                } else {
                    text.into_bytes()
                })
            }
            "key" => {
                ensure!(
                    !(ctrl && shift && matches!(value, "9" | "(")),
                    "toggle chord is not terminal input"
                );
                // Preserve legacy C0 aliases until an app negotiates Kitty disambiguation.
                let alias = if ctrl && !shift && self.terminal.kitty_keyboard_flags()?.is_empty() {
                    match value {
                        "i" | "I" => Some("Tab"),
                        "m" | "M" => Some("Enter"),
                        "[" => Some("Escape"),
                        _ => None,
                    }
                } else {
                    None
                };
                let value = alias.unwrap_or(value);
                let mut event = key::Event::new()?;
                event
                    .set_key(key_code(value)?)
                    .set_action(key::Action::Press)
                    .set_mods(modifiers(ctrl && alias.is_none(), alt, shift));
                let mut chars = value.chars();
                if let (Some(ch), None) = (chars.next(), chars.next()) {
                    event
                        .set_unshifted_codepoint(ch.to_ascii_lowercase())
                        .set_utf8(Some(value));
                    if shift && !ctrl && !alt {
                        event.set_consumed_mods(Mods::SHIFT);
                    }
                }
                let mut encoder = key::Encoder::new()?;
                encoder
                    .set_options_from_terminal(&self.terminal)
                    .set_macos_option_as_alt(key::OptionAsAlt::True);
                let mut bytes = Vec::with_capacity(32);
                encoder.encode_to_vec(&event, &mut bytes)?;
                ensure!(!bytes.is_empty(), "unsupported terminal key");
                Ok(bytes)
            }
            _ => bail!("unsupported input type"),
        }
    }

    fn wheel(&mut self, lines: i32, shift: bool, alt: bool) -> Result<Option<Vec<u8>>> {
        ensure!(
            (-100000..=100000).contains(&lines),
            "scroll delta must be between -100000 and 100000 lines"
        );
        if lines == 0 {
            return Ok(None);
        }
        let report = if !shift && self.terminal.is_mouse_tracking()? {
            let mut encoder = mouse::Encoder::new()?;
            encoder
                .set_options_from_terminal(&self.terminal)
                .set_size(mouse::EncoderSize {
                    screen_width: u32::from(self.cols) * 8,
                    screen_height: u32::from(self.rows) * 16,
                    cell_width: 8,
                    cell_height: 16,
                    padding_top: 0,
                    padding_bottom: 0,
                    padding_left: 0,
                    padding_right: 0,
                });
            let mut event = mouse::Event::new()?;
            event
                .set_action(mouse::Action::Press)
                .set_button(Some(if lines > 0 {
                    mouse::Button::Four
                } else {
                    mouse::Button::Five
                }))
                .set_mods(modifiers(false, alt, false))
                // The input overlay cannot hit-test DevTools cells; target the terminal center.
                .set_position(mouse::Position {
                    x: f32::from(self.cols / 2) * 8.0 + 4.0,
                    y: f32::from(self.rows / 2) * 16.0 + 8.0,
                });
            let mut bytes = Vec::with_capacity(32);
            encoder.encode_to_vec(&event, &mut bytes)?;
            bytes
        } else if !shift && self.alternate()? && self.terminal.mode(Mode::ALT_SCROLL)? {
            self.encode(
                "key",
                if lines > 0 { "ArrowUp" } else { "ArrowDown" },
                false,
                alt,
                false,
            )?
        } else {
            self.scroll(Scroll::Delta(lines))?;
            return Ok(None);
        };
        if report.is_empty() {
            return Ok(None);
        }
        let count = lines.unsigned_abs() as usize;
        ensure!(
            count <= MAX_INPUT / report.len(),
            "wheel input exceeds 64 KiB"
        );
        self.scroll(Scroll::Bottom)?;
        Ok(Some(report.repeat(count)))
    }
}

fn modifiers(ctrl: bool, alt: bool, shift: bool) -> Mods {
    let mut mods = Mods::empty();
    mods.set(Mods::CTRL, ctrl);
    mods.set(Mods::ALT, alt);
    mods.set(Mods::SHIFT, shift);
    mods
}

fn key_code(value: &str) -> Result<Key> {
    Ok(match value {
        "Enter" => Key::Enter,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Backspace" => Key::Backspace,
        "ArrowUp" => Key::ArrowUp,
        "ArrowDown" => Key::ArrowDown,
        "ArrowLeft" => Key::ArrowLeft,
        "ArrowRight" => Key::ArrowRight,
        "Home" => Key::Home,
        "End" => Key::End,
        "Insert" => Key::Insert,
        "Delete" => Key::Delete,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        " " => Key::Space,
        "[" | "{" => Key::BracketLeft,
        "]" | "}" => Key::BracketRight,
        "\\" | "|" => Key::Backslash,
        "-" | "_" => Key::Minus,
        "=" | "+" => Key::Equal,
        "`" | "~" => Key::Backquote,
        ";" | ":" => Key::Semicolon,
        "'" | "\"" => Key::Quote,
        "," | "<" => Key::Comma,
        "." | ">" => Key::Period,
        "/" | "?" => Key::Slash,
        "@" => Key::Digit2,
        "^" => Key::Digit6,
        value if value.len() > 1 && value.starts_with('F') => {
            let n: u32 = value[1..].parse().context("unsupported terminal key")?;
            ensure!((1..=12).contains(&n), "unsupported terminal key");
            Key::try_from(Key::F1 as u32 + n - 1)
                .map_err(|_| anyhow!("unsupported terminal key"))?
        }
        value if value.chars().count() == 1 => {
            let byte = value.as_bytes()[0].to_ascii_lowercase();
            if value.len() == 1 && byte.is_ascii_lowercase() {
                Key::try_from(Key::A as u32 + u32::from(byte - b'a'))
                    .map_err(|_| anyhow!("unsupported terminal key"))?
            } else if value.len() == 1 && byte.is_ascii_digit() {
                Key::try_from(Key::Digit0 as u32 + u32::from(byte - b'0'))
                    .map_err(|_| anyhow!("unsupported terminal key"))?
            } else {
                Key::Unidentified
            }
        }
        _ => bail!("unsupported terminal key"),
    })
}

fn rgb(color: u32) -> RgbColor {
    RgbColor {
        r: (color >> 16) as u8,
        g: (color >> 8) as u8,
        b: color as u8,
    }
}

fn packed(color: RgbColor) -> u32 {
    (u32::from(color.r) << 16) | (u32::from(color.g) << 8) | u32::from(color.b)
}

pub(super) fn palette(i: usize) -> u32 {
    const ANSI: [u32; 16] = [
        0x1d1f21, 0xcc6666, 0xb5bd68, 0xf0c674, 0x81a2be, 0xb294bb, 0x8abeb7, 0xc5c8c6, 0x666666,
        0xd54e53, 0xb9ca4a, 0xe7c547, 0x7aa6da, 0xc397d8, 0x70c0b1, 0xeaeaea,
    ];
    match i {
        0..=15 => ANSI[i],
        16..=231 => {
            let n = i - 16;
            let v = |c: usize| if c == 0 { 0 } else { 55 + c as u32 * 40 };
            (v(n / 36) << 16) | (v(n / 6 % 6) << 8) | v(n % 6)
        }
        232..=255 => (8 + (i - 232) as u32 * 10) * 0x010101,
        _ => 0xc5c8c6,
    }
}
