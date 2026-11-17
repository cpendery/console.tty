import { message, record, toggleKey, type InputViewport } from "./protocol";

const sink = document.querySelector<HTMLTextAreaElement>("#sink")!;
const badge = document.querySelector<HTMLElement>("#badge")!;
const returnButton = document.querySelector<HTMLButtonElement>("#return")!;
const historyStatus = document.querySelector<HTMLElement>("#scrollback")!;
const port = chrome.runtime.connect({ name: "console.tty.input" });
let capability: string | undefined;
let live = false;
let composing = false;
let compositionCommit: string | undefined;
let compositionTimer: ReturnType<typeof setTimeout> | undefined;
let viewport: InputViewport = { rows: 0, alternate_screen: false };
let wheelRemainder = 0;
let wheelPending = 0;
let wheelInFlight = false;
let wheelShift = false;
let wheelAlt = false;

function updateViewport(value: unknown): void {
  if (
    !record(value) ||
    typeof value.rows !== "number" ||
    !Number.isInteger(value.rows) ||
    value.rows < 2 ||
    value.rows > 100 ||
    typeof value.alternate_screen !== "boolean"
  )
    return;
  const history =
    record(value.scrollback) &&
    typeof value.scrollback.offset === "number" &&
    typeof value.scrollback.history_lines === "number" &&
    Number.isInteger(value.scrollback.offset) &&
    Number.isInteger(value.scrollback.history_lines) &&
    value.scrollback.offset >= 0 &&
    value.scrollback.history_lines <= 100000 &&
    value.scrollback.offset <= value.scrollback.history_lines
      ? {
          offset: value.scrollback.offset,
          history_lines: value.scrollback.history_lines,
        }
      : undefined;
  viewport = {
    rows: value.rows,
    alternate_screen: value.alternate_screen,
    scrollback: history,
  };
  historyStatus.hidden = !history?.offset;
  historyStatus.textContent = history?.offset
    ? `${history.offset}/${history.history_lines}`
    : "";
}
function flushWheel(): void {
  if (
    wheelInFlight ||
    !wheelPending ||
    !live ||
    !capability ||
    document.activeElement !== sink ||
    !document.hasFocus()
  )
    return;
  const lines = Math.max(-64, Math.min(64, wheelPending));
  wheelPending -= lines;
  wheelInFlight = true;
  port.postMessage({
    type: "input.scroll",
    capability,
    lines,
    ...(wheelShift ? { shift: true } : {}),
    ...(wheelAlt ? { alt: true } : {}),
  });
}

function reset(): void {
  capability = undefined;
  live = false;
  composing = false;
  compositionCommit = undefined;
  clearTimeout(compositionTimer);
  sink.value = "";
  sink.disabled = true;
  badge.textContent = "console.tty input off";
  document.body.dataset.state = "off";
  wheelRemainder = wheelPending = 0;
  wheelInFlight = false;
  wheelShift = wheelAlt = false;
  viewport = { rows: 0, alternate_screen: false };
  historyStatus.hidden = true;
  historyStatus.textContent = "";
}
function disarm(): void {
  const previous = capability;
  reset();
  if (previous)
    port.postMessage({ type: "input.disarm", capability: previous });
}
function send(
  kind: "text" | "key" | "paste",
  value: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): void {
  if (
    !live ||
    !capability ||
    document.activeElement !== sink ||
    !document.hasFocus()
  )
    return;
  if (new TextEncoder().encode(value).length > 65536) {
    disarm();
    return;
  }
  wheelRemainder = wheelPending = 0;
  port.postMessage({
    type: "input.send",
    capability,
    kind,
    value,
    ...modifiers,
  });
}
port.onMessage.addListener((value: unknown) => {
  if (
    message(value, "input.probe", ["probe"]) &&
    typeof value.probe === "string"
  ) {
    parent.postMessage(
      { type: "console.tty.frame-probe", probe: value.probe },
      "*",
    );
  } else if (
    record(value) &&
    value.type === "input.authorized" &&
    typeof value.capability === "string" &&
    record(value.settings) &&
    typeof value.settings.dim_opacity === "number" &&
    typeof value.settings.show_key_hints === "boolean"
  ) {
    capability = value.capability;
    updateViewport(value.viewport);
    document.body.dataset.state = "connecting";
    sink.disabled = false;
    document.body.style.backgroundColor = `rgba(0,0,0,${value.settings.dim_opacity})`;
    document.querySelector<HTMLElement>("#session")!.textContent = String(
      value.label,
    );
    document.querySelector<HTMLElement>("#shortcut")!.textContent = String(
      value.shortcut,
    );
    document.querySelector<HTMLElement>("#hints")!.hidden =
      !value.settings.show_key_hints;
    sink.focus({ preventScroll: true });
    if (document.hasFocus() && document.activeElement === sink)
      port.postMessage({ type: "input.ready", capability });
    else disarm();
  } else if (
    record(value) &&
    value.type === "input.live" &&
    value.capability === capability
  ) {
    if (!document.hasFocus() || document.activeElement !== sink) {
      disarm();
      return;
    }
    live = true;
    document.body.dataset.state = "live";
    badge.textContent = "console.tty input live";
  } else if (record(value) && value.type === "input.disarmed") reset();
  else if (record(value) && capability && value.capability === capability) {
    if (value.type === "input.viewport") updateViewport(value.viewport);
    if (value.type === "input.scrolled") {
      wheelInFlight = false;
      flushWheel();
    }
  }
});
port.onDisconnect.addListener(reset);
returnButton.addEventListener("click", (event) => {
  if (event.isTrusted) disarm();
});
document.addEventListener("pointerdown", (event) => {
  if (event.isTrusted && live && capability && event.target !== returnButton) {
    event.preventDefault();
    sink.focus({ preventScroll: true });
  }
});
document.addEventListener(
  "wheel",
  (event) => {
    if (
      !event.isTrusted ||
      !live ||
      !capability ||
      event.ctrlKey ||
      event.metaKey ||
      document.activeElement !== sink ||
      !document.hasFocus()
    )
      return;
    event.preventDefault();
    if (!viewport.scrollback) return;
    if (wheelShift !== event.shiftKey || wheelAlt !== event.altKey)
      wheelRemainder = wheelPending = 0;
    wheelShift = event.shiftKey;
    wheelAlt = event.altKey;
    const amount =
      -event.deltaY *
      (event.deltaMode === 1
        ? 1
        : event.deltaMode === 2
          ? viewport.rows
          : 1 / 40);
    if (!Number.isFinite(amount)) return;
    if (Math.sign(amount) !== Math.sign(wheelRemainder)) wheelRemainder = 0;
    wheelRemainder += amount;
    const lines = Math.trunc(wheelRemainder);
    wheelRemainder -= lines;
    wheelPending = Math.max(-100000, Math.min(100000, wheelPending + lines));
    flushWheel();
  },
  { passive: false },
);
window.addEventListener("blur", disarm);
window.addEventListener("pagehide", disarm);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disarm();
});

sink.addEventListener("keydown", (event) => {
  if (
    !event.isTrusted ||
    !live ||
    composing ||
    event.isComposing ||
    event.key === "Dead" ||
    event.key === "Process"
  )
    return;
  if (toggleKey(event)) {
    event.preventDefault();
    return;
  }
  if (event.metaKey) return;
  if (
    [
      "Shift",
      "Control",
      "Alt",
      "AltGraph",
      "CapsLock",
      "NumLock",
      "ScrollLock",
    ].includes(event.key)
  )
    return;
  if ((event.ctrlKey || event.altKey) && !event.getModifierState("AltGraph")) {
    // Let a genuine paste event deliver the clipboard once, without an extra Ctrl+V.
    if (
      event.ctrlKey &&
      (event.key.toLowerCase() === "v" || event.key === "Insert")
    )
      return;
    event.preventDefault();
    send("key", event.key, {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    });
  } else if (event.key.length > 1 && event.key !== "Unidentified") {
    event.preventDefault();
    send("key", event.key, { shift: event.shiftKey });
  }
});
sink.addEventListener("compositionstart", (event) => {
  if (event.isTrusted) {
    composing = true;
    compositionCommit = undefined;
  }
});
sink.addEventListener("compositionend", (event) => {
  if (!event.isTrusted) return;
  composing = false;
  compositionCommit = event.data;
  if (event.data) send("text", event.data);
  sink.value = "";
  clearTimeout(compositionTimer);
  compositionTimer = setTimeout(() => {
    compositionCommit = undefined;
  }, 0);
});
sink.addEventListener("input", (event) => {
  const input = event as InputEvent;
  if (!event.isTrusted || input.isComposing || composing) return;
  const text = input.data ?? sink.value;
  const duplicate =
    compositionCommit !== undefined && text === compositionCommit;
  compositionCommit = undefined;
  if (text && !duplicate) send("text", text);
  sink.value = "";
});
sink.addEventListener("paste", (event) => {
  if (!event.isTrusted) return;
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain");
  if (text !== undefined) send("paste", text);
  sink.value = "";
});
