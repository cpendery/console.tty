import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = await mkdtemp(path.join(tmpdir(), "console-tty-native-browser-"));
let context;
try {
  const extension = path.resolve("dist", "extension");
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
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const result = await worker.evaluate(async () => {
    const port = chrome.runtime.connectNative("dev.console_tty");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        port.disconnect();
        resolve({ error: "Native host timed out" });
      }, 10000);
      port.onDisconnect.addListener(() => {
        globalThis.clearTimeout(timer);
        resolve({
          error:
            chrome.runtime.lastError?.message ?? "Native host disconnected",
        });
      });
      port.onMessage.addListener((reply) => {
        globalThis.clearTimeout(timer);
        resolve({
          version: reply.version,
          request_id: reply.request_id,
          error: reply.error,
          schema_version: reply.result?.schema_version,
          daemon_available: reply.result?.daemon_available,
          render: reply.result?.settings?.render,
          shell: reply.result?.settings?.terminal?.shell,
        });
        port.disconnect();
      });
      port.postMessage({
        version: 1,
        request_id: "native-browser-smoke",
        type: "config.get",
        params: {},
      });
    });
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.version, 1);
  assert.equal(result.request_id, "native-browser-smoke");
  assert.equal(result.schema_version, 1);
  assert.equal(typeof result.daemon_available, "boolean");
  assert.equal(typeof result.render?.responsive, "boolean");
  assert.equal(typeof result.render?.padding_cols, "number");
  assert.equal(typeof result.render?.padding_rows, "number");
  assert.equal(typeof result.render?.frame_spacing, "boolean");
  assert(
    [
      "bash",
      "zsh",
      "fish",
      "nu",
      "xonsh",
      "sh",
      "cmd",
      "powershell",
      "pwsh",
    ].includes(result.shell),
  );
  console.log(
    `Real browser Native Messaging passed (daemon available: ${result.daemon_available}).`,
  );
} finally {
  await context?.close();
  await rm(root, { recursive: true, force: true });
}
