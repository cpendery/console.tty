export const VERSION = 1;
export const HOST = "dev.console_tty";
export const TOGGLE = "toggle-terminal-input";
export const PUBLIC_TYPE = "console.tty.start.v1";
export const PUBLIC_RESIZE = "console.tty.resize.v1";
export const PUBLIC_CONTROL = "console.tty.control.v1";
export const SHORTCUT = "Ctrl+Shift+9";
export const HTTP_SITES = ["http://*/*", "https://*/*"];
export const SHELLS = [
  "bash",
  "zsh",
  "fish",
  "nu",
  "xonsh",
  "sh",
  "cmd",
  "powershell",
  "pwsh",
] as const;
export type Shell = (typeof SHELLS)[number];
export function knownShell(value: unknown): value is Shell {
  return typeof value === "string" && SHELLS.some((shell) => shell === value);
}
export function dimensions(cols: unknown, rows: unknown): boolean {
  return integer(cols, 2, 240) && integer(rows, 2, 100) && cols * rows <= 12000;
}
export type Cell = [string, number, number, number, number];
export interface Scrollback {
  offset: number;
  history_lines: number;
}
export interface InputViewport {
  rows: number;
  alternate_screen: boolean;
  scrollback?: Scrollback;
}
export interface Snapshot {
  session_id: string;
  revision: number;
  cols: number;
  rows: number;
  cells: Cell[];
  cursor: { x: number; y: number; visible: boolean; shape: string };
  alternate_screen: boolean;
  exited: number | null;
  error?: string;
  scrollback?: Scrollback;
}
export interface Settings {
  render: {
    max_fps: number;
    responsive: boolean;
    padding_cols: number;
    padding_rows: number;
    frame_spacing: boolean;
  };
  input: { dim_opacity: number; show_key_hints: boolean };
  terminal: { cols: number; rows: number; shell: Shell };
  limits: {
    max_live_sessions: number;
    max_live_sessions_per_tab: number;
    max_start_requests_per_minute: number;
  };
}
export interface DisplayConfig {
  render: Settings["render"];
  terminal: Settings["terminal"];
  shortcut: string;
}
export interface EffectiveConfig {
  schema_version: 1;
  revision: string;
  daemon_available: boolean;
  host_id: string | null;
  daemon_id: string | null;
  settings: Settings;
}
export interface NativeReply {
  version: number;
  request_id: string;
  result?: unknown;
  error?: string;
}
export interface ConnectionStatus {
  state:
    | "connected"
    | "pairing_required"
    | "pending"
    | "unavailable"
    | "expired"
    | "session_closed";
  request_id?: string;
  expires_in?: number;
  message?: string;
}
export type RecordValue = Record<string, unknown>;
export function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function publicStart(
  value: unknown,
): value is RecordValue & { shell?: Shell } {
  return (
    record(value) &&
    Object.keys(value).every((key) => key === "type" || key === "shell") &&
    value.type === PUBLIC_TYPE &&
    (value.shell === undefined || knownShell(value.shell))
  );
}
export function publicResize(value: unknown): value is RecordValue {
  return (
    record(value) &&
    value.type === PUBLIC_RESIZE &&
    ((Object.keys(value).length === 2 && value.fit === true) ||
      (Object.keys(value).length === 3 && dimensions(value.cols, value.rows)))
  );
}
export function publicControl(
  value: unknown,
): value is RecordValue & { action: "pair" | "connect" | "status" | "close" } {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    value.type === PUBLIC_CONTROL &&
    typeof value.action === "string" &&
    ["pair", "connect", "status", "close"].includes(value.action)
  );
}
export function message<T extends string>(
  value: unknown,
  type: T,
  keys: string[] = [],
): value is RecordValue & { type: T } {
  return (
    record(value) &&
    value.type === type &&
    Object.keys(value).every((key) => key === "type" || keys.includes(key))
  );
}
export function parseConfig(value: unknown): EffectiveConfig {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    typeof value.revision !== "string" ||
    typeof value.daemon_available !== "boolean" ||
    !record(value.settings)
  )
    throw new Error("Unsupported backend configuration");
  const s = value.settings;
  if (
    !record(s.render) ||
    !integer(s.render.max_fps, 1, 30) ||
    typeof s.render.responsive !== "boolean" ||
    !integer(s.render.padding_cols, 0, 8) ||
    !integer(s.render.padding_rows, 0, 4) ||
    typeof s.render.frame_spacing !== "boolean" ||
    !record(s.input) ||
    !finite(s.input.dim_opacity, 0, 0.8) ||
    typeof s.input.show_key_hints !== "boolean" ||
    !record(s.terminal) ||
    !knownShell(s.terminal.shell) ||
    !integer(s.terminal.cols, 2, 240) ||
    !integer(s.terminal.rows, 2, 100) ||
    s.terminal.cols * s.terminal.rows > 12000 ||
    !record(s.limits) ||
    !integer(s.limits.max_live_sessions, 1, 32) ||
    !integer(
      s.limits.max_live_sessions_per_tab,
      1,
      s.limits.max_live_sessions,
    ) ||
    !integer(s.limits.max_start_requests_per_minute, 1, 120)
  )
    throw new Error("Invalid effective backend settings");
  if (
    value.daemon_available &&
    (typeof value.host_id !== "string" || typeof value.daemon_id !== "string")
  ) {
    throw new Error("Invalid backend identity");
  }
  return value as unknown as EffectiveConfig;
}
function finite(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
function integer(value: unknown, min: number, max: number): value is number {
  return finite(value, min, max) && Number.isInteger(value);
}
export function supportedSite(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
export function shortcutMatches(
  shortcut: string | undefined,
  mac: boolean,
): boolean {
  return (
    shortcut === SHORTCUT ||
    (mac &&
      ["⌃⇧9", "Control+Shift+9", "MacCtrl+Shift+9"].includes(shortcut ?? ""))
  );
}
export function toggleKey(
  event: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "code" | "key">,
): boolean {
  return (
    event.ctrlKey &&
    event.shiftKey &&
    (event.code === "Digit9" || ["9", "("].includes(event.key))
  );
}
export function validateSnapshot(value: unknown): value is Snapshot {
  if (
    !record(value) ||
    typeof value.session_id !== "string" ||
    !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(value.cols, 2, 240) ||
    !integer(value.rows, 2, 100) ||
    !Array.isArray(value.cells) ||
    value.cells.length !== value.cols * value.rows ||
    value.cells.length > 12000 ||
    !record(value.cursor)
  )
    return false;
  if (
    value.scrollback !== undefined &&
    (!record(value.scrollback) ||
      !integer(value.scrollback.history_lines, 0, 100000) ||
      !integer(value.scrollback.offset, 0, value.scrollback.history_lines))
  )
    return false;
  if (
    !integer(value.cursor.x, 0, value.cols - 1) ||
    !integer(value.cursor.y, 0, value.rows - 1) ||
    typeof value.cursor.visible !== "boolean" ||
    typeof value.cursor.shape !== "string" ||
    typeof value.alternate_screen !== "boolean" ||
    (value.exited !== null && !integer(value.exited, 0, 0xffffffff)) ||
    (value.error !== undefined &&
      (typeof value.error !== "string" || value.error.length > 512))
  )
    return false;
  return value.cells.every(
    (cell) =>
      Array.isArray(cell) &&
      cell.length === 5 &&
      typeof cell[0] === "string" &&
      integer(cell[1], 0, 2) &&
      integer(cell[2], 0, 0xffffff) &&
      integer(cell[3], 0, 0xffffff) &&
      integer(cell[4], 0, 31),
  );
}
