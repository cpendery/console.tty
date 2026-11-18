#!/bin/sh
set -eu

# Based on microsoft/tui-test's install/install.sh (MIT).
fail() { echo "Error: $*" >&2; exit 1; }

: "${HOME:?HOME is required.}"
case "$(uname -s)" in
  Darwin)
    os=apple-darwin
    data_home="$HOME/Library/Application Support"
    ;;
  Linux)
    os=unknown-linux-gnu
    case "${XDG_DATA_HOME:-}" in
      /*) data_home="$XDG_DATA_HOME" ;;
      *) data_home="$HOME/.local/share" ;;
    esac
    ;;
  *) fail "Use install.ps1 on Windows; otherwise only Linux and macOS are supported." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 ;;
  arm64|aarch64) arch=aarch64 ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac

command -v unzip >/dev/null 2>&1 || fail "unzip is required."

bin_dir="$HOME/.local/bin"
data_dir="$data_home/console-tty"
extension_dir="$data_dir/extension"
shell="${SHELL:-/bin/sh}"
asset="console-tty-$arch-$os.tar.gz"
version="${CONSOLE_TTY_VERSION:-latest}"
base="https://github.com/cpendery/console.tty/releases"
if [ "$version" = latest ]; then
  base="$base/latest/download"
else
  base="$base/download/$version"
fi

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
download() {
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required."
  fi
}

download "$base/$asset" "$tmp/cli.tar.gz"
download "$base/console-tty-extension.zip" "$tmp/extension.zip"
contents="$(tar -tzf "$tmp/cli.tar.gz")"
[ "$contents" = console-tty ] || fail "Unexpected CLI archive contents."
tar -xzf "$tmp/cli.tar.gz" -C "$tmp"
unzip -q "$tmp/extension.zip" -d "$tmp/extension"
[ -f "$tmp/extension/manifest.json" ] || fail "Unexpected extension archive contents."
mkdir -p "$bin_dir" "$data_dir"
# Rename rather than overwrite an executable that may still be running.
install -m 755 "$tmp/console-tty" "$bin_dir/.console-tty.tmp.$$"
mv -f "$bin_dir/.console-tty.tmp.$$" "$bin_dir/console-tty"
rm -rf -- "$extension_dir"
mv "$tmp/extension" "$extension_dir"

case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *)
    # Single-quote paths so shell startup never interprets their contents.
    quoted_bin="$(printf '%s' "$bin_dir" | sed "s/'/'\\\\''/g")"
    case "${shell##*/}" in
      zsh) rc="${ZDOTDIR:-$HOME}/.zprofile" ;;
      bash)
        if [ -f "$HOME/.bash_profile" ]; then rc="$HOME/.bash_profile"
        elif [ -f "$HOME/.bash_login" ]; then rc="$HOME/.bash_login"
        else rc="$HOME/.profile"; fi
        ;;
      fish)
        rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/console-tty.fish"
        # Fish uses backslash escaping inside single quotes.
        quoted_bin="$(printf '%s' "$bin_dir" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")"
        ;;
      *) rc="$HOME/.profile" ;;
    esac
    if [ "${shell##*/}" = fish ]; then
      line="fish_add_path '$quoted_bin'"
    else
      line="export PATH='$quoted_bin':\"\$PATH\""
    fi
    mkdir -p "$(dirname "$rc")"
    if ! grep -Fqx "$line" "$rc" 2>/dev/null; then
      printf '\n%s\n' "$line" >> "$rc"
    fi
    echo "PATH updated; restart your shell."
    ;;
esac

printf 'Installed console-tty.\n1. Load %s at chrome://extensions (Developer mode > Load unpacked).\n2. Run: console-tty native-host install YOUR_EXTENSION_ID (Edge: add --browser edge).\n' "$extension_dir"
