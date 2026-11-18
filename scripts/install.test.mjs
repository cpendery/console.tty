import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const windows = process.platform === "win32";
const installer = resolve(windows ? "install.ps1" : "install.sh");

function run(command, args, env, cwd) {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    cwd,
  });
  assert.ifError(result.error);
  return result;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "console-tty-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test(
  "Unix installer selects assets, persists PATH and unpacks the extension",
  {
    skip: windows,
  },
  async (t) => {
    for (const [os, arch, target, shell, rc] of [
      ["Linux", "x86_64", "x86_64-unknown-linux-gnu", "/bin/sh", ".profile"],
      [
        "Linux",
        "aarch64",
        "aarch64-unknown-linux-gnu",
        "/bin/bash",
        ".bash_profile",
      ],
      ["Darwin", "arm64", "aarch64-apple-darwin", "/bin/zsh", ".zprofile"],
      ["Darwin", "x86_64", "x86_64-apple-darwin", "", ".profile"],
    ]) {
      await t.test(target, (t) => {
        const root = fixture(t);
        const home = join(root, "home ' $USER");
        const mocks = join(root, "mocks");
        const payload = join(root, "payload");
        const extensionPayload = join(root, "extension");
        for (const dir of [home, mocks, payload, extensionPayload])
          mkdirSync(dir);
        const manifest =
          '{"manifest_version":3,"name":"fixture","version":"1.0"}';
        writeFileSync(join(extensionPayload, "manifest.json"), manifest);
        mkdirSync(join(extensionPayload, "scripts"));
        writeFileSync(
          join(extensionPayload, "scripts/worker.js"),
          "// fixture\n",
        );
        const extensionArchive = join(root, "extension.zip");
        assert.equal(
          run(
            "zip",
            ["-qr", extensionArchive, "."],
            undefined,
            extensionPayload,
          ).status,
          0,
        );
        writeFileSync(
          join(payload, "console-tty"),
          "#!/bin/sh\necho fixture-cli\n",
        );
        const archive = join(root, "cli.tar.gz");
        assert.equal(
          run("tar", ["-czf", archive, "-C", payload, "console-tty"]).status,
          0,
        );
        writeFileSync(
          join(mocks, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo ${arch};; esac\n`,
        );
        writeFileSync(
          join(mocks, "curl"),
          `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    https:*) url="$1";;
    -o) shift; out="$1";;
  esac
  shift
done
printf '%s\\n' "$url" >> "$DOWNLOAD_LOG"
case "$url" in
  */console-tty-extension.zip) cp "$EXTENSION_ARCHIVE" "$out";;
  */console-tty-$EXPECTED_TARGET.tar.gz) cp "$CLI_ARCHIVE" "$out";;
  *) exit 22;;
esac
`,
        );
        for (const name of ["uname", "curl"])
          chmodSync(join(mocks, name), 0o755);
        if (rc === ".bash_profile")
          writeFileSync(join(home, rc), "# existing\n");
        const env = {
          HOME: home,
          SHELL: shell,
          PATH: `${mocks}:${process.env.PATH}`,
          XDG_DATA_HOME:
            os === "Linux" && arch === "aarch64"
              ? "relative-ignored"
              : join(root, "data space"),
          CONSOLE_TTY_VERSION: "v0.1.0",
          DOWNLOAD_LOG: join(root, "downloads"),
          EXPECTED_TARGET: target,
          CLI_ARCHIVE: archive,
          EXTENSION_ARCHIVE: extensionArchive,
        };
        const dataHome =
          os === "Darwin"
            ? join(home, "Library/Application Support")
            : arch === "aarch64"
              ? join(home, ".local/share")
              : env.XDG_DATA_HOME;
        const extensionDir = join(dataHome, "console-tty/extension");
        for (let i = 0; i < 3; i++) {
          const result = run("sh", [installer], {
            ...env,
            PATH:
              i === 2 ? `${join(home, ".local/bin")}:${env.PATH}` : env.PATH,
          });
          assert.equal(result.status, 0, result.stderr);
          assert.match(
            result.stdout,
            /console-tty native-host install YOUR_EXTENSION_ID/,
          );
          assert.ok(result.stdout.includes(extensionDir));
          assert.doesNotMatch(result.stdout, /Unzip/);
          assert.equal(
            readFileSync(join(extensionDir, "manifest.json"), "utf8"),
            manifest,
          );
          assert.equal(
            readFileSync(join(extensionDir, "scripts/worker.js"), "utf8"),
            "// fixture\n",
          );
          assert.ok(!existsSync(join(extensionDir, "obsolete.js")));
          writeFileSync(join(extensionDir, "obsolete.js"), "// old release\n");
        }
        assert.ok(
          !existsSync(join(dataHome, "console-tty/console-tty-extension.zip")),
        );
        assert.equal(
          readFileSync(join(home, rc), "utf8").match(/export PATH=/g).length,
          1,
        );
        const sourced = run(
          "sh",
          ["-c", '. "$HOME/' + rc + '"; command -v console-tty; console-tty'],
          env,
        );
        assert.equal(sourced.status, 0, sourced.stderr);
        assert.ok(
          sourced.stdout.includes(join(home, ".local/bin/console-tty")),
        );
        assert.match(sourced.stdout, /fixture-cli/);
        assert.match(
          readFileSync(env.DOWNLOAD_LOG, "utf8"),
          /releases\/download\/v0\.1\.0\//,
        );

        // Invalid extension downloads must not replace an existing installation.
        for (const missingManifest of [false, true]) {
          rmSync(extensionArchive);
          if (missingManifest) {
            assert.equal(
              run(
                "zip",
                ["-q", extensionArchive, "scripts/worker.js"],
                undefined,
                extensionPayload,
              ).status,
              0,
            );
          } else {
            writeFileSync(extensionArchive, "not a zip");
          }
          const failed = run("sh", [installer], env);
          assert.notEqual(failed.status, 0);
          if (missingManifest)
            assert.match(
              failed.stderr,
              /Unexpected extension archive contents/,
            );
          assert.equal(
            readFileSync(join(home, ".local/bin/console-tty"), "utf8"),
            "#!/bin/sh\necho fixture-cli\n",
          );
          assert.equal(
            readFileSync(join(extensionDir, "manifest.json"), "utf8"),
            manifest,
          );
          assert.ok(existsSync(join(extensionDir, "obsolete.js")));
        }

        // A corrupt CLI archive must not replace an existing installation.
        writeFileSync(archive, "not a tarball");
        const failed = run("sh", [installer], env);
        assert.notEqual(failed.status, 0);
        assert.equal(
          readFileSync(join(home, ".local/bin/console-tty"), "utf8"),
          "#!/bin/sh\necho fixture-cli\n",
        );
      });
    }
  },
);

test(
  "Unix installer rejects unsupported platforms before downloading",
  {
    skip: windows,
  },
  (t) => {
    const root = fixture(t);
    writeFileSync(join(root, "uname"), "#!/bin/sh\necho FreeBSD\n");
    chmodSync(join(root, "uname"), 0o755);
    const result = run("sh", [installer], {
      PATH: `${root}:${process.env.PATH}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only Linux and macOS/);
  },
);

test(
  "Windows installer installs release assets and updates PATH idempotently",
  {
    skip: !windows,
  },
  (t) => {
    const root = fixture(t);
    const wrapper = join(root, "test.ps1");
    writeFileSync(
      wrapper,
      `
$ErrorActionPreference = "Stop"
$root = $env:INSTALL_TEST_ROOT
$env:LOCALAPPDATA = Join-Path $root "local"
$env:XDG_DATA_HOME = Join-Path $root "data space"
$env:CONSOLE_TTY_VERSION = "v0.1.0"
$env:PROCESSOR_ARCHITEW6432 = "AMD64"
$payload = Join-Path $root "console-tty.exe"
Set-Content -LiteralPath $payload -Value "fixture-cli"
$cliArchive = Join-Path $root "cli.zip"
Compress-Archive -LiteralPath $payload -DestinationPath $cliArchive
$extensionPayload = Join-Path $root "extension"
New-Item -ItemType Directory -Path (Join-Path $extensionPayload "scripts") | Out-Null
Set-Content -LiteralPath (Join-Path $extensionPayload "manifest.json") -Value '{"manifest_version":3,"name":"fixture","version":"1.0"}'
$worker = Join-Path $extensionPayload "scripts\\worker.js"
Set-Content -LiteralPath $worker -Value "// fixture"
$extensionArchive = Join-Path $root "extension.zip"
Compress-Archive -Path "$extensionPayload\\*" -DestinationPath $extensionArchive
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing)
    if ($Uri -notlike "*/releases/download/v0.1.0/*") { throw "Wrong release: $Uri" }
    if ($Uri -like "*/console-tty-x86_64-pc-windows-msvc.zip") {
        Copy-Item -LiteralPath (Join-Path $env:INSTALL_TEST_ROOT "cli.zip") -Destination $OutFile
    } elseif ($Uri -like "*/console-tty-extension.zip") {
        Copy-Item -LiteralPath (Join-Path $env:INSTALL_TEST_ROOT "extension.zip") -Destination $OutFile
    } else { throw "Wrong asset: $Uri" }
}
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
$old = $key.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$kind = if ($null -ne $old) { $key.GetValueKind("Path") } else { $null }
try {
    $key.SetValue("Path", "%USERPROFILE%\\existing", [Microsoft.Win32.RegistryValueKind]::ExpandString)
    & $env:INSTALL_TEST_SCRIPT
    $extensionDir = Join-Path $env:LOCALAPPDATA "console-tty\\extension"
    Set-Content -LiteralPath (Join-Path $extensionDir "obsolete.js") -Value "// old release"
    & $env:INSTALL_TEST_SCRIPT
    $bin = Join-Path $env:LOCALAPPDATA "Programs\\console-tty\\bin"
    if (-not (Test-Path (Join-Path $bin "console-tty.exe"))) { throw "Missing CLI" }
    if (-not (Test-Path (Join-Path $extensionDir "manifest.json") -PathType Leaf)) { throw "Missing manifest" }
    if (-not (Test-Path (Join-Path $extensionDir "scripts\\worker.js") -PathType Leaf)) { throw "Missing nested extension file" }
    if (Test-Path (Join-Path $extensionDir "obsolete.js")) { throw "Stale extension file" }
    if (Test-Path (Join-Path $env:LOCALAPPDATA "console-tty\\console-tty-extension.zip")) { throw "Extension ZIP was not unpacked" }
    if (Test-Path $env:XDG_DATA_HOME) { throw "Windows must ignore XDG_DATA_HOME" }
    $stored = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($stored -ne "$bin;%USERPROFILE%\\existing") { throw "Wrong persistent PATH: $stored" }
    if (@($env:Path.Split(";") | Where-Object { $_ -eq $bin }).Count -ne 1) { throw "Wrong process PATH" }
    if ($key.GetValueKind("Path") -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw "Lost registry kind" }
    $cliBefore = Get-Content -LiteralPath (Join-Path $bin "console-tty.exe") -Raw
    $manifestBefore = Get-Content -LiteralPath (Join-Path $extensionDir "manifest.json") -Raw
    foreach ($missingManifest in @($false, $true)) {
        Remove-Item -LiteralPath $extensionArchive
        if ($missingManifest) {
            Compress-Archive -LiteralPath $worker -DestinationPath $extensionArchive
        } else {
            Set-Content -LiteralPath $extensionArchive -Value "not a ZIP"
        }
        $failed = $false
        try { & $env:INSTALL_TEST_SCRIPT }
        catch {
            $failed = $true
            if ($missingManifest -and $_ -notmatch "Unexpected extension archive contents") { throw }
        }
        if (-not $failed) { throw "Invalid extension archive was accepted" }
        if ((Get-Content -LiteralPath (Join-Path $bin "console-tty.exe") -Raw) -ne $cliBefore) { throw "CLI replaced after invalid extension" }
        if ((Get-Content -LiteralPath (Join-Path $extensionDir "manifest.json") -Raw) -ne $manifestBefore) { throw "Extension replaced after invalid download" }
    }
} finally {
    if ($null -eq $old) { $key.DeleteValue("Path", $false) }
    else { $key.SetValue("Path", $old, $kind) }
    $key.Dispose()
}
`,
    );
    const result = run("pwsh", ["-NoProfile", "-File", wrapper], {
      INSTALL_TEST_ROOT: root,
      INSTALL_TEST_SCRIPT: installer,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /console-tty native-host install YOUR_EXTENSION_ID/,
    );
    const extensionDir = join(root, "local/console-tty/extension");
    assert.ok(result.stdout.includes(extensionDir));
    assert.doesNotMatch(result.stdout, /Unzip/);
    assert.deepEqual(
      JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")),
      { manifest_version: 3, name: "fixture", version: "1.0" },
    );
    assert.equal(
      readFileSync(join(extensionDir, "scripts/worker.js"), "utf8").trim(),
      "// fixture",
    );
  },
);
