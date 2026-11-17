import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await mkdir("dist/extension", { recursive: true });
await rm("dist/extension", { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
await cp("extension/static", "dist/extension", { recursive: true });
await build({
  entryPoints: [
    "extension/src/worker.ts",
    "extension/src/console-renderer.ts",
    "extension/src/console-tty-trigger.ts",
    "extension/src/input.ts",
  ],
  outdir: "dist/extension",
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: true,
});
