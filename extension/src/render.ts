import {
  CellBuffer,
  CssConsoleDriver,
  ATTR_BOLD,
  ATTR_ITALIC,
  ATTR_UNDERLINE,
  ATTR_DIM,
  ATTR_STRIKETHROUGH,
  DEFAULT_TYPOGRAPHY,
  ViewportController,
  measureCharWidth,
  type WindowLike,
  type ViewportSize,
  type ConsoleTarget,
} from "@textjs/core";
import {
  SHORTCUT,
  type Snapshot,
  type Settings,
  type DisplayConfig,
} from "./protocol";

const rowHeight =
  DEFAULT_TYPOGRAPHY.lineHeight + 2 * DEFAULT_TYPOGRAPHY.rowPaddingY;
// Preserve background overlap while keeping the same whole-pixel layout rows.
const typography = {
  ...DEFAULT_TYPOGRAPHY,
  lineHeight: DEFAULT_TYPOGRAPHY.lineHeight - 2 * DEFAULT_TYPOGRAPHY.rowMarginY,
};

export function toBuffer(
  snapshot: Snapshot,
  padding = { padding_cols: 0, padding_rows: 0 },
  footer?: { live: boolean; shortcut: string },
): CellBuffer {
  const left = padding.padding_cols;
  const top = padding.padding_rows;
  const width = snapshot.cols + left * 2;
  const height = snapshot.rows + top * 2 + (footer ? 1 : 0);
  const buffer = new CellBuffer(width, height);
  const background = (((snapshot.cells[0]?.[3] ?? 0x1d1f21) << 8) | 255) >>> 0;
  buffer.fillRect(0, 0, width, height, background);
  snapshot.cells.forEach(([text, width, fg, bg, flags], index) => {
    if (width === 0) return;
    let attrs = 0;
    for (const [bit, attribute] of [
      [1, ATTR_BOLD],
      [2, ATTR_ITALIC],
      [4, ATTR_UNDERLINE],
      [8, ATTR_DIM],
      [16, ATTR_STRIKETHROUGH],
    ]) {
      if (flags & bit) attrs |= attribute;
    }
    const x = index % snapshot.cols;
    const y = Math.floor(index / snapshot.cols);
    const cursor =
      snapshot.cursor.visible &&
      snapshot.cursor.x === x &&
      snapshot.cursor.y === y;
    const foreground = (((cursor ? bg : fg) << 8) | 255) >>> 0;
    const background = (((cursor ? fg : bg) << 8) | 255) >>> 0;
    buffer.setCell(x + left, y + top, text, foreground, background, attrs);
  });
  if (footer) {
    const history = snapshot.scrollback;
    const bg = 0x6495edff;
    const text = history?.offset
      ? `Scrollback ${history.offset}/${history.history_lines} - ${footer.live ? "Shift+End or type to go live" : `${footer.shortcut} to navigate`}`
      : footer.live
        ? `console.tty input live - ${footer.shortcut} to return`
        : `${footer.shortcut} - enable terminal input on the page`;
    buffer.fillRect(0, height - 1, width, 1, bg);
    const label = text.slice(0, width);
    const start = Math.max(0, Math.floor((width - label.length) / 2));
    buffer.drawText(start, height - 1, label, 0x101210ff, bg, ATTR_BOLD);
  }
  return buffer;
}

export function boundedSize(size: ViewportSize): ViewportSize {
  const cols = Math.max(2, Math.min(240, Math.floor(size.cols)));
  const rows = Math.max(
    2,
    Math.min(100, Math.floor(size.rows), Math.floor(12000 / cols)),
  );
  return { cols, rows };
}

export function createViewport(
  config: DisplayConfig,
  win?: WindowLike,
): ViewportController {
  const charWidth = measureCharWidth();
  return new ViewportController({
    responsive: config.render.responsive,
    width: config.terminal.cols,
    height: config.terminal.rows,
    minCols: 2,
    maxCols: 240,
    minRows: 2,
    maxRows: 100,
    consolePaddingX: 56 + 2 * config.render.padding_cols * charWidth,
    consoleChromeY: 104 + (2 * config.render.padding_rows + 1) * rowHeight,
    charWidth,
    charHeight: rowHeight,
    storage: null,
    ...(win ? { window: win } : {}),
  });
}

export function createRenderer(target: ConsoleTarget = console) {
  let settings: Settings["render"] | undefined;
  let shortcut = SHORTCUT;
  let live = false;
  let latest: Snapshot | undefined;
  const driver = new CssConsoleDriver({
    console: {
      clear: () => target.clear(),
      log: (format: unknown, ...styles: unknown[]) => {
        if (settings?.frame_spacing && typeof format === "string") {
          // Text.js's viewport-height curtain separates frames without clearing other console logs.
          target.log(
            `%c\u200b%c\n${format}`,
            `margin-top:100vh;font-size:${typography.fontSize}px;line-height:${rowHeight}px;`,
            "",
            ...styles,
          );
        } else target.log(format, ...styles);
      },
    },
    clear: "never",
    initialClear: false,
    curtain: false,
    typography,
  });
  const repaint = () => {
    if (latest && settings)
      driver.render(toBuffer(latest, settings, { live, shortcut }));
  };
  return {
    configure(config: DisplayConfig) {
      settings = config.render;
      shortcut = config.shortcut;
      repaint();
    },
    render(snapshot: Snapshot) {
      latest = snapshot;
      repaint();
    },
    inputLive(value: boolean) {
      live = value;
      repaint();
    },
  };
}
