import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  cp,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { inflateSync } from "node:zlib";

async function pixelAt(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  assert.equal(png[24], 8);
  assert([2, 6].includes(png[25]), "pixel sample must be RGB or RGBA");
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  // The first pixel has no left/previous-row predictor under any PNG row filter.
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}

const root = await mkdtemp(path.join(tmpdir(), "console-tty-browser-"));
const extension = path.join(root, "extension");
let context;
let worker;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<!doctype html><title>console.tty browser test</title><input id='page-input' aria-label='Page input'><p>Fixture page</p>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  await cp(path.resolve("dist", "extension"), extension, { recursive: true });
  const workerPath = path.join(extension, "worker.js");
  const mock = await readFile(
    path.resolve("extension", "test", "fixtures", "native-mock.js"),
    "utf8",
  );
  await writeFile(workerPath, `${mock}\n${await readFile(workerPath, "utf8")}`);
  const executablePath =
    process.env.CONSOLE_TTY_BROWSER ??
    (process.platform === "win32"
      ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      : undefined);
  context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    executablePath,
    channel: executablePath ? undefined : "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  assert.equal(await worker.evaluate(() => chrome.action.getPopup({})), "");
  await assert.rejects(access(path.join(extension, "popup.html")));
  assert(
    !(await worker.evaluate(() =>
      globalThis.__nativeState.calls.includes("list"),
    )),
  );
  assert.equal(
    await worker.evaluate(
      async () =>
        (await chrome.commands.getAll()).find(
          (command) => command.name === "toggle-terminal-input",
        ).shortcut,
    ),
    "Ctrl+Shift+9",
  );
  const page = await context.newPage();
  const logs = [];
  page.on("console", (event) => logs.push(event.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof console.tty === "function", {
    timeout: 10000,
  });
  const isPairingError = (event) =>
    event.type() === "error" && event.text().includes("Pairing required.");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const firstError = page.waitForEvent("console", {
      predicate: isPairingError,
    });
    await page.evaluate(() => console.tty());
    await firstError;
    await assert.rejects(
      page.waitForEvent("console", { predicate: isPairingError, timeout: 250 }),
      /Timeout/,
    );
    assert.equal(
      logs.filter((line) => line.includes("Pairing required.")).length,
      attempt,
      "each failed invocation should produce one error, without suppressing later calls",
    );
  }
  await worker.evaluate(() => {
    globalThis.__nativeState.pairingRequired = false;
  });
  const bypassRefused = page.waitForEvent("console", {
    predicate: (event) =>
      event.type() === "error" && event.text().includes("must require pairing"),
  });
  await page.evaluate(() => console.tty());
  await bypassRefused;
  assert.equal(
    await worker.evaluate(() =>
      globalThis.__nativeState.calls.includes("create"),
    ),
    false,
    "an authenticated status from a pairing-disabled backend must never grant shell access",
  );
  await worker.evaluate(() => {
    globalThis.__nativeState.pairingRequired = true;
  });
  const unpaired = page.waitForEvent("console", {
    predicate: (event) => event.text().includes("Not paired."),
  });
  assert.equal(await page.evaluate(() => console.tty.connect()), undefined);
  await unpaired;
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.enrollmentRequests),
    0,
  );
  await worker.evaluate(() => {
    globalThis.__nativeState.failConfig = true;
  });
  const unavailable = page.waitForEvent("console", {
    predicate: (event) => event.text().includes("Daemon unavailable."),
  });
  await page.evaluate(() => console.tty.status());
  await unavailable;
  await worker.evaluate(() => {
    globalThis.__nativeState.failConfig = false;
  });
  const recovered = page.waitForEvent("console", {
    predicate: (event) => event.text().includes("Not paired."),
  });
  await page.evaluate(() => console.tty.connect());
  await recovered;
  await page.evaluate(() => {
    globalThis.__bridgeMessages = [];
    window.addEventListener("message", (event) => {
      if (event.source === window) globalThis.__bridgeMessages.push(event.data);
    });
  });
  const pending = page.waitForEvent("console", {
    predicate: (event) => event.text().includes("Pair request id:"),
  });
  assert.equal(await page.evaluate(() => console.tty.pair()), undefined);
  const pendingMessage = await pending;
  const requestId = await worker.evaluate(
    () => globalThis.__nativeState.pendingRequest,
  );
  assert.equal(
    pendingMessage.text(),
    `[console.tty] Pair request id: ${requestId}. Run \`console-tty pair ${requestId}\` in local terminal to connect.`,
  );
  assert.equal(
    await worker.evaluate(() => chrome.action.getBadgeText({})),
    "PAIR",
  );
  assert(
    (await worker.evaluate(() => chrome.action.getTitle({}))).includes(
      requestId,
    ),
  );
  await page.evaluate(() => {
    console.tty.pair();
    console.tty.pair("secret");
    console.tty.help();
  });
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.enrollmentRequests),
    1,
  );
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.creates),
    0,
  );
  assert(
    !JSON.stringify(
      await page.evaluate(() => globalThis.__bridgeMessages),
    ).includes("secret"),
  );
  const connected = page.waitForEvent("console", {
    predicate: (event) => event.text().includes("Connected."),
  });
  await worker.evaluate(() => {
    globalThis.__nativeState.approved = true;
  });
  await connected;
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "");
  assert.equal(await page.evaluate(() => console.tty()), undefined);
  assert(
    await page.evaluate(() =>
      ["write", "list", "attach"].every(
        (key) => console.tty[key] === undefined,
      ),
    ),
  );
  await page
    .waitForFunction(() => false, undefined, { timeout: 400 })
    .catch(() => {});
  assert(
    logs.some((log) => log.includes("demo shell ready")),
    logs.join("\n"),
  );
  await page.evaluate(() => {
    console.tty();
    console.tty({ command: "bad" });
    window.postMessage(
      { type: "console.tty.start.v1", input: "bad" },
      location.origin,
    );
  });
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.creates),
    1,
  );
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.input.length),
    0,
  );
  await page.evaluate(() => console.tty.resize(96, 25));
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if (
        globalThis.__nativeState.resizes.some(
          (size) => size.cols === 96 && size.rows === 25,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Public resize did not reach the selected PTY");
  });
  await page.evaluate(() => console.tty.resize());
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const size = globalThis.__nativeState.resizes.at(-1);
      if (size?.cols === 40 && size.rows === 5) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      "Restoring automatic fitting did not restore the undocked fallback size",
    );
  });

  const originalViewport = page.viewportSize();
  const resizeCount = await worker.evaluate(
    () => globalThis.__nativeState.resizes.length,
  );
  await page.setViewportSize({ width: 900, height: 500 });
  const terminalTab = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  );
  assert.equal(
    await worker.evaluate(async (tabId) => {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: () => typeof console.tty,
      });
      return result[0].result;
    }, terminalTab),
    "undefined",
  );
  await worker.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        // Headless Chromium has no docked DevTools; model its observable window metrics.
        globalThis.__testWindowMetrics = {
          outerWidth: Object.getOwnPropertyDescriptor(window, "outerWidth"),
          outerHeight: Object.getOwnPropertyDescriptor(window, "outerHeight"),
        };
        Object.defineProperty(window, "outerWidth", {
          configurable: true,
          value: window.innerWidth,
        });
        Object.defineProperty(window, "outerHeight", {
          configurable: true,
          value: window.innerHeight + 500,
        });
        window.dispatchEvent(new Event("resize"));
      },
    });
  }, terminalTab);
  const resized = await worker.evaluate(async (before) => {
    for (let i = 0; i < 100; i++) {
      if (globalThis.__nativeState.resizes.length > before)
        return globalThis.__nativeState.resizes.at(-1);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Responsive terminal resize did not reach the backend");
  }, resizeCount);
  assert(
    resized.cols >= 2 &&
      resized.rows >= 2 &&
      resized.cols * resized.rows <= 12000,
  );
  assert(resized.cols !== 40 || resized.rows !== 5);
  await worker.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        Object.defineProperties(window, globalThis.__testWindowMetrics);
        delete globalThis.__testWindowMetrics;
        window.dispatchEvent(new Event("resize"));
      },
    });
  }, terminalTab);
  await page.setViewportSize(originalViewport);

  await page.evaluate(() => {
    globalThis.__probes = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "console.tty.frame-probe")
        globalThis.__probes.push({
          origin: event.origin,
          matches:
            event.source === document.querySelector("iframe")?.contentWindow,
        });
    });
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => {
    document.documentElement.style.colorScheme = "dark";
    document.documentElement.style.backgroundColor = "rgb(40, 80, 120)";
    document.body.style.backgroundColor = "rgb(40, 80, 120)";
    const style = document.createElement("style");
    style.textContent =
      "iframe { background: white !important; color-scheme: dark !important; }";
    document.head.append(style);
  });
  assert.deepEqual(await pixelAt(page, 700, 300), [40, 80, 120]);
  // CDP input does not invoke browser accelerators in headless mode; exercise the registered handler.
  await worker.evaluate(() => globalThis.__testCommand());
  const frame = page.frameLocator(
    `iframe[src="chrome-extension://${id}/input.html"]`,
  );
  await frame
    .locator("#badge")
    .filter({ hasText: "console.tty input live" })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await worker.evaluate(() => chrome.action.getBadgeText({})),
    "LIVE",
  );
  assert.equal(
    await frame.locator("body").evaluate((body) => body.style.backgroundColor),
    "rgba(0, 0, 0, 0.12)",
  );
  const dimmed = await pixelAt(page, 700, 300);
  assert(
    dimmed.every((channel, i) => Math.abs(channel - [35, 70, 106][i]) <= 2),
    `overlay must dim the existing dark-themed page, not replace it; got ${dimmed}`,
  );
  for (const browserScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: browserScheme });
    for (const pageScheme of ["light", "dark", "light dark", "normal"]) {
      await page.evaluate((scheme) => {
        document.documentElement.style.colorScheme = scheme;
      }, pageScheme);
      const sample = await pixelAt(page, 700, 300);
      assert(
        sample.every((channel, i) => Math.abs(channel - [35, 70, 106][i]) <= 2),
        `overlay replaced the page for browser=${browserScheme}, page=${pageScheme}: ${sample}`,
      );
    }
  }
  const stage = await frame.locator(".indicator").boundingBox();
  assert(
    stage.width < 500 &&
      stage.height < 60 &&
      stage.x < 30 &&
      Math.abs(stage.y + stage.height - (page.viewportSize().height - 18)) < 2,
  );
  if (process.env.CONSOLE_TTY_SCREENSHOT_DIR) {
    await mkdir(process.env.CONSOLE_TTY_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(
        process.env.CONSOLE_TTY_SCREENSHOT_DIR,
        "console-tty-live.png",
      ),
    });
  }
  await page.mouse.click(700, 300);
  assert(
    await frame
      .locator("#sink")
      .evaluate((sink) => document.activeElement === sink),
  );
  await page.mouse.wheel(0, -160);
  await frame.locator("#scrollback").filter({ hasText: "4/100" }).waitFor();
  const wheelScrolls = await worker.evaluate(
    () => globalThis.__nativeState.scrolls,
  );
  assert.equal(wheelScrolls.length, 1);
  assert.equal(wheelScrolls[0].lines, 4);
  await worker.evaluate((id) => {
    const session = globalThis.__nativeState.sessions.find(
      (session) => session.session_id === id,
    );
    session.appMouse = session.alternate_screen = true;
    session.offset = 0;
    session.revision++;
  }, wheelScrolls[0].session_id);
  await frame.locator("#scrollback").waitFor({ state: "hidden" });
  await page.mouse.wheel(0, -120);
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if (globalThis.__nativeState.appScrolls.length === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      "Wheel input was swallowed by an alternate-screen app without emulator history",
    );
  });
  await page.keyboard.down("Shift");
  try {
    await page.mouse.wheel(0, -120);
  } finally {
    await page.keyboard.up("Shift");
  }
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if (globalThis.__nativeState.scrolls.some((scroll) => scroll.shift))
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      "Shift+wheel did not reach the backend's terminal-history override",
    );
  });
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.appScrolls.length),
    1,
  );
  await worker.evaluate((id) => {
    const session = globalThis.__nativeState.sessions.find(
      (session) => session.session_id === id,
    );
    session.appMouse = session.alternate_screen = false;
    session.offset = 2;
    session.revision++;
  }, wheelScrolls[0].session_id);
  await frame.locator("#scrollback").filter({ hasText: "2/100" }).waitFor();
  await page.keyboard.press("Shift+End");
  await frame.locator("#scrollback").waitFor({ state: "hidden" });
  await page.keyboard.press("Shift+PageUp");
  await frame.locator("#scrollback").waitFor({ state: "visible" });
  await page.keyboard.type("hello");
  await frame.locator("#scrollback").waitFor({ state: "hidden" });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await page.keyboard.type("日本");
  await frame.locator("#sink").evaluate((sink) => {
    sink.value = "forged";
    sink.dispatchEvent(
      new InputEvent("input", { data: "forged", bubbles: true }),
    );
    sink.dispatchEvent(
      new window.WheelEvent("wheel", { deltaY: -120, bubbles: true }),
    );
  });
  await page.evaluate(() =>
    window.postMessage(
      { type: "input.send", value: "forged" },
      location.origin,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const input = await worker.evaluate(() => globalThis.__nativeState.input);
  assert.equal(
    input
      .filter((entry) => entry.kind === "text")
      .map((entry) => entry.value)
      .join(""),
    "hello日本",
  );
  assert(
    input.some((entry) => entry.kind === "key" && entry.value === "Enter"),
  );
  assert(
    input.some(
      (entry) => entry.kind === "key" && entry.value === "c" && entry.ctrl,
    ),
  );
  assert(
    input.some((entry) => entry.kind === "key" && entry.value === "ArrowUp"),
  );
  assert(input.some((entry) => entry.kind === "key" && entry.value === "Tab"));
  assert(
    input.some((entry) => entry.kind === "key" && entry.value === "Escape"),
  );
  assert(!input.some((entry) => entry.value.includes("forged")));
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.scrolls.length),
    3,
    "synthetic wheel events must not scroll the terminal",
  );
  const cleanup = await worker.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: async () =>
        (await chrome.runtime.sendMessage({ type: "test.unsupported" })).error,
    });
    return result.result;
  }, terminalTab);
  assert.equal(cleanup, "Unsupported extension operation");
  await page
    .locator(`iframe[src="chrome-extension://${id}/input.html"]`)
    .waitFor({ state: "detached" });
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "");
  assert.equal(
    logs.filter((line) => line.includes("Unsupported extension operation"))
      .length,
    0,
    "reply-owned errors must still clear input without adding a pushed console error",
  );

  await worker.evaluate(() => globalThis.__testCommand());
  await frame
    .locator("#badge")
    .filter({ hasText: "console.tty input live" })
    .waitFor();
  const stillConnected = page.waitForEvent("console", {
    predicate: (event) => event.text().includes("Connected."),
  });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("console.tty.renderer-ready"));
    console.tty.status();
  });
  await stillConnected;
  await frame
    .locator("#badge")
    .filter({ hasText: "console.tty input live" })
    .waitFor();
  await worker.evaluate(() => {
    globalThis.__nativeState.revision = "fixture-v2";
    globalThis.__testAlarm();
  });
  await page
    .locator(`iframe[src="chrome-extension://${id}/input.html"]`)
    .waitFor({ state: "detached" });
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "");

  await worker.evaluate(() => {
    globalThis.__getCommands = chrome.commands.getAll;
    chrome.commands.getAll = async () => [
      { name: "toggle-terminal-input", shortcut: "Ctrl+Y" },
    ];
    globalThis.__testCommand();
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    await page
      .locator(`iframe[src="chrome-extension://${id}/input.html"]`)
      .count(),
    0,
  );
  assert.match(
    await worker.evaluate(() => chrome.action.getTitle({})),
    /shortcut unassigned or overridden/,
  );
  await worker.evaluate(() => {
    chrome.commands.getAll = globalThis.__getCommands;
  });

  await worker.evaluate(() => globalThis.__testCommand());
  await frame
    .locator("#badge")
    .filter({ hasText: "console.tty input live" })
    .waitFor();
  await page.evaluate(() => document.querySelector("#page-input").focus());
  await page
    .locator(`iframe[src="chrome-extension://${id}/input.html"]`)
    .waitFor({ state: "detached" });
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "");

  await page.evaluate((id) => {
    const copy = document.createElement("iframe");
    copy.id = "forged-frame";
    copy.src = `chrome-extension://${id}/input.html`;
    document.body.append(copy);
  }, id);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.notEqual(
    await page.frameLocator("#forged-frame").locator("#badge").textContent(),
    "console.tty input live",
  );
  await page.reload();
  await page.waitForFunction(() => typeof console.tty === "function");
  await page.evaluate(() => console.tty());
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.creates),
    2,
  );
  await page.evaluate(() => console.tty("nu"));
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if (globalThis.__nativeState.creates === 3) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Known shell selection did not create a new session");
  });
  await page.evaluate(() => console.tty("bash"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.creates),
    3,
  );
  assert.equal(
    await worker.evaluate(() => globalThis.__nativeState.sessions.length),
    3,
  );
  await worker.evaluate(() => {
    globalThis.__nativeState.failConfig = true;
  });
  const recoveringPage = await context.newPage();
  const bootstrapFailure = recoveringPage.waitForEvent("console", {
    predicate: (event) =>
      event.text().includes("Fixture configuration temporarily unavailable"),
  });
  await recoveringPage.goto(
    `http://127.0.0.1:${server.address().port}/recover-bootstrap`,
  );
  await bootstrapFailure;
  assert.equal(
    await recoveringPage.evaluate(() => typeof console.tty),
    "function",
  );
  await worker.evaluate(() => {
    globalThis.__nativeState.failConfig = false;
  });
  const restored = recoveringPage.waitForEvent("console", {
    predicate: (event) => event.text().includes("Connected."),
  });
  await recoveringPage.evaluate(() => console.tty.connect());
  await restored;
  await recoveringPage.waitForFunction(
    () => typeof console.tty === "function",
    undefined,
    { timeout: 5000 },
  );
  await recoveringPage.evaluate(() => {
    delete console.tty;
  });
  await recoveringPage.reload();
  await recoveringPage.waitForFunction(
    () => typeof console.tty === "function",
    undefined,
    { timeout: 5000 },
  );
  const otherShell = recoveringPage.waitForEvent("console", {
    predicate: (event) => event.text().includes("demo shell ready"),
  });
  await recoveringPage.evaluate(() => console.tty("fish"));
  await otherShell;
  const currentSession = await worker.evaluate(
    async (testUrl) =>
      (await chrome.storage.session.get("documents")).documents.find(
        (doc) => doc.url === testUrl && doc.session,
      )?.session,
    page.url(),
  );
  assert(currentSession);
  const otherSessions = await worker.evaluate(
    (selected) =>
      globalThis.__nativeState.sessions
        .filter((session) => session.session_id !== selected)
        .map((session) => session.session_id),
    currentSession,
  );
  await page.bringToFront();
  await worker.evaluate(() => globalThis.__testCommand());
  await frame
    .locator("#badge")
    .filter({ hasText: "console.tty input live" })
    .waitFor();
  const closed = page.waitForEvent("console", {
    predicate: (event) =>
      event.text().includes("Current terminal session closed."),
  });
  assert.equal(await page.evaluate(() => console.tty.close()), undefined);
  await closed;
  await page
    .locator(`iframe[src="chrome-extension://${id}/input.html"]`)
    .waitFor({ state: "detached" });
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "");
  assert.deepEqual(
    await worker.evaluate(() =>
      globalThis.__nativeState.sessions.map((session) => session.session_id),
    ),
    otherSessions,
  );
  assert.equal(
    await worker.evaluate(
      async (testUrl) =>
        (await chrome.storage.session.get("documents")).documents.find(
          (doc) => doc.url === testUrl,
        )?.session,
      page.url(),
    ),
    undefined,
  );
  assert.equal(
    logs.filter((line) => line.includes("Current terminal session closed."))
      .length,
    1,
  );
  assert(!logs.some((line) => line.includes("shell exited (closed)")));
  await recoveringPage.close();
  await page.bringToFront();
  const reloadCanary = await page.evaluate(() => {
    globalThis.__reloadCanary = globalThis.crypto.randomUUID();
    return globalThis.__reloadCanary;
  });
  for (let reload = 0; reload < 2; reload++) {
    await page.evaluate(() => console.tty());
    await worker.evaluate(async (testUrl) => {
      for (let i = 0; i < 100; i++) {
        const { documents } = await chrome.storage.session.get("documents");
        if (documents?.some((doc) => doc.url === testUrl && doc.session))
          return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Terminal was not selected before extension reload");
    }, page.url());
    await worker.evaluate(() => globalThis.__testCommand());
    await frame
      .locator("#badge")
      .filter({ hasText: "console.tty input live" })
      .waitFor();
    await worker.evaluate(() => chrome.storage.session.remove("manualGrant"));
    const workerUrl = worker.url();
    const replacement = context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url() === workerUrl,
      timeout: 15000,
    });
    await worker
      .evaluate(() => chrome.runtime.reload())
      .catch((error) => {
        if (!/closed|destroyed/i.test(error.message)) throw error;
      });
    worker = await replacement;
    await worker.evaluate(async (tabId) => {
      for (let i = 0; i < 100; i++) {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: () =>
            Boolean(
              globalThis[Symbol.for("console.tty.isolated.v1")] &&
              chrome.runtime.id,
            ),
        });
        if (result.result) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "Replacement renderer was not injected into the existing page",
      );
    }, terminalTab);
    assert.equal(
      await page.evaluate(() => globalThis.__reloadCanary),
      reloadCanary,
      "the webpage must remain loaded while the extension reloads",
    );
    const firstLog = logs.length;
    const pendingAgain = page.waitForEvent("console", {
      predicate: (event) => event.text().includes("Pair request id:"),
    });
    await page.evaluate(() => console.tty.pair());
    await pendingAgain;
    const connectedAgain = page.waitForEvent("console", {
      predicate: (event) => event.text().includes("Connected."),
    });
    await worker.evaluate(() => {
      globalThis.__nativeState.approved = true;
    });
    await connectedAgain;
    await page.evaluate(() => console.tty());
    await worker.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        if (globalThis.__nativeState.creates === 1) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "The new renderer could not start a terminal after re-pairing",
      );
    });
    assert.equal(
      logs
        .slice(firstLog)
        .filter((line) => line.includes("Extension context invalidated"))
        .length,
      0,
      "orphaned content scripts must not report errors alongside a freshly paired renderer",
    );
    assert.equal(
      logs.slice(firstLog).filter((line) => line.includes("Pair request id:"))
        .length,
      1,
    );
    assert.equal(
      logs.slice(firstLog).filter((line) => line.includes("Connected.")).length,
      1,
    );
    assert.equal(
      await page
        .locator(`iframe[src="chrome-extension://${id}/input.html"]`)
        .count(),
      0,
      "a reloaded extension must remove its old input overlay",
    );
  }
  console.log(
    "Browser integration passed: console controls, isolated input, scoped close, single errors, and recovery across extension reloads without refreshing the webpage.",
  );
} catch (error) {
  if (worker)
    console.error(
      "Native fixture state:",
      JSON.stringify(
        await worker
          .evaluate(() => globalThis.__nativeState)
          .catch(() => "unavailable"),
      ),
    );
  if (worker)
    console.error(
      "Extension diagnostic:",
      await worker
        .evaluate(() => chrome.action.getTitle({}))
        .catch(() => "unavailable"),
    );
  if (context)
    for (const page of context.pages()) {
      console.error(
        "Probes:",
        await page.evaluate(() => globalThis.__probes).catch(() => null),
      );
      console.error(
        "Page frames:",
        page.frames().map((frame) => frame.url()),
      );
      for (const frame of page.frames())
        if (frame.url().endsWith("/input.html"))
          console.error(
            "Input state:",
            await frame
              .locator("body")
              .innerText()
              .catch(() => "unavailable"),
          );
    }
  throw error;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
