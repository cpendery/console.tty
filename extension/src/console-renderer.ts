import { boundedSize, createRenderer, createViewport } from "./render";
import {
  publicStart,
  publicResize,
  publicControl,
  record,
  validateSnapshot,
  type DisplayConfig,
  type ConnectionStatus,
} from "./protocol";
import type { ViewportController, ViewportSize } from "@textjs/core";

(() => {
  const marker = Symbol.for("console.tty.isolated.v1");
  const replacementEvent = "console.tty.renderer-ready";
  const isolated = globalThis as typeof globalThis & {
    [marker]?: { bootstrap(): void; isActive?(): boolean } | boolean;
  };
  const installed = isolated[marker];
  if (typeof installed === "object" && installed.isActive?.()) {
    installed.bootstrap();
    return;
  }
  let disposed = false;
  const lifetime = new AbortController();
  const render = createRenderer(console);
  let viewport: ViewportController | undefined;
  let display: DisplayConfig | undefined;
  let desiredSize: ViewportSize | undefined;
  let resizing = false;
  let requestedSize = "";
  let manualSize = false;
  let iframe: HTMLIFrameElement | undefined;
  let observer: MutationObserver | undefined;
  let priorFocus: Element | null = null;
  let selected: string | undefined;
  const pendingStarts = new Set<string>();
  const pendingControls = new Set<string>();
  let reportedConnection = "";
  function bootstrap(): void {
    if (!isActive()) return;
    void request<DisplayConfig>("document.bootstrap")
      .then(configure)
      .catch(error);
  }
  const instance = { bootstrap, isActive };
  isolated[marker] = instance;
  function isActive(): boolean {
    if (disposed) return false;
    try {
      if (chrome.runtime.id) return true;
    } catch {
      // Runtime bindings may already be gone after an extension reload.
    }
    dispose();
    return false;
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    viewport?.dispose();
    viewport = undefined;
    display = undefined;
    selected = undefined;
    desiredSize = undefined;
    pendingStarts.clear();
    pendingControls.clear();
    unmount(false);
    try {
      chrome.runtime.onMessage.removeListener(runtimeMessage);
    } catch {
      // Invalidated contexts can no longer unregister runtime listeners.
    }
    if (isolated[marker] === instance) delete isolated[marker];
  }
  function error(reason: unknown): void {
    const description =
      record(reason) && typeof reason.message === "string"
        ? reason.message
        : String(reason);
    if (description.includes("Extension context invalidated")) {
      dispose();
      return;
    }
    if (isActive()) console.error("console.tty:", description);
  }
  async function request<T = unknown>(
    type: string,
    fields: Record<string, unknown> = {},
  ): Promise<T> {
    if (!isActive()) throw new Error("Extension context invalidated.");
    const response: unknown = await chrome.runtime.sendMessage({
      type,
      ...fields,
    });
    if (!isActive()) throw new Error("Extension context invalidated.");
    if (!record(response) || response.error)
      throw new Error(
        record(response) && typeof response.error === "string"
          ? response.error
          : "Extension unavailable",
      );
    return response.result as T;
  }
  function showConnection(status: ConnectionStatus): void {
    if (!isActive()) return;
    const signature = `${status.state}:${status.request_id ?? ""}:${status.message ?? ""}`;
    if (signature === reportedConnection) return;
    reportedConnection = signature;
    const description =
      status.state === "session_closed"
        ? "Current terminal session closed."
        : status.state === "pending"
          ? `Pair request id: ${status.request_id}. Run \`console-tty pair ${status.request_id}\` in local terminal to connect.`
          : status.state === "connected"
            ? "Connected. Run console.tty() to start or select a shell."
            : status.state === "pairing_required"
              ? "Not paired. Run console.tty.pair(), then approve the matching request with console-tty pair."
              : status.state === "expired"
                ? "Enrollment expired. Run console.tty.pair() to request it again."
                : "Daemon unavailable. Run console-tty daemon start, then console.tty.connect().";
    console.info(
      "[console.tty]",
      description,
      ...(status.message ? [status.message] : []),
    );
  }

  function configure(config: DisplayConfig): void {
    if (!isActive()) return;
    render.configure(config);
    if (JSON.stringify(config) === JSON.stringify(display)) return;
    display = config;
    manualSize = false;
    viewport?.dispose();
    viewport = createViewport(config);
    viewport.subscribe(queueResize);
    if (config.render.responsive) queueResize(viewport.getSize());
  }
  function queueResize(size: ViewportSize): void {
    if (!isActive() || manualSize || !viewport?.responsive) return;
    desiredSize = boundedSize(size);
    void flushResize();
  }
  async function flushResize(): Promise<void> {
    if (!isActive() || resizing || !selected || !desiredSize) return;
    resizing = true;
    try {
      while (isActive() && selected && desiredSize) {
        const session = selected;
        const size = desiredSize;
        desiredSize = undefined;
        const signature = `${session}:${size.cols}:${size.rows}`;
        if (signature === requestedSize) continue;
        requestedSize = signature;
        await request("terminal.resize", { session_id: session, ...size });
      }
    } catch (reason) {
      requestedSize = "";
      error(reason);
    } finally {
      resizing = false;
    }
  }
  function unmount(restore: boolean): void {
    if (!disposed) render.inputLive(false);
    observer?.disconnect();
    observer = undefined;
    iframe?.remove();
    iframe = undefined;
    if (restore && priorFocus instanceof HTMLElement && priorFocus.isConnected)
      priorFocus.focus({ preventScroll: true });
    priorFocus = null;
  }
  function mount(): void {
    if (!isActive()) return;
    unmount(false);
    priorFocus = document.activeElement;
    const frame = document.createElement("iframe");
    const source = chrome.runtime.getURL("input.html");
    frame.src = source;
    frame.title = "console.tty terminal input";
    frame.setAttribute("allow", "");
    frame.style.cssText =
      "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;border:0!important;background:transparent!important;color-scheme:only light!important;z-index:2147483647!important;display:block!important;visibility:visible!important;";
    iframe = frame;
    (document.documentElement ?? document).appendChild(frame);
    frame.focus({ preventScroll: true });
    observer = new MutationObserver(() => {
      if (!isActive()) return;
      if (iframe === frame && (!frame.isConnected || frame.src !== source)) {
        unmount(false);
        void request("input.lost").catch(error);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  }
  if (!isActive()) return;
  window.dispatchEvent(new Event(replacementEvent));
  // The signal carries no authority: a live renderer ignores it.
  window.addEventListener(replacementEvent, isActive, {
    signal: lifetime.signal,
  });
  window.addEventListener(
    "message",
    (event: MessageEvent<unknown>) => {
      if (!isActive()) return;
      if (
        event.source === window &&
        event.origin === location.origin &&
        publicControl(event.data) &&
        window.top === window
      ) {
        const action = event.data.action;
        if (pendingControls.has(action)) return;
        pendingControls.add(action);
        void request<ConnectionStatus>(`control.${action}`)
          .then((status) => {
            reportedConnection = "";
            showConnection(status);
          })
          .catch(error)
          .finally(() => pendingControls.delete(action));
        return;
      }
      if (
        event.source === window &&
        event.origin === location.origin &&
        publicStart(event.data) &&
        window.top === window
      ) {
        const shell = event.data.shell ?? "default";
        if (pendingStarts.has(shell)) return;
        pendingStarts.add(shell);
        void request(
          "public.start",
          event.data.shell === undefined ? {} : { shell: event.data.shell },
        )
          .catch(error)
          .finally(() => pendingStarts.delete(shell));
        return;
      }
      if (
        event.source === window &&
        event.origin === location.origin &&
        publicResize(event.data) &&
        window.top === window
      ) {
        if (!selected || !viewport) {
          error("Run console.tty() before resizing");
          return;
        }
        if (event.data.fit === true) {
          manualSize = false;
          viewport.setResponsive(true);
          queueResize(viewport.refresh(true));
        } else {
          manualSize = true;
          viewport.setResponsive(false);
          desiredSize = {
            cols: event.data.cols as number,
            rows: event.data.rows as number,
          };
          viewport.setSize(desiredSize.cols, desiredSize.rows);
          void flushResize();
        }
        return;
      }
      if (
        iframe &&
        event.source === iframe.contentWindow &&
        event.origin === `chrome-extension://${chrome.runtime.id}` &&
        record(event.data) &&
        Object.keys(event.data).length === 2 &&
        event.data.type === "console.tty.frame-probe" &&
        typeof event.data.probe === "string" &&
        event.data.probe.length === 36
      ) {
        // This is a non-secret identity probe. The input capability travels only over the frame's runtime port.
        void request("input.confirm", { probe: event.data.probe }).catch(error);
      }
    },
    { signal: lifetime.signal },
  );
  function runtimeMessage(value: unknown): void {
    if (!isActive() || !record(value)) return;
    switch (value.type) {
      case "connection.status":
        showConnection(value.status as ConnectionStatus);
        break;
      case "terminal.configure":
        configure(value.config as DisplayConfig);
        break;
      case "terminal.snapshot":
        if (validateSnapshot(value.snapshot)) {
          selected = value.snapshot.session_id;
          render.render(value.snapshot);
          if (viewport?.responsive) queueResize(viewport.getSize());
        }
        break;
      case "terminal.error":
        if (value.log !== false) error(value.error);
        unmount(false);
        break;
      case "terminal.exited":
        selected = undefined;
        desiredSize = undefined;
        if (value.log !== false)
          console.info(
            `console.tty: shell exited (${String(value.code ?? "closed")})`,
          );
        unmount(false);
        break;
      case "input.mount":
        mount();
        break;
      case "input.live":
        render.inputLive(true);
        break;
      case "input.unmount":
        unmount(value.restore === true);
        break;
    }
  }
  chrome.runtime.onMessage.addListener(runtimeMessage);
  window.addEventListener(
    "pagehide",
    () => {
      if (!isActive()) return;
      unmount(false);
      viewport?.dispose();
      viewport = undefined;
      display = undefined;
      selected = undefined;
      desiredSize = undefined;
      void request("document.detach").catch(() => {});
    },
    { signal: lifetime.signal },
  );
  window.addEventListener(
    "pageshow",
    (event) => {
      if (event.persisted) bootstrap();
    },
    { signal: lifetime.signal },
  );
  bootstrap();
})();
