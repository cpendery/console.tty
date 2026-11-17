import { Native } from "./native";
import {
  TOGGLE,
  supportedSite,
  knownShell,
  dimensions,
  SHORTCUT,
  message,
  parseConfig,
  record,
  shortcutMatches,
  validateSnapshot,
  type EffectiveConfig,
  type RecordValue,
  type Snapshot,
  type DisplayConfig,
  type Shell,
  type ConnectionStatus,
  type InputViewport,
} from "./protocol";

interface DocumentSession {
  tab: number;
  document: string;
  url: string;
  session?: string;
  revision: number;
  shell?: Shell;
  viewport?: InputViewport;
}
interface Activation {
  tab: number;
  document: string;
  session: string;
  capability: string;
  revision: string;
  port?: chrome.runtime.Port;
  frame?: number;
  frameDocument?: string;
  live: boolean;
}
interface Probe {
  port: chrome.runtime.Port;
  frame: number;
  document: string;
  timer: ReturnType<typeof setTimeout>;
}

const native = new Native();
const documents = new Map<string, DocumentSession>();
const starting = new Map<string, Promise<unknown>>();
const pollers = new Map<string, ReturnType<typeof setTimeout>>();
const probes = new Map<string, Probe>();
const enrollmentObservers = new Map<string, DocumentSession>();
let enrollment: { request_id: string; expires: number } | undefined;
let enrollmentTimer: ReturnType<typeof setTimeout> | undefined;
let enrollmentStart: Promise<ConnectionStatus> | undefined;
let enrollmentCheck: Promise<void> | undefined;
let effective: EffectiveConfig | undefined;
let activation: Activation | undefined;
let toggleQueue = Promise.resolve();
let configQueue: Promise<EffectiveConfig> | undefined;
let registrationQueue = Promise.resolve();
let lastError = "";
let epoch = 0;
let previousDaemon: string | undefined;
let recovering = false;
const shortcutLabel = SHORTCUT;
const key = (tab: number, document: string) => `${tab}:${document}`;
const initialized = initialize();

async function initialize(): Promise<void> {
  await chrome.scripting.unregisterContentScripts();
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const saved = await chrome.storage.session.get(["documents", "daemonId"]);
  if (typeof saved.daemonId === "string") previousDaemon = saved.daemonId;
  if (Array.isArray(saved.documents)) {
    for (const candidate of saved.documents) {
      if (
        record(candidate) &&
        typeof candidate.tab === "number" &&
        typeof candidate.document === "string" &&
        typeof candidate.url === "string" &&
        typeof candidate.session === "string"
      ) {
        const doc = candidate as unknown as DocumentSession;
        documents.set(key(doc.tab, doc.document), doc);
      }
    }
  }
  await chrome.action.setBadgeText({ text: "" });
  await chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
}
function displayConfig(config: EffectiveConfig): DisplayConfig {
  return {
    render: config.settings.render,
    terminal: config.settings.terminal,
    shortcut: shortcutLabel,
  };
}
function inputViewport(snapshot: Snapshot): InputViewport {
  return {
    rows: snapshot.rows,
    alternate_screen: snapshot.alternate_screen,
    scrollback: snapshot.scrollback,
  };
}
function sendViewport(doc: DocumentSession): void {
  if (
    activation &&
    activation.session === doc.session &&
    activation.port &&
    doc.viewport
  )
    activation.port.postMessage({
      type: "input.viewport",
      capability: activation.capability,
      viewport: doc.viewport,
    });
}
async function updateBadge(): Promise<void> {
  const live = activation?.live === true;
  await Promise.all([
    chrome.action.setBadgeText({
      text: live ? "LIVE" : enrollment ? "PAIR" : "",
    }),
    chrome.action.setBadgeBackgroundColor({
      color: "#6495ed",
    }),
    chrome.action.setBadgeTextColor?.({ color: "#101210" }),
    chrome.action.setTitle({
      title: live
        ? "console.tty input live"
        : enrollment
          ? `console.tty enrollment ${enrollment.request_id} — approve the matching ID with console-tty pair`
          : "console.tty — Ctrl+Shift+9 toggles input",
    }),
  ]);
}
function pendingStatus(): ConnectionStatus {
  return {
    state: "pending",
    request_id: enrollment!.request_id,
    expires_in: Math.max(
      0,
      Math.ceil((enrollment!.expires - Date.now()) / 1000),
    ),
  };
}
async function notifyEnrollment(status: ConnectionStatus): Promise<void> {
  for (const [id, doc] of enrollmentObservers) {
    if (await current(doc))
      await tell(doc, { type: "connection.status", status }).catch(() => {});
    else enrollmentObservers.delete(id);
  }
}
async function saveDocuments(): Promise<void> {
  await chrome.storage.session.set({ documents: [...documents.values()] });
}
async function tell(
  doc: Pick<DocumentSession, "tab" | "document">,
  value: unknown,
): Promise<unknown> {
  return chrome.tabs.sendMessage(doc.tab, value, { documentId: doc.document });
}
async function report(
  error: unknown,
  doc?: Pick<DocumentSession, "tab" | "document">,
  handledByReply = false,
): Promise<void> {
  lastError = error instanceof Error ? error.message : String(error);
  if (enrollment) await updateBadge();
  else await chrome.action.setTitle({ title: `console.tty: ${lastError}` });
  if (doc)
    await tell(doc, {
      type: "terminal.error",
      error: lastError,
      log: !handledByReply,
    }).catch(() => {});
}
async function current(
  doc: Pick<DocumentSession, "tab" | "document">,
): Promise<boolean> {
  try {
    const frame = await chrome.webNavigation.getFrame({
      tabId: doc.tab,
      frameId: 0,
    });
    return (
      frame?.documentId === doc.document && frame.documentLifecycle === "active"
    );
  } catch {
    return false;
  }
}
async function eligible(url: string): Promise<boolean> {
  if (!supportedSite(url)) return false;
  const parsed = new URL(url);
  return chrome.permissions.contains({
    origins: [`${parsed.protocol}//${parsed.hostname}/*`],
  });
}
async function configuration(): Promise<EffectiveConfig> {
  if (configQueue) return configQueue;
  configQueue = (async () => {
    const config = parseConfig(await native.request("config.get"));
    if (
      effective &&
      (effective.revision !== config.revision ||
        effective.host_id !== config.host_id)
    )
      await disarm();
    if (config.daemon_id && previousDaemon !== config.daemon_id) {
      if (previousDaemon) {
        epoch++;
        await disarm();
        for (const doc of documents.values()) {
          stopPoll(doc);
          doc.session = undefined;
          doc.revision = 0;
          await tell(doc, {
            type: "terminal.error",
            error:
              "Daemon restarted; previous shells no longer exist. Run console.tty() again.",
          }).catch(() => {});
        }
        await saveDocuments();
      }
      previousDaemon = config.daemon_id;
      await chrome.storage.session.set({ daemonId: previousDaemon });
    }
    effective = config;
    return config;
  })().finally(() => {
    configQueue = undefined;
  });
  return configQueue;
}
async function authenticate(config: EffectiveConfig): Promise<boolean> {
  let status = await native.request<RecordValue>("status");
  if (status.pairing_required !== true)
    throw new Error(
      "The running daemon must require pairing. Restart it with the updated console-tty.",
    );
  if (!status.authenticated) {
    const { manualGrant } = await chrome.storage.session.get("manualGrant");
    if (
      record(manualGrant) &&
      manualGrant.host_id === config.host_id &&
      typeof manualGrant.client_id === "string" &&
      typeof manualGrant.credential === "string"
    ) {
      await native.request("authenticate", {
        client_id: manualGrant.client_id,
        credential: manualGrant.credential,
      });
      status = await native.request<RecordValue>("status");
    }
  }
  return status.authenticated === true;
}
async function authenticated(): Promise<EffectiveConfig> {
  const config = await configuration();
  if (!config.daemon_available)
    throw new Error("Daemon unavailable. Run console-tty daemon start.");
  if (!(await authenticate(config)))
    throw new Error(
      "Pairing required. Run console.tty.pair() and approve the matching request with console-tty pair in your local terminal.",
    );
  return config;
}
async function connectionStatus(): Promise<ConnectionStatus> {
  let config: EffectiveConfig;
  try {
    config = await configuration();
  } catch (error) {
    return {
      state: "unavailable",
      message:
        error instanceof Error ? error.message : "Native host unavailable",
    };
  }
  if (!config.daemon_available) return { state: "unavailable" };
  try {
    if (await authenticate(config)) return { state: "connected" };
    return enrollment ? pendingStatus() : { state: "pairing_required" };
  } catch (error) {
    return {
      ...(enrollment
        ? pendingStatus()
        : { state: "pairing_required" as const }),
      message:
        error instanceof Error ? error.message : "Authentication unavailable",
    };
  }
}
async function storeEnrollment(grant: RecordValue): Promise<void> {
  if (
    typeof grant.credential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(grant.credential) ||
    typeof grant.client_id !== "string" ||
    typeof grant.host_id !== "string"
  )
    throw new Error("Invalid enrollment response");
  await chrome.storage.session.set({
    manualGrant: {
      credential: grant.credential,
      client_id: grant.client_id,
      host_id: grant.host_id,
    },
  });
  await chrome.storage.local.set({
    enrollment: {
      client_id: grant.client_id,
      host_id: grant.host_id,
    },
  });
}
function scheduleEnrollment(): void {
  clearTimeout(enrollmentTimer);
  if (enrollment)
    enrollmentTimer = setTimeout(() => {
      void checkEnrollment();
    }, 1000);
}
async function checkEnrollment(): Promise<void> {
  if (enrollmentCheck) return enrollmentCheck;
  const pending = enrollment;
  if (!pending) return;
  enrollmentCheck = (async () => {
    try {
      const grant =
        pending.expires <= Date.now()
          ? { state: "expired" }
          : await native.request<RecordValue>("pair.check");
      if (enrollment !== pending) return;
      if (grant.state === "pending") {
        scheduleEnrollment();
        return;
      }
      if (grant.state === "connected") await storeEnrollment(grant);
      enrollment = undefined;
      clearTimeout(enrollmentTimer);
      await updateBadge();
      await notifyEnrollment({
        state: grant.state === "connected" ? "connected" : "expired",
      });
      if (grant.state === "connected") lastError = "";
    } catch (error) {
      if (enrollment !== pending) return;
      enrollment = undefined;
      clearTimeout(enrollmentTimer);
      await updateBadge();
      await notifyEnrollment({
        state: "pairing_required",
        message: error instanceof Error ? error.message : "Enrollment failed",
      });
    }
  })().finally(() => {
    enrollmentCheck = undefined;
  });
  return enrollmentCheck;
}
async function beginEnrollment(
  doc: DocumentSession,
): Promise<ConnectionStatus> {
  enrollmentObservers.set(key(doc.tab, doc.document), doc);
  if (enrollmentStart) return enrollmentStart;
  enrollmentStart = (async () => {
    const status = await connectionStatus();
    if (status.state === "connected" || status.state === "unavailable")
      return status;
    if (enrollment) {
      await checkEnrollment();
      const currentStatus = await connectionStatus();
      if (
        enrollment ||
        currentStatus.state === "connected" ||
        currentStatus.state === "unavailable"
      )
        return currentStatus;
    }
    const pending = await native.request<RecordValue>("pair.begin");
    if (pending.state === "connected")
      return { state: "connected" } as ConnectionStatus;
    if (
      typeof pending.request_id !== "string" ||
      !/^[a-f0-9]{8}$/.test(pending.request_id) ||
      typeof pending.expires_in !== "number" ||
      pending.expires_in <= 0 ||
      pending.expires_in > 300
    )
      throw new Error("Invalid enrollment request");
    enrollment = {
      request_id: pending.request_id,
      expires: Date.now() + pending.expires_in * 1000,
    };
    await updateBadge();
    scheduleEnrollment();
    return pendingStatus();
  })().finally(() => {
    enrollmentStart = undefined;
  });
  return enrollmentStart;
}
async function topDocument(
  sender: chrome.runtime.MessageSender,
): Promise<DocumentSession> {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !sender.documentId ||
    sender.documentLifecycle !== "active" ||
    !sender.url
  )
    throw new Error("Top-level active document required");
  const identity = { tab: sender.tab.id, document: sender.documentId };
  if (!(await current(identity))) throw new Error("Stale document");
  if (!(await eligible(sender.url)))
    throw new Error("The browser does not permit console.tty on this page");
  const id = key(identity.tab, identity.document);
  let doc = documents.get(id);
  if (!doc) {
    doc = { ...identity, url: sender.url, revision: 0 };
    documents.set(id, doc);
  }
  return doc;
}
async function attach(
  doc: DocumentSession,
  session?: string,
  shell?: Shell,
): Promise<unknown> {
  const id = `${key(doc.tab, doc.document)}:${shell ?? doc.shell ?? "default"}`;
  const existing = starting.get(id);
  if (existing) return existing;
  const operation = (async () => {
    const config = await authenticated();
    const generation = epoch;
    if (!(await current(doc)))
      throw new Error("Document navigated before attachment");
    const creating =
      !session &&
      (!doc.session || (shell !== undefined && shell !== doc.shell));
    const result = await native.request<RecordValue>(
      creating ? "create" : "attach",
      creating
        ? {
            tab: String(doc.tab),
            document: doc.document,
            cols: config.settings.terminal.cols,
            rows: config.settings.terminal.rows,
            ...(shell === undefined ? {} : { shell }),
          }
        : { session_id: session ?? doc.session },
    );
    if (
      typeof result.session_id !== "string" ||
      !knownShell(result.shell) ||
      !validateSnapshot(result.snapshot)
    )
      throw new Error("Invalid terminal attachment");
    const sessionId = result.session_id;
    if (
      generation !== epoch ||
      !(await current(doc)) ||
      !(await eligible(doc.url))
    ) {
      if (result.created === true)
        await native
          .request("close", { session_id: sessionId })
          .catch(() => {});
      throw new Error("Attachment cancelled by navigation or disconnect");
    }
    if (
      activation &&
      (activation.session === sessionId || activation.document === doc.document)
    )
      await disarm();
    for (const other of documents.values()) {
      if (other !== doc && other.session === sessionId) {
        other.session = undefined;
        stopPoll(other);
        await tell(other, {
          type: "terminal.error",
          error: "Attachment superseded by another document",
        }).catch(() => {});
      }
    }
    doc.session = sessionId;
    doc.shell = result.shell;
    doc.revision = result.snapshot.revision;
    doc.viewport = inputViewport(result.snapshot);
    await tell(doc, {
      type: "terminal.configure",
      config: displayConfig(config),
    });
    await tell(doc, { type: "terminal.snapshot", snapshot: result.snapshot });
    await saveDocuments();
    schedulePoll(doc);
    return { session_id: sessionId };
  })().finally(() => {
    starting.delete(id);
  });
  starting.set(id, operation);
  return operation;
}
function stopPoll(doc: DocumentSession): void {
  const id = key(doc.tab, doc.document);
  clearTimeout(pollers.get(id));
  pollers.delete(id);
}
function schedulePoll(doc: DocumentSession): void {
  stopPoll(doc);
  if (!doc.session) return;
  const id = key(doc.tab, doc.document);
  pollers.set(
    id,
    setTimeout(
      () => {
        void poll(doc);
      },
      1000 / (effective?.settings.render.max_fps ?? 15),
    ),
  );
}
async function poll(doc: DocumentSession): Promise<void> {
  if (!doc.session) return;
  const session = doc.session;
  const generation = epoch;
  try {
    if (!(await current(doc))) {
      await discard(doc);
      return;
    }
    const config = effective;
    if (!config || !(await eligible(doc.url))) {
      await disarm();
      stopPoll(doc);
      return;
    }
    const snapshot = await native.request<Snapshot | null>("poll", {
      session_id: session,
      revision: doc.revision,
    });
    if (
      doc.session !== session ||
      generation !== epoch ||
      !(await current(doc))
    )
      return;
    if (snapshot !== null) {
      if (!validateSnapshot(snapshot) || snapshot.session_id !== session)
        throw new Error("Invalid terminal snapshot");
      doc.revision = snapshot.revision;
      doc.viewport = inputViewport(snapshot);
      sendViewport(doc);
      await tell(doc, { type: "terminal.snapshot", snapshot });
      if (snapshot.error) throw new Error(snapshot.error);
      if (snapshot.exited !== null) {
        if (activation?.session === doc.session) await disarm();
        await tell(doc, { type: "terminal.exited", code: snapshot.exited });
        doc.session = undefined;
        await saveDocuments();
        return;
      }
    }
    schedulePoll(doc);
  } catch (error) {
    if (doc.session !== session || generation !== epoch) return;
    stopPoll(doc);
    if (activation?.document === doc.document) await disarm();
    await report(error, doc);
  }
}
async function discard(doc: DocumentSession): Promise<void> {
  if (activation?.document === doc.document && activation.tab === doc.tab)
    await disarm(false);
  stopPoll(doc);
  documents.delete(key(doc.tab, doc.document));
  enrollmentObservers.delete(key(doc.tab, doc.document));
  await saveDocuments();
}
async function shortcut(): Promise<{ mac: boolean; label: string }> {
  const platform = await chrome.runtime.getPlatformInfo();
  const mac = platform.os === "mac";
  const commands = await chrome.commands.getAll();
  if (
    !shortcutMatches(
      commands.find((command) => command.name === TOGGLE)?.shortcut,
      mac,
    )
  ) {
    throw new Error(
      "Input shortcut unassigned or overridden. Set Ctrl+Shift+9 at the browser's extension shortcuts page.",
    );
  }
  return { mac, label: SHORTCUT };
}
async function disarm(restore = true): Promise<void> {
  const old = activation;
  activation = undefined;
  if (old) old.live = false;
  for (const probe of probes.values()) {
    clearTimeout(probe.timer);
    probe.port.disconnect();
  }
  probes.clear();
  if (old) {
    old.port?.postMessage({ type: "input.disarmed" });
    old.port?.disconnect();
    await tell(old, { type: "input.unmount", restore }).catch(() => {});
  }
  await updateBadge();
}
async function toggle(): Promise<void> {
  if (activation) {
    await disarm();
    return;
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("Select an enabled webpage first");
  const frame = await chrome.webNavigation.getFrame({
    tabId: tab.id,
    frameId: 0,
  });
  const doc = frame?.documentId
    ? documents.get(key(tab.id, frame.documentId))
    : undefined;
  if (!doc?.session)
    throw new Error("Run console.tty() in this page's DevTools console first");
  const config = await authenticated();
  await shortcut();
  if (!(await current(doc)) || !(await eligible(doc.url)))
    throw new Error("Document is no longer eligible");
  activation = {
    tab: doc.tab,
    document: doc.document,
    session: doc.session,
    capability: crypto.randomUUID(),
    revision: config.revision,
    live: false,
  };
  const pending = activation;
  await tell(doc, { type: "input.mount" });
  setTimeout(() => {
    if (activation === pending && !pending.live)
      void disarm().then(() =>
        report(
          new Error(
            "Input frame did not acquire focus; press the shortcut to try again",
          ),
          doc,
        ),
      );
  }, 4000);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "console.tty.input") {
    port.disconnect();
    return;
  }
  void authorizeFrame(port).catch((error: unknown) => {
    port.disconnect();
    void report(error);
  });
});
async function authorizeFrame(port: chrome.runtime.Port): Promise<void> {
  await initialized;
  const sender = port.sender;
  const active = activation;
  if (
    !active ||
    active.port ||
    !sender ||
    sender.id !== chrome.runtime.id ||
    sender.tab?.id !== active.tab ||
    !sender.frameId ||
    !sender.documentId ||
    sender.url !== chrome.runtime.getURL("input.html") ||
    sender.documentLifecycle !== "active" ||
    !(await current(active))
  )
    throw new Error("Unauthorized input frame");
  // webNavigation may omit extension-origin subframes. The browser's runtime sender
  // identifies this port; the top renderer's source-window probe proves its parent/element.
  const probe = crypto.randomUUID();
  if (probes.size >= 8) throw new Error("Too many pending input frames");
  const timer = setTimeout(() => {
    probes.delete(probe);
    port.disconnect();
  }, 2500);
  probes.set(probe, {
    port,
    frame: sender.frameId,
    document: sender.documentId,
    timer,
  });
  port.postMessage({ type: "input.probe", probe });
  port.onMessage.addListener((value: unknown) => {
    void frameMessage(port, value).catch((error: unknown) => {
      if (activation?.port === port)
        void disarm().then(() => report(error, active));
      else port.disconnect();
    });
  });
  port.onDisconnect.addListener(() => {
    for (const [id, pending] of probes)
      if (pending.port === port) {
        clearTimeout(pending.timer);
        probes.delete(id);
      }
    if (activation?.port === port) void disarm();
  });
}
async function confirmFrame(
  doc: DocumentSession,
  probe: string,
): Promise<void> {
  const active = activation;
  const pending = probes.get(probe);
  if (
    !active ||
    !pending ||
    active.tab !== doc.tab ||
    active.document !== doc.document ||
    active.port
  )
    throw new Error("Stale input activation");
  const config = await authenticated();
  const binding = await shortcut();
  if (
    activation !== active ||
    !(await current(doc)) ||
    config.revision !== active.revision
  )
    throw new Error("Input activation invalidated");
  clearTimeout(pending.timer);
  probes.delete(probe);
  active.port = pending.port;
  active.frame = pending.frame;
  active.frameDocument = pending.document;
  pending.port.postMessage({
    type: "input.authorized",
    capability: active.capability,
    settings: config.settings.input,
    label: documents.get(key(active.tab, active.document))?.shell ?? "shell",
    shortcut: binding.label,
    viewport: doc.viewport ?? {
      rows: config.settings.terminal.rows,
      alternate_screen: false,
    },
  });
}
async function frameMessage(
  port: chrome.runtime.Port,
  value: unknown,
): Promise<void> {
  const active = activation;
  if (
    !active ||
    active.port !== port ||
    !record(value) ||
    value.capability !== active.capability
  )
    throw new Error("Stale or unauthorized input");
  if (message(value, "input.disarm", ["capability"])) {
    await disarm();
    return;
  }
  if (message(value, "input.ready", ["capability"])) {
    if (!(await current(active)) || activation !== active)
      throw new Error("Input document navigated");
    active.live = true;
    await updateBadge();
    if (activation !== active || !active.live) {
      await updateBadge();
      return;
    }
    port.postMessage({ type: "input.live", capability: active.capability });
    await tell(active, { type: "input.live" });
    return;
  }
  const scrolling =
    message(value, "input.scroll", ["capability", "lines", "shift", "alt"]) &&
    typeof value.lines === "number" &&
    Number.isInteger(value.lines) &&
    Math.abs(value.lines) <= 100000 &&
    ["shift", "alt"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    );
  const writing =
    message(value, "input.send", [
      "capability",
      "kind",
      "value",
      "ctrl",
      "alt",
      "shift",
    ]) &&
    ["text", "key", "paste"].includes(String(value.kind)) &&
    typeof value.value === "string" &&
    new TextEncoder().encode(value.value).length <= 65536 &&
    ["ctrl", "alt", "shift"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    );
  if (!active.live || (!scrolling && !writing))
    throw new Error("Invalid input event");
  // Dispatch immediately in port order; navigation/focus/config events revoke this binding.
  const doc = documents.get(key(active.tab, active.document));
  if (
    activation !== active ||
    !active.live ||
    doc?.session !== active.session ||
    effective?.revision !== active.revision
  )
    throw new Error("Input was disarmed");
  if (scrolling) {
    await native.request("scroll", {
      session_id: active.session,
      lines: value.lines,
      ...(value.shift ? { shift: true } : {}),
      ...(value.alt ? { alt: true } : {}),
    });
    if (activation === active && active.live)
      port.postMessage({
        type: "input.scrolled",
        capability: active.capability,
      });
    return;
  }
  await native.request(String(value.kind), {
    session_id: active.session,
    value: value.value,
    ctrl: value.ctrl ?? false,
    alt: value.alt ?? false,
    shift: value.shift ?? false,
  });
}
async function runtimeMessage(
  value: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  await initialized;
  if (!record(value) || typeof value.type !== "string")
    throw new Error("Invalid extension message");
  const doc = await topDocument(sender);
  if (message(value, "control.pair")) return beginEnrollment(doc);
  if (message(value, "control.close")) {
    const session = doc.session;
    if (!session) return { state: "session_closed" } satisfies ConnectionStatus;
    await authenticated();
    if (!(await current(doc)) || doc.session !== session)
      throw new Error("The selected terminal changed before closing");
    if (activation?.session === session) await disarm();
    await native.request("close", { session_id: session });
    for (const selected of documents.values()) {
      if (selected.session !== session) continue;
      stopPoll(selected);
      selected.session = undefined;
      selected.shell = undefined;
      selected.revision = 0;
      await tell(selected, {
        type: "terminal.exited",
        code: null,
        log: false,
      }).catch(() => {});
    }
    await saveDocuments();
    return { state: "session_closed" } satisfies ConnectionStatus;
  }
  if (message(value, "control.status") || message(value, "control.connect")) {
    if (enrollment) await checkEnrollment();
    const status = await connectionStatus();
    if (
      status.state === "connected" &&
      value.type === "control.connect" &&
      doc.session &&
      !pollers.has(key(doc.tab, doc.document))
    )
      await attach(doc);
    return status;
  }
  if (message(value, "document.bootstrap")) {
    if (!(await current(doc)))
      throw new Error("Document navigated during bootstrap");
    await chrome.scripting.executeScript({
      target: { tabId: doc.tab, documentIds: [doc.document] },
      files: ["console-tty-trigger.js"],
      world: "MAIN",
    });
    return displayConfig(await configuration());
  }
  if (
    message(value, "public.start", ["shell"]) &&
    (value.shell === undefined || knownShell(value.shell))
  ) {
    if (
      doc.session &&
      (value.shell === undefined || value.shell === doc.shell) &&
      pollers.has(key(doc.tab, doc.document)) &&
      ![...starting.keys()].some((id) =>
        id.startsWith(`${key(doc.tab, doc.document)}:`),
      )
    )
      return { session_id: doc.session };
    return attach(doc, undefined, value.shell as Shell | undefined);
  }
  if (
    message(value, "input.confirm", ["probe"]) &&
    typeof value.probe === "string"
  ) {
    await confirmFrame(doc, value.probe);
    return {};
  }
  if (message(value, "input.lost")) {
    if (activation?.document === doc.document) await disarm(false);
    return {};
  }
  if (message(value, "document.detach")) {
    await discard(doc);
    return {};
  }
  if (value.type === "terminal.resize") {
    if (!doc.session || value.session_id !== doc.session)
      throw new Error("No selected terminal for this document");
    await authenticated();
    if (!(await current(doc))) throw new Error("Stale terminal handle");
    if (
      message(value, "terminal.resize", ["session_id", "cols", "rows"]) &&
      dimensions(value.cols, value.rows)
    ) {
      return native.request("resize", {
        session_id: doc.session,
        cols: value.cols,
        rows: value.rows,
      });
    }
  }
  throw new Error("Unsupported extension operation");
}
chrome.runtime.onMessage.addListener((value: unknown, sender, respond) => {
  void runtimeMessage(value, sender).then(
    (result) => respond({ result }),
    (error: unknown) => {
      void report(
        error,
        sender.tab?.id && sender.documentId
          ? { tab: sender.tab.id, document: sender.documentId }
          : undefined,
        true,
      );
      respond({
        error:
          error instanceof Error ? error.message : "Extension request failed",
      });
    },
  );
  return true;
});

function registerSites(): Promise<void> {
  const operation = registrationQueue.then(applySites);
  registrationQueue = operation.catch(() => {});
  return operation;
}
async function applySites(): Promise<void> {
  await initialized;
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined && tab.url && (await eligible(tab.url))) {
      try {
        const frame = await chrome.webNavigation.getFrame({
          tabId: tab.id,
          frameId: 0,
        });
        if (!frame?.documentId || frame.documentLifecycle !== "active")
          continue;
        const target = { tabId: tab.id, documentIds: [frame.documentId] };
        await chrome.scripting.executeScript({
          target,
          files: ["console-renderer.js"],
          world: "ISOLATED",
        });
        await chrome.scripting.executeScript({
          target,
          files: ["console-tty-trigger.js"],
          world: "MAIN",
        });
      } catch (error) {
        await report(error);
      }
    }
  }
}
async function recover(): Promise<void> {
  if (
    recovering ||
    ![...documents.values()].some(
      (doc) => doc.session && !pollers.has(key(doc.tab, doc.document)),
    )
  )
    return;
  recovering = true;
  try {
    await authenticated();
    for (const doc of documents.values()) {
      if (
        doc.session &&
        !pollers.has(key(doc.tab, doc.document)) &&
        (await current(doc))
      )
        await attach(doc);
    }
  } finally {
    recovering = false;
  }
}
function toggleInput(): void {
  toggleQueue = toggleQueue
    .then(() => initialized)
    .then(toggle)
    .catch((error: unknown) => {
      void disarm().then(() => report(error));
    });
}
chrome.commands.onCommand.addListener((command) => {
  if (command === TOGGLE) toggleInput();
});
chrome.action.onClicked.addListener(toggleInput);
chrome.webNavigation.onBeforeNavigate.addListener((event) => {
  if (
    activation?.tab === event.tabId &&
    (event.frameId === 0 || event.frameId === activation.frame)
  )
    void disarm(false);
  if (event.frameId === 0)
    for (const doc of documents.values())
      if (doc.tab === event.tabId) void discard(doc);
});
chrome.tabs.onActivated.addListener(() => {
  void disarm(false);
});
chrome.tabs.onRemoved.addListener((tab) => {
  for (const doc of documents.values()) if (doc.tab === tab) void discard(doc);
});
chrome.windows.onFocusChanged.addListener(() => {
  void disarm(false);
});
chrome.permissions.onAdded.addListener(() => {
  void registerSites().catch(report);
});
chrome.permissions.onRemoved.addListener(() => {
  void disarm().then(registerSites).catch(report);
});
chrome.runtime.onInstalled.addListener(() => {
  void registerSites().catch(report);
});
chrome.runtime.onStartup.addListener(() => {
  void registerSites().catch(report);
});
chrome.alarms.onAlarm.addListener(() => {
  void configuration().then(recover).catch(report);
});
native.onDisconnect = () => {
  epoch++;
  effective = undefined;
  if (enrollment) {
    enrollment = undefined;
    clearTimeout(enrollmentTimer);
    void notifyEnrollment({
      state: "expired",
      message: "Native helper disconnected. Run console.tty.pair() again.",
    });
  }
  void disarm();
  for (const doc of documents.values()) {
    stopPoll(doc);
    void tell(doc, {
      type: "terminal.error",
      error:
        "Backend disconnected. Run console.tty.connect(); if approval is needed, run console.tty.pair().",
    }).catch(() => {});
  }
};
void initialized.then(registerSites).then(shortcut).then(recover).catch(report);
