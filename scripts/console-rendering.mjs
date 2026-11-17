import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";

const pending = new Map();
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CONSOLE_TTY_BROWSER ??
      (process.platform === "win32"
        ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
        : undefined),
    channel:
      process.platform === "win32" || process.env.CONSOLE_TTY_BROWSER
        ? undefined
        : "chromium",
    headless: true,
    args: ["--auto-open-devtools-for-tabs", "--window-size=1280,900"],
  });
  const page = await browser.newPage();
  await page.goto(
    "data:text/html,<title>console.tty render regression</title>",
  );
  const root = await browser.newBrowserCDPSession();
  let frontend;
  for (let attempt = 0; attempt < 200; attempt++) {
    frontend = (await root.send("Target.getTargets")).targetInfos.find(
      (target) => target.url.startsWith("devtools://"),
    );
    if (frontend) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(
    frontend,
    "The browser must expose its own DevTools frontend for rendered-console assertions",
  );
  const { sessionId } = await root.send("Target.attachToTarget", {
    targetId: frontend.targetId,
    flatten: false,
  });
  let next = 0;
  root.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    globalThis.clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = async (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("DevTools evaluation timed out"));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      root
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({
            id,
            method,
            params,
          }),
        })
        .catch((error) => {
          pending.delete(id);
          globalThis.clearTimeout(timer);
          reject(error);
        });
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await evaluate(`(async () => {
    const UI = await import('./ui/legacy/legacy.js');
    let last;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await UI.InspectorView.InspectorView.instance().showPanel('console');
        UI.DockController.DockController.instance().setDockSide('bottom');
        return;
      } catch (error) { last = error; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw last;
  })()`);
  const bundle = await build({
    entryPoints: ["extension/src/render.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "ConsoleTtyRender",
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    globalThis.__clearCalls = 0;
    const clear = console.clear.bind(console);
    console.clear = () => {
      globalThis.__clearCalls++;
      clear();
    };
    const renderer = globalThis.ConsoleTtyRender.createRenderer();
    renderer.configure({
      render: {
        max_fps: 15,
        responsive: false,
        padding_cols: 2,
        padding_rows: 1,
        frame_spacing: true,
      },
      terminal: { cols: 90, rows: 20, shell: "bash" },
      shortcut: "Ctrl+Shift+9",
    });
    globalThis.__drawConsoleFrame = (index) => {
      const cells = Array.from({ length: 1800 }, (_, cell) => [
        " ",
        1,
        0xffffff,
        Math.floor(cell / 90) % 2 ? 0x0d1118 : 0x0d1117,
        0,
      ]);
      const text = (row, value) =>
        [...value].forEach((character, column) => {
          cells[row * 90 + column + 2][0] = character;
        });
      text(1, "STATIC_RENDER_BASELINE");
      text(15, index % 2 ? "\u280b" : "\u2819");
      text(18, `FRAMEINDEX_${index}`);
      if (index === 6) renderer.inputLive(true);
      renderer.render({
        session_id: "console-render-test",
        revision: index + 1,
        cols: 90,
        rows: 20,
        cells,
        cursor: { x: 0, y: 0, visible: false, shape: "Block" },
        alternate_screen: false,
        scrollback: { offset: 0, history_lines: 0 },
        exited: null,
      });
    };
  });
  const inspect = `(() => {
    let latest;
    function scan(root) {
      for (const node of root.querySelectorAll("*")) {
        if (node.classList.contains("console-message")) latest = node;
        if (node.shadowRoot) scan(node.shadowRoot);
      }
    }
    scan(document);
    if (!latest) return;
    const label = [...latest.querySelectorAll("span")].find(node =>
      node.textContent.includes("STATIC_RENDER_BASELINE") &&
      ![...node.children].some(child => child.textContent.includes("STATIC_RENDER_BASELINE")));
    const footer = [...latest.querySelectorAll("span")].find(node =>
      node.style.backgroundColor === "rgb(100, 149, 237)");
    return {index: latest.textContent.match(/FRAMEINDEX_(\\d+)/)?.[1],
      height: latest.getBoundingClientRect().height, label: label?.getBoundingClientRect().toJSON(),
      footer: footer?.getBoundingClientRect().toJSON()};
  })()`;
  const frames = [];
  for (let index = 0; index < 12; index++) {
    await page.evaluate((index) => globalThis.__drawConsoleFrame(index), index);
    let frame;
    for (let attempt = 0; attempt < 200; attempt++) {
      frame = await evaluate(inspect);
      if (frame?.index === String(index)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      frame?.index,
      String(index),
      "DevTools must paint the requested frame",
    );
    await evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    frame = await evaluate(inspect);
    assert(
      frame.label,
      "The actual console frame must contain the static baseline",
    );
    frames.push(frame);
  }
  const tops = frames.map((frame) => frame.label.top);
  assert(
    Math.max(...tops) - Math.min(...tops) < 0.02,
    `Static text must not shift as frames append: ${JSON.stringify(tops)}`,
  );
  assert(
    frames.every(
      (frame) => Math.abs(frame.height - Math.round(frame.height)) < 0.02,
    ),
    "Console frames must have whole-pixel heights",
  );
  assert.equal(
    await page.evaluate(() => globalThis.__clearCalls),
    0,
    "Stabilizing redraws must not clear other console messages",
  );
  const viewport = await evaluate("({width:innerWidth,height:innerHeight})");
  await send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1.1,
    mobile: false,
  });
  await page.evaluate(() => globalThis.__drawConsoleFrame(12));
  let finalFrame;
  for (let attempt = 0; attempt < 200; attempt++) {
    finalFrame = await evaluate(inspect);
    if (finalFrame?.index === "12") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(finalFrame?.index, "12");
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  finalFrame = await evaluate(inspect);
  const capture = await send("Page.captureScreenshot", { format: "png" });
  const gaps = await page.evaluate(
    async ({ data, viewportWidth, label, footer }) => {
      const bytes = Uint8Array.from(globalThis.atob(data), (character) =>
        character.charCodeAt(0),
      );
      const image = await globalThis.createImageBitmap(
        new globalThis.Blob([bytes], { type: "image/png" }),
      );
      const canvas = new globalThis.OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const scale = image.width / viewportWidth;
      const pixels = context.getImageData(
        Math.floor((label.right - 40) * scale),
        Math.ceil((footer.top - 80) * scale),
        1,
        Math.floor(64 * scale),
      ).data;
      const gaps = [];
      for (let row = 0; row < pixels.length / 4; row++)
        if (
          ![
            [13, 17, 23],
            [13, 17, 24],
          ].some((background) =>
            background.every(
              (channel, index) =>
                Math.abs(pixels[row * 4 + index] - channel) <= 1,
            ),
          )
        )
          gaps.push({ row, color: [...pixels.slice(row * 4, row * 4 + 3)] });
      return { gaps, scale, width: image.width, height: image.height, label };
    },
    {
      data: capture.data,
      viewportWidth: viewport.width,
      label: finalFrame.label,
      footer: finalFrame.footer,
    },
  );
  assert.equal(
    gaps.gaps.length,
    0,
    `Row backgrounds must meet without gaps at fractional display scaling: ${JSON.stringify({ ...gaps, gaps: gaps.gaps.slice(0, 12) })}`,
  );
  console.log(
    "Real DevTools rendering passed: stable baselines and sealed row backgrounds at fractional display scaling without clearing history.",
  );
} finally {
  for (const request of pending.values())
    globalThis.clearTimeout(request.timer);
  await browser?.close();
}
