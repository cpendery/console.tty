import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

test("MAIN API exposes the console controls without accepting enrollment secrets or returning a handle", async () => {
  const bundle = await build({
    entryPoints: ["extension/src/console-tty-trigger.ts"],
    bundle: true,
    write: false,
    format: "iife",
  });
  const messages: unknown[] = [];
  const warnings: unknown[] = [];
  const log = () => {};
  const console = { log, warn: (...args: unknown[]) => warnings.push(args) };
  const context = vm.createContext({
    console,
    location: { origin: "https://example.test" },
    window: {
      postMessage: (value: unknown) =>
        messages.push(JSON.parse(JSON.stringify(value))),
    },
  });
  const script = bundle.outputFiles[0].text;
  vm.runInContext(script, context);
  assert.equal(vm.runInContext("console.tty()", context), undefined);
  assert.deepEqual(messages, [{ type: "console.tty.start.v1" }]);
  assert.equal(vm.runInContext("console.tty('nu')", context), undefined);
  assert.equal(
    vm.runInContext("console.tty.resize(120, 32)", context),
    undefined,
  );
  assert.equal(vm.runInContext("console.tty.resize()", context), undefined);
  assert.deepEqual(messages.slice(1), [
    { type: "console.tty.start.v1", shell: "nu" },
    { type: "console.tty.resize.v1", cols: 120, rows: 32 },
    { type: "console.tty.resize.v1", fit: true },
  ]);
  assert(
    vm.runInContext(
      "['write','list','attach'].every(key => console.tty[key] === undefined)",
      context,
    ),
  );
  vm.runInContext(
    "console.tty({command:'whoami'}); console.tty('input'); console.tty('/bin/bash'); console.tty('bash -c whoami'); console.tty('bash', 'extra'); console.tty.resize(9999, 20)",
    context,
  );
  assert.equal(messages.length, 4);
  for (const action of ["pair", "connect", "status", "close", "help"]) {
    assert.equal(
      vm.runInContext(`console.tty.${action}()`, context),
      undefined,
    );
  }
  assert.deepEqual(messages.slice(4), [
    { type: "console.tty.control.v1", action: "pair" },
    { type: "console.tty.control.v1", action: "connect" },
    { type: "console.tty.control.v1", action: "status" },
    { type: "console.tty.control.v1", action: "close" },
  ]);
  vm.runInContext(
    "console.tty.pair('secret'); console.tty.connect({token:'secret'}); console.tty.status('secret'); console.tty.close('another-session')",
    context,
  );
  assert.equal(messages.length, 8);
  const first = vm.runInContext("console.tty", context);
  vm.runInContext(script, context);
  assert.equal(vm.runInContext("console.tty", context), first);
  assert.equal(console.log, log);
  assert.equal(warnings.length, 10);
  const conflicting = vm.createContext({
    console: { tty: "owned", warn: () => {} },
  });
  vm.runInContext(script, conflicting);
  assert.equal(vm.runInContext("console.tty", conflicting), "owned");
});
