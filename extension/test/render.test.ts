import assert from "node:assert/strict";
import test from "node:test";
import { CssConsoleDriver } from "@textjs/core";
import {
  boundedSize,
  createRenderer,
  createViewport,
  toBuffer,
} from "../src/render";
import type { Snapshot, DisplayConfig } from "../src/protocol";

const config: DisplayConfig = {
  render: {
    max_fps: 15,
    responsive: true,
    padding_cols: 2,
    padding_rows: 1,
    frame_spacing: true,
  },
  terminal: { cols: 100, rows: 30, shell: "bash" },
  shortcut: "Ctrl+Shift+9",
};

test("Text.js adapter preserves combining/wide text and blank backgrounds without clearing", () => {
  const snapshot: Snapshot = {
    session_id: "test",
    revision: 1,
    cols: 6,
    rows: 2,
    alternate_screen: false,
    exited: null,
    cursor: { x: 5, y: 1, visible: false, shape: "Block" },
    cells: [
      ["A", 1, 0xff0000, 0, 1],
      ["界", 2, 0xffffff, 0, 0],
      [" ", 0, 0xffffff, 0, 0],
      ["e\u0301", 1, 0xffffff, 0, 2],
      ["%", 1, 0xffffff, 0, 0],
      [" ", 1, 0xffffff, 0x0044ff, 0],
      ...Array.from(
        { length: 6 },
        () =>
          [" ", 1, 0xffffff, 0, 0] as [string, number, number, number, number],
      ),
    ],
  };
  const calls: unknown[][] = [];
  let clears = 0;
  const driver = new CssConsoleDriver({
    console: {
      clear: () => {
        clears++;
      },
      log: (...args) => calls.push(args),
    },
    clear: "never",
    initialClear: false,
    measureText: false,
  });
  const buffer = toBuffer(snapshot);
  driver.render(buffer);
  driver.render(buffer);
  assert.equal(calls.length, 1);
  assert.equal(clears, 0);
  assert(String(calls[0][0]).includes("界"));
  assert(String(calls[0][0]).includes("e\u0301"));
  assert(String(calls[0][0]).includes("%%"));
  assert(calls[0].some((arg) => String(arg).includes("#0044ff")));
});

test("padded frames preserve terminal cells and show input state without clearing console history", () => {
  const snapshot: Snapshot = {
    session_id: "padded",
    revision: 1,
    cols: 60,
    rows: 4,
    alternate_screen: false,
    exited: null,
    cursor: { x: 0, y: 1, visible: false, shape: "Block" },
    cells: Array.from({ length: 240 }, (_, i) => [
      i === 0 ? "A" : " ",
      1,
      0xffffff,
      0x1d1f21,
      0,
    ]),
  };
  const buffer = toBuffer(snapshot, config.render, {
    live: false,
    shortcut: config.shortcut,
  });
  assert.equal(buffer.width, 64);
  assert.equal(buffer.height, 7);
  assert.equal(buffer.getCell(0, 0)?.char, " ");
  assert.equal(buffer.getCell(2, 1)?.char, "A");
  assert.match(buffer.rowText(6), /Ctrl\+Shift\+9/);
  const calls: unknown[][] = [];
  let clears = 0;
  const renderer = createRenderer({
    clear: () => {
      clears++;
    },
    log: (...args) => {
      calls.push(args);
    },
  });
  renderer.configure(config);
  renderer.render(snapshot);
  renderer.render(snapshot);
  renderer.inputLive(true);
  assert.equal(calls.length, 2);
  assert.equal(clears, 0);
  assert.match(String(calls[0][1]), /margin-top:100vh/);
  assert.match(String(calls[1][0]), /console.tty input live/);
  const history = {
    ...snapshot,
    revision: 2,
    scrollback: { offset: 4, history_lines: 80 },
  };
  renderer.render(history);
  assert.match(String(calls[2][0]), /Scrollback 4\/80/);
  assert.match(
    toBuffer(history, config.render, {
      live: true,
      shortcut: config.shortcut,
    }).rowText(6),
    /Shift\+End or type to go live/,
  );
});

test("Text.js viewport follows docked width and height, subtracts padding, and bounds the PTY", () => {
  const win = {
    innerWidth: 1000,
    outerWidth: 1000,
    innerHeight: 500,
    outerHeight: 1000,
    devicePixelRatio: 1,
  };
  const viewport = createViewport(config, win);
  const tall = viewport.getSize();
  assert.equal(tall.dock, "bottom");
  win.innerHeight = 650;
  const short = viewport.refresh();
  assert(short.rows < tall.rows);
  assert.equal(short.cols, tall.cols);
  win.innerWidth = 700;
  win.innerHeight = 880;
  const side = viewport.refresh();
  assert.equal(side.dock, "side");
  assert(side.cols < short.cols);
  assert(side.rows > short.rows);
  win.innerWidth = 1000;
  const fallback = viewport.refresh();
  assert.equal(fallback.dock, "undocked");
  assert.equal(fallback.cols, 100);
  assert.equal(fallback.rows, 30);
  const maximum = boundedSize({ cols: 10000, rows: 10000 });
  assert(maximum.cols * maximum.rows <= 12000);
  viewport.dispose();
});
