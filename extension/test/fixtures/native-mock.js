// Browser integration fixture only; prepended to a temporary copy, never shipped.
(() => {
  const listeners = [];
  const actual = chrome.commands.onCommand.addListener.bind(
    chrome.commands.onCommand,
  );
  chrome.commands.onCommand.addListener = (listener) => {
    listeners.push(listener);
    actual(listener);
  };
  globalThis.__testCommand = () =>
    listeners.forEach((listener) => listener("toggle-terminal-input"));
  const state = (globalThis.__nativeState = {
    creates: 0,
    input: [],
    sessions: [],
    calls: [],
    ports: [],
    diagnostics: [],
    daemonId: crypto.randomUUID(),
    revision: "fixture-v1",
    failConfig: false,
    resizes: [],
    scrolls: [],
    appScrolls: [],
    pendingRequest: null,
    approved: false,
    pairingRequired: true,
    enrollmentRequests: 0,
  });
  const alarmListeners = [];
  const addAlarm = chrome.alarms.onAlarm.addListener.bind(
    chrome.alarms.onAlarm,
  );
  chrome.alarms.onAlarm.addListener = (listener) => {
    alarmListeners.push(listener);
    addAlarm(listener);
  };
  globalThis.__testAlarm = () =>
    alarmListeners.forEach((listener) => listener({ name: "reconnect" }));
  const setTitle = chrome.action.setTitle.bind(chrome.action);
  chrome.action.setTitle = (value) => {
    state.diagnostics.push(value.title);
    return setTitle(value);
  };
  chrome.runtime.onConnect.addListener((port) => {
    const info = { sender: port.sender, messages: [] };
    state.ports.push(info);
    if (port.sender.tab)
      chrome.webNavigation
        .getFrame({ tabId: port.sender.tab.id, frameId: port.sender.frameId })
        .then((frame) => {
          info.frame = frame;
        });
    port.onMessage.addListener((value) => info.messages.push(value.type));
  });
  const settings = {
    render: {
      max_fps: 15,
      responsive: true,
      padding_cols: 2,
      padding_rows: 1,
      frame_spacing: true,
    },
    input: { dim_opacity: 0.12, show_key_hints: true },
    terminal: { cols: 40, rows: 5, shell: "bash" },
    limits: {
      max_live_sessions: 8,
      max_live_sessions_per_tab: 2,
      max_start_requests_per_minute: 10,
    },
  };
  chrome.runtime.connectNative = () => {
    const messages = [];
    const disconnected = [];
    let authenticated = false;
    let pending;
    return {
      onMessage: { addListener: (listener) => messages.push(listener) },
      onDisconnect: { addListener: (listener) => disconnected.push(listener) },
      disconnect() {
        if (state.pendingRequest === pending) state.pendingRequest = null;
        pending = undefined;
        disconnected.forEach((listener) => listener());
      },
      postMessage(request) {
        state.calls.push(request.type);
        queueMicrotask(() => {
          let result;
          let error;
          const p = request.params;
          const session = state.sessions.find(
            (session) => session.session_id === p.session_id,
          );
          const snapshot = (session) => ({
            ...session,
            cols: session.cols ?? 40,
            rows: session.rows ?? 5,
            cells: Array.from(
              { length: (session.cols ?? 40) * (session.rows ?? 5) },
              (_, i) => [
                Array.from("demo shell ready")[i] ?? " ",
                1,
                0xffffff,
                0x18212c,
                0,
              ],
            ),
            cursor: { x: 0, y: 1, visible: !session.offset, shape: "Block" },
            alternate_screen: session.alternate_screen ?? false,
            scrollback: {
              offset: session.offset ?? 0,
              history_lines: session.alternate_screen ? 0 : 100,
            },
            exited: null,
          });
          if (request.type === "config.get" && state.failConfig)
            error = "Fixture configuration temporarily unavailable";
          else if (request.type === "config.get")
            result = {
              schema_version: 1,
              revision: state.revision,
              daemon_available: true,
              host_id: "fixture-host",
              daemon_id: state.daemonId,
              settings,
            };
          else if (request.type === "status")
            result = {
              authenticated: state.pairingRequired ? authenticated : true,
              pairing_required: state.pairingRequired,
            };
          else if (request.type === "pair.begin") {
            if (authenticated) result = { state: "connected" };
            else {
              if (!pending) {
                pending = (++state.enrollmentRequests)
                  .toString(16)
                  .padStart(8, "0");
                state.pendingRequest = pending;
                state.approved = false;
              }
              result = {
                state: "pending",
                request_id: pending,
                expires_in: 300,
              };
            }
          } else if (request.type === "pair.check") {
            if (!pending) result = { state: "none" };
            else if (!state.approved)
              result = {
                state: "pending",
                request_id: pending,
                expires_in: 300,
              };
            else {
              authenticated = true;
              pending = undefined;
              state.pendingRequest = null;
              result = {
                state: "connected",
                client_id: "fixture-client",
                credential: "A".repeat(43),
                host_id: "fixture-host",
              };
            }
          } else if (request.type === "authenticate") {
            authenticated = p.credential === "A".repeat(43);
            result = { authenticated };
          } else if (!authenticated) error = "Pairing required";
          else if (request.type === "create") {
            const existing = state.sessions.find(
              (session) =>
                session.tab === p.tab &&
                session.document === p.document &&
                session.shell === (p.shell ?? settings.terminal.shell),
            );
            const session = existing ?? {
              session_id: `fixture-session-${++state.creates}`,
              revision: 1,
              shell: p.shell ?? settings.terminal.shell,
              tab: p.tab,
              document: p.document,
            };
            if (!existing) state.sessions.push(session);
            result = {
              session_id: session.session_id,
              shell: session.shell,
              created: !existing,
              snapshot: snapshot(session),
            };
          } else if (request.type === "list")
            result = state.sessions.map((session) => ({
              ...session,
              label: "Demo shell",
              live: true,
            }));
          else if (request.type === "attach")
            result = {
              session_id: session.session_id,
              shell: session.shell,
              snapshot: snapshot(session),
            };
          else if (request.type === "poll")
            result = session.revision === p.revision ? null : snapshot(session);
          else if (["text", "key", "paste", "input"].includes(request.type)) {
            state.input.push({ kind: request.type, ...p });
            const historyKey =
              request.type === "key" && p.shift && !p.ctrl && !p.alt;
            if (historyKey && p.value === "PageUp")
              session.offset = Math.min(
                100,
                (session.offset ?? 0) + (session.rows ?? 5),
              );
            else if (historyKey && p.value === "PageDown")
              session.offset = Math.max(
                0,
                (session.offset ?? 0) - (session.rows ?? 5),
              );
            else if (historyKey && p.value === "Home") session.offset = 100;
            else session.offset = 0;
            session.revision++;
            result = {};
          } else if (request.type === "scroll") {
            state.scrolls.push(p);
            if (session.appMouse && !p.shift) {
              state.appScrolls.push(p);
              session.offset = 0;
            } else
              session.offset = Math.max(
                0,
                Math.min(
                  session.alternate_screen ? 0 : 100,
                  (session.offset ?? 0) + p.lines,
                ),
              );
            session.revision++;
            result = {};
          } else if (request.type === "resize") {
            state.resizes.push(p);
            session.cols = p.cols;
            session.rows = p.rows;
            session.revision++;
            result = {};
          } else if (request.type === "close") {
            state.sessions = state.sessions.filter((s) => s !== session);
            result = {};
          } else if (request.type === "forget") result = {};
          else error = "Unsupported fixture operation";
          messages.forEach((listener) =>
            listener({
              version: 1,
              request_id: request.request_id,
              result,
              error,
            }),
          );
        });
      },
    };
  };
})();
