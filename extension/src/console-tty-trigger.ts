import {
  PUBLIC_TYPE,
  PUBLIC_RESIZE,
  PUBLIC_CONTROL,
  knownShell,
  dimensions,
} from "./protocol";

(() => {
  const marker = Symbol.for("console.tty.public.v1");
  const target = console as Console & {
    tty?: (() => void) & { [marker]?: boolean };
  };
  if (target.tty?.[marker]) return;
  if ("tty" in target) {
    console.warn(
      "console.tty: an existing console.tty property was not overwritten",
    );
    return;
  }
  const trigger = (...args: unknown[]): void => {
    if (args.length > 1 || (args[0] !== undefined && !knownShell(args[0]))) {
      console.warn(
        "console.tty(shell?) accepts only a known shell name, not a path, command, or options.",
      );
      return;
    }
    window.postMessage(
      {
        type: PUBLIC_TYPE,
        ...(args[0] === undefined ? {} : { shell: args[0] }),
      },
      location.origin,
    );
  };
  Object.defineProperty(trigger, "resize", {
    value: (...args: unknown[]): void => {
      if (args.length === 0)
        window.postMessage({ type: PUBLIC_RESIZE, fit: true }, location.origin);
      else if (args.length === 2 && dimensions(args[0], args[1]))
        window.postMessage(
          { type: PUBLIC_RESIZE, cols: args[0], rows: args[1] },
          location.origin,
        );
      else
        console.warn(
          "console.tty.resize(cols, rows) requires valid terminal dimensions; resize() restores automatic fitting.",
        );
    },
  });
  for (const action of ["pair", "connect", "status", "close"] as const) {
    Object.defineProperty(trigger, action, {
      value: (...args: unknown[]): void => {
        if (args.length) {
          console.warn(
            `console.tty.${action}() takes no arguments; never put credentials in the page console.`,
          );
          return;
        }
        window.postMessage({ type: PUBLIC_CONTROL, action }, location.origin);
      },
    });
  }
  Object.defineProperty(trigger, "help", {
    value: (...args: unknown[]): void => {
      if (args.length) {
        console.warn("console.tty.help() takes no arguments");
        return;
      }
      console.log(
        "console.tty(shell?) - start/select a known local shell\nconsole.tty.resize(cols, rows) - resize; resize() restores fitting\nconsole.tty.close() - close this document's selected session\nconsole.tty.pair() - request enrollment, then approve with console-tty pair in your local terminal\nconsole.tty.connect() - retry an approved connection\nconsole.tty.status() - show minimal connection status\nCtrl+Shift+9 - toggle terminal input\nWhile input is live: wheel scrolls the app or terminal history; Shift+wheel bypasses app capture. Shift+PageUp/PageDown/Home/End navigate terminal history on the main screen; typing returns to live output",
      );
    },
  });
  Object.defineProperty(trigger, marker, { value: true });
  Object.defineProperty(target, "tty", { value: trigger, configurable: true });
})();
