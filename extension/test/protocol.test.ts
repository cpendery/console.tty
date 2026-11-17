import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_TYPE,
  supportedSite,
  parseConfig,
  publicStart,
  shortcutMatches,
  validateSnapshot,
  PUBLIC_RESIZE,
  publicResize,
  PUBLIC_CONTROL,
  publicControl,
} from "../src/protocol";

test("the public bridge accepts only known shell names and bounded resize requests", () => {
  assert(publicStart({ type: PUBLIC_TYPE }));
  assert(publicStart({ type: PUBLIC_TYPE, shell: "nu" }));
  for (const value of [
    { type: PUBLIC_TYPE, command: "cmd.exe" },
    { type: PUBLIC_TYPE, input: "whoami" },
    { type: PUBLIC_TYPE, session_id: "stolen" },
    { type: "config.get" },
    { type: "input.send", value: "whoami\r" },
    { type: PUBLIC_TYPE, cols: 80 },
    { type: PUBLIC_TYPE, shell: "bash -c whoami" },
    { type: PUBLIC_TYPE, shell: "/bin/bash" },
    { type: PUBLIC_TYPE, shell: "python" },
    null,
    PUBLIC_TYPE,
  ])
    assert.equal(publicStart(value), false);
  assert(publicResize({ type: PUBLIC_RESIZE, cols: 120, rows: 32 }));
  assert(publicResize({ type: PUBLIC_RESIZE, fit: true }));
  for (const value of [
    { type: PUBLIC_RESIZE, cols: 0, rows: 20 },
    { type: PUBLIC_RESIZE, cols: 240, rows: 100 },
    { type: PUBLIC_RESIZE, cols: 80, rows: 20, session_id: "other" },
    { type: PUBLIC_RESIZE, fit: true, input: "bad" },
  ])
    assert(!publicResize(value));
  assert(publicControl({ type: PUBLIC_CONTROL, action: "pair" }));
  assert(publicControl({ type: PUBLIC_CONTROL, action: "status" }));
  assert(publicControl({ type: PUBLIC_CONTROL, action: "close" }));
  for (const value of [
    { type: PUBLIC_CONTROL, action: "approve" },
    { type: PUBLIC_CONTROL, action: "pair", code: "secret" },
    { type: PUBLIC_CONTROL, action: "connect", credential: "secret" },
    { type: PUBLIC_CONTROL, action: "close", session_id: "another-tab" },
    { type: PUBLIC_CONTROL, action: { toString: "pair" } },
  ])
    assert(!publicControl(value));
});
test("automatic injection supports HTTP(S) sites but not protected or file schemes", () => {
  for (const url of [
    "https://example.com/tools/a",
    "https://sub.example.com/tools/a?x=1",
    "http://localhost:3000/",
  ]) {
    assert(supportedSite(url), url);
  }
  for (const url of [
    "chrome://extensions",
    "edge://newtab",
    "file:///test",
    "not a URL",
  ])
    assert(!supportedSite(url), url);
});
test("bad effective config and shortcut overrides fail closed", () => {
  for (const value of [
    { schema_version: 2 },
    null,
    { schema_version: 1, revision: "x", daemon_available: false, settings: {} },
  ]) {
    assert.throws(() => parseConfig(value));
  }
  assert(shortcutMatches("Ctrl+Shift+9", false));
  assert(shortcutMatches("⌃⇧9", true));
  assert(!shortcutMatches("Alt+Shift+Y", false));
  assert(!shortcutMatches("Ctrl+Shift+Y", false));
  assert(!shortcutMatches(undefined, false));
});
test("snapshot validation bounds full viewport allocation", () => {
  assert(!validateSnapshot({ cols: 1000000, rows: 1000000, cells: [] }));
  assert(!validateSnapshot({ cols: 2, rows: 2, cells: [] }));
});
test("scrollback metadata is bounded and legacy snapshots remain valid", () => {
  const snapshot = {
    session_id: "history",
    revision: 1,
    cols: 2,
    rows: 2,
    cells: Array.from({ length: 4 }, () => [" ", 1, 0xffffff, 0, 0]),
    cursor: { x: 0, y: 0, visible: false, shape: "Block" },
    alternate_screen: false,
    exited: null,
  };
  assert(validateSnapshot(snapshot));
  assert(
    validateSnapshot({
      ...snapshot,
      scrollback: { offset: 3, history_lines: 100 },
    }),
  );
  for (const scrollback of [
    null,
    {},
    { offset: -1, history_lines: 100 },
    { offset: 101, history_lines: 100 },
    { offset: 0.5, history_lines: 100 },
    { offset: 0, history_lines: 100001 },
  ])
    assert(!validateSnapshot({ ...snapshot, scrollback }));
});
