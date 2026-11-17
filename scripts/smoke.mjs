import { spawnSync } from "node:child_process";

const result = spawnSync(
  "cargo",
  [
    "test",
    "--workspace",
    "private_daemon_pairing_shell_reconnect_resize_revocation",
    "--",
    "--nocapture",
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
process.exitCode = result.status ?? 1;
