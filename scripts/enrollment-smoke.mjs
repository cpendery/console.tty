import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execute = promisify(execFile);
const cli = process.platform === "win32" ? "console-tty.exe" : "console-tty";
const tui = process.platform === "win32" ? "tui-test.exe" : "tui-test";
const run = async (program, args) =>
  (await execute(program, args, { timeout: 30000 })).stdout;
const root = await mkdtemp(path.join(tmpdir(), "console-tty-enrollment-"));
const suffix = randomUUID().slice(0, 8);
const sessions = [`ctty-deny-${suffix}`, `ctty-approve-${suffix}`];
const terminal = (session, args) => run(tui, ["--session", session, ...args]);
let context;
let worker;
let clientId;
let documentSession;

const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<!doctype html><title>console.tty enrollment smoke</title>Enrollment smoke test",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

async function closeTestShell(verifyClosed = false) {
  if (!worker || !documentSession?.session) return;
  const existed = await worker.evaluate(
    async ({ session, verifyClosed }) => {
      const { manualGrant } = await chrome.storage.session.get("manualGrant");
      if (!manualGrant) throw new Error("Missing test enrollment for cleanup");
      const port = chrome.runtime.connectNative("dev.console_tty");
      const pending = new Map();
      port.onMessage.addListener((reply) => {
        const request = pending.get(reply.request_id);
        if (!request) return;
        pending.delete(reply.request_id);
        globalThis.clearTimeout(request.timer);
        if (reply.error) request.reject(new Error(reply.error));
        else request.resolve(reply.result);
      });
      port.onDisconnect.addListener(() => {
        const error = new Error(
          chrome.runtime.lastError?.message ?? "Native host disconnected",
        );
        for (const request of pending.values()) {
          globalThis.clearTimeout(request.timer);
          request.reject(error);
        }
        pending.clear();
      });
      const call = (type, params) =>
        new Promise((resolve, reject) => {
          const request_id = globalThis.crypto.randomUUID();
          const timer = setTimeout(
            () => reject(new Error("Native cleanup timed out")),
            10000,
          );
          pending.set(request_id, { resolve, reject, timer });
          port.postMessage({ version: 1, request_id, type, params });
        });
      try {
        await call("authenticate", {
          client_id: manualGrant.client_id,
          credential: manualGrant.credential,
        });
        const sessions = await call("list", {});
        const exists = sessions.some(
          (candidate) => candidate.session_id === session,
        );
        if (exists && !verifyClosed) {
          await call("attach", { session_id: session });
          await call("close", { session_id: session });
        }
        return exists;
      } finally {
        port.disconnect();
      }
    },
    { session: documentSession.session, verifyClosed },
  );
  if (verifyClosed)
    assert.equal(
      existed,
      false,
      "console.tty.close() must remove its real backend session",
    );
  documentSession = undefined;
}

try {
  const state = JSON.parse(await run(cli, ["daemon", "status"]));
  assert.equal(
    state.pairing_required,
    true,
    "the daemon must require explicit enrollment",
  );
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
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => typeof console.tty?.pair === "function");
  const pendingRequest = page.waitForEvent("console", {
    predicate: (event) => event.text().includes("Pair request id:"),
  });
  assert.equal(await page.evaluate(() => console.tty.pair()), undefined);
  await pendingRequest;
  const title = await worker.evaluate(() => chrome.action.getTitle({}));
  const requestId = title.match(/enrollment ([a-f0-9]{8})/)?.[1];
  assert(requestId, "trusted toolbar must identify the pending request");
  assert.equal(
    await worker.evaluate(() => chrome.action.getBadgeText({})),
    "PAIR",
  );
  assert.equal(await worker.evaluate(() => chrome.action.getPopup({})), "");

  for (const [index, answer] of ["n", "y"].entries()) {
    const session = sessions[index];
    await terminal(session, [
      "run",
      "--cols",
      "100",
      "--rows",
      "30",
      "--cwd",
      process.cwd(),
      cli,
      "pair",
    ]);
    await terminal(session, [
      "expect",
      "text",
      requestId,
      "--timeout",
      "10000",
    ]);
    if ((await terminal(session, ["text"])).includes("Request ID to approve:"))
      await terminal(session, ["submit", requestId]);
    await terminal(session, [
      "expect",
      "text",
      `Approve browser request ${requestId}? [y/N]`,
      "--timeout",
      "10000",
    ]);
    const connected =
      answer === "y"
        ? page.waitForEvent("console", {
            predicate: (event) => event.text().includes("Connected."),
            timeout: 15000,
          })
        : undefined;
    await terminal(session, ["submit", answer]);
    await terminal(session, [
      "expect",
      "text",
      answer === "y"
        ? `Approved browser request ${requestId}`
        : "Not approved.",
      "--timeout",
      "10000",
    ]);
    await terminal(session, ["wait", "exit", "--timeout", "10000"]);
    // Direct apps report a process exit, not the last shell-integration command.
    const exited = JSON.parse(await terminal(session, ["--json", "state"]));
    assert.equal(exited.data.exited, 0);
    if (connected) await connected;
    else
      assert.equal(
        await worker.evaluate(() => chrome.action.getBadgeText({})),
        "PAIR",
      );
  }
  clientId = await worker.evaluate(
    async () =>
      (await chrome.storage.local.get("enrollment")).enrollment?.client_id,
  );
  assert(clientId, "approved manual client metadata must be saved");
  await page.evaluate(() => {
    console.tty.status();
    console.tty.connect();
    console.tty();
  });
  documentSession = await worker.evaluate(async (testUrl) => {
    for (let i = 0; i < 250; i++) {
      const { documents } = await chrome.storage.session.get("documents");
      const doc = documents?.find(
        (candidate) => candidate.url === testUrl && candidate.session,
      );
      if (doc)
        return { tab: doc.tab, document: doc.document, session: doc.session };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The approved browser did not attach a real shell");
  }, url);
  await worker.evaluate(async (doc) => {
    await chrome.scripting.executeScript({
      target: { tabId: doc.tab, documentIds: [doc.document] },
      world: "ISOLATED",
      func: () => {
        globalThis.__enrollmentSmokeSize = undefined;
        chrome.runtime.onMessage.addListener((message) => {
          if (message.type === "terminal.snapshot")
            globalThis.__enrollmentSmokeSize = {
              cols: message.snapshot.cols,
              rows: message.snapshot.rows,
            };
        });
      },
    });
  }, documentSession);
  assert.equal(
    await page.evaluate(() => console.tty.resize(120, 32)),
    undefined,
  );
  const size = await worker.evaluate(async (doc) => {
    for (let i = 0; i < 250; i++) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: doc.tab, documentIds: [doc.document] },
        world: "ISOLATED",
        func: () => globalThis.__enrollmentSmokeSize,
      });
      if (result.result?.cols === 120 && result.result?.rows === 32)
        return result.result;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Public resize did not update the real terminal snapshot");
  }, documentSession);
  assert.deepEqual(size, { cols: 120, rows: 32 });
  const closed = page.waitForEvent("console", {
    predicate: (event) =>
      event.text().includes("Current terminal session closed."),
  });
  assert.equal(await page.evaluate(() => console.tty.close()), undefined);
  await closed;
  await closeTestShell(true);
  console.log(
    "Real enrollment passed: local approval, private credential claim, real shell attachment, public resize, and scoped close.",
  );
} finally {
  if (worker && !clientId)
    clientId = await worker
      .evaluate(
        async () =>
          (await chrome.storage.local.get("enrollment")).enrollment?.client_id,
      )
      .catch(() => undefined);
  if (worker && !documentSession)
    documentSession = await worker
      .evaluate(
        async (testUrl) =>
          (await chrome.storage.session.get("documents")).documents?.find(
            (doc) => doc.url === testUrl && doc.session,
          ),
        url,
      )
      .catch(() => undefined);
  if (documentSession) await closeTestShell().catch(() => {});
  for (const session of sessions)
    await terminal(session, ["close"]).catch(() => {});
  await context?.close();
  if (clientId) await run(cli, ["client", "revoke", clientId]);
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
