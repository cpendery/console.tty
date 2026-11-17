import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

test("iframe input commits text once, coalesces trusted wheel input, and discards stale events", async () => {
  const bundle = await build({
    entryPoints: ["extension/src/input.ts"],
    bundle: true,
    write: false,
    format: "iife",
  });
  type Listener = (value: Record<string, unknown>) => void;
  const listeners = new Map<string, Listener>();
  const windowListeners = new Map<string, Listener>();
  const documentListeners = new Map<string, Listener>();
  const messages: Record<string, unknown>[] = [];
  let receive: Listener = () => {};
  const sink = {
    value: "",
    disabled: false,
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, listener);
    },
    focus() {
      document.activeElement = sink;
    },
  };
  const node = () => ({
    textContent: "",
    hidden: false,
    addEventListener() {},
  });
  const elements: Record<string, unknown> = {
    "#sink": sink,
    "#badge": node(),
    "#title": node(),
    "#session": node(),
    "#shortcut": node(),
    "#hints": node(),
    "#return": node(),
    "#focus-input": node(),
    "#scrollback": node(),
  };
  const document = {
    body: { style: {}, dataset: {} },
    activeElement: sink,
    hasFocus: () => true,
    querySelector: (selector: string) => elements[selector],
    addEventListener: (type: string, listener: Listener) =>
      documentListeners.set(type, listener),
  };
  const context = vm.createContext({
    document,
    TextEncoder,
    setTimeout,
    clearTimeout,
    window: {
      addEventListener: (type: string, listener: Listener) =>
        windowListeners.set(type, listener),
    },
    parent: { postMessage() {} },
    chrome: {
      runtime: {
        connect: () => ({
          onMessage: {
            addListener: (listener: Listener) => {
              receive = listener;
            },
          },
          onDisconnect: { addListener() {} },
          postMessage: (value: Record<string, unknown>) => messages.push(value),
        }),
      },
    },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  receive({
    type: "input.authorized",
    capability: "test-cap",
    label: "Shell test",
    shortcut: "Ctrl+Shift+9",
    settings: { dim_opacity: 0.12, show_key_hints: true },
    viewport: {
      rows: 30,
      alternate_screen: false,
      scrollback: { offset: 0, history_lines: 100 },
    },
  });
  receive({ type: "input.live", capability: "test-cap" });
  const emit = (type: string, fields: Record<string, unknown> = {}) =>
    listeners.get(type)!({
      isTrusted: true,
      preventDefault() {},
      ...fields,
    });
  const wheel = (deltaY: number, fields: Record<string, unknown> = {}) =>
    documentListeners.get("wheel")!({
      isTrusted: true,
      deltaY,
      deltaMode: 0,
      shiftKey: false,
      altKey: false,
      preventDefault() {},
      ...fields,
    });
  const scrolled = () =>
    receive({ type: "input.scrolled", capability: "test-cap" });
  const scrolls = () =>
    messages.filter((value) => value.type === "input.scroll");
  wheel(-120, { isTrusted: false });
  wheel(-120, { ctrlKey: true });
  assert.equal(scrolls().length, 0);
  wheel(-120);
  wheel(-80);
  assert.equal(
    scrolls().length,
    1,
    "wheel bursts must wait for the in-flight acknowledgement",
  );
  assert.equal(scrolls()[0].lines, 3);
  scrolled();
  assert.equal(scrolls()[1].lines, 2);
  scrolled();
  receive({
    type: "input.viewport",
    capability: "test-cap",
    viewport: {
      rows: 30,
      alternate_screen: false,
      scrollback: { offset: 20, history_lines: 100 },
    },
  });
  assert.equal(
    (elements["#scrollback"] as { textContent: string }).textContent,
    "20/100",
  );
  wheel(1, { deltaMode: 2 });
  assert.equal(
    scrolls()[2].lines,
    -30,
    "page-wheel units follow the current terminal height",
  );
  wheel(80);
  emit("compositionstart");
  emit("input", { isComposing: true, data: "日本" });
  emit("compositionend", { data: "日本" });
  scrolled();
  assert.equal(
    scrolls().length,
    3,
    "committed text cancels queued scrolling without waiting for its acknowledgement",
  );
  emit("input", { isComposing: false, data: "日本" });
  emit("keydown", { key: "Dead" });
  emit("input", { data: "é" });
  emit("paste", { clipboardData: { getData: () => "pasted\ntext" } });
  emit("input", { isTrusted: false, data: "forged" });
  const sent = () => messages.filter((value) => value.type === "input.send");
  assert.deepEqual(
    sent().map((value) => [value.kind, value.value]),
    [
      ["text", "日本"],
      ["text", "é"],
      ["paste", "pasted\ntext"],
    ],
  );
  for (const alternate_screen of [false, true]) {
    receive({
      type: "input.viewport",
      capability: "test-cap",
      viewport: {
        rows: 30,
        alternate_screen,
        scrollback: { offset: 0, history_lines: 0 },
      },
    });
    const before = scrolls().length;
    wheel(-40);
    assert.equal(
      scrolls().length,
      before + 1,
      "apps must receive wheel input even without emulator history",
    );
    scrolled();
  }
  wheel(-40, { shiftKey: true, altKey: true });
  assert.equal(scrolls().at(-1)?.shift, true);
  assert.equal(scrolls().at(-1)?.alt, true);
  scrolled();
  const beforeBurst = scrolls().length;
  wheel(-4000);
  assert.equal(
    scrolls().at(-1)?.lines,
    64,
    "application wheel writes must stay bounded per request",
  );
  scrolled();
  assert.equal(scrolls().length, beforeBurst + 2);
  assert.equal(
    scrolls().at(-1)?.lines,
    36,
    "remaining motion must not be dropped",
  );
  scrolled();
  wheel(-40);
  wheel(-80);
  wheel(-40, { shiftKey: true });
  scrolled();
  assert.equal(scrolls().at(-1)?.shift, true);
  assert.equal(
    scrolls().at(-1)?.lines,
    1,
    "changing to the history override must discard queued app-directed motion",
  );
  scrolled();
  const beforeBlur = scrolls().length;
  emit("compositionstart");
  windowListeners.get("blur")!({});
  emit("compositionend", { data: "late" });
  emit("input", { data: "late" });
  assert.equal(sent().length, 3);
  assert.equal(sink.value, "");
  assert.equal(sink.disabled, true);
  scrolled();
  wheel(-120);
  assert.equal(scrolls().length, beforeBlur);
});
