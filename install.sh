#!/bin/sh

set -eu

REPO="${CODEGRAPH_VIZ_REPO:-Ajodo-Godson/codegraph-viz}"
REF="${CODEGRAPH_VIZ_REF:-main}"
INSTALL_DIR="${CODEGRAPH_VIZ_INSTALL_DIR:-$HOME/.codegraph-viz}"
BIN_DIR="${CODEGRAPH_VIZ_BIN_DIR:-$HOME/.local/bin}"
MARKER_NAME=".codegraph-viz-install"

validate_directory() {
  label="$1"
  directory="$2"
  case "$directory" in
    ""|/|//|.|"$HOME"|"$HOME/") echo "codegraph-viz: refusing to use an unsafe $label directory." >&2; exit 1 ;;
    /*) ;;
    *) echo "codegraph-viz: refusing to use a relative $label directory." >&2; exit 1 ;;
  esac
}

remove_owned_launcher() {
  launcher="$1"
  target="$2"
  if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$target" ]; then rm -f "$launcher"; fi
}

usage() {
  echo "Usage: install.sh [--uninstall]"
  echo ""
  echo "Environment:"
  echo "  CODEGRAPH_VIZ_REF          Git tag or branch to install (default: main)"
  echo "  CODEGRAPH_VIZ_INSTALL_DIR  Installation directory (default: ~/.codegraph-viz)"
  echo "  CODEGRAPH_VIZ_BIN_DIR      Launcher directory (default: ~/.local/bin)"
}

case "${1:-}" in
  "") ;;
  --help|-h)
    usage
    exit 0
    ;;
  --uninstall)
    validate_directory "install" "$INSTALL_DIR"
    validate_directory "launcher" "$BIN_DIR"
    destination="$INSTALL_DIR/current"
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      if [ ! -f "$destination/$MARKER_NAME" ]; then
        echo "codegraph-viz: refusing to remove unowned installation at $destination." >&2
        exit 1
      fi
      rm -rf "$destination"
    fi
    remove_owned_launcher "$BIN_DIR/codegraph-viz" "$destination/dist/bin/codegraph-viz.js"
    remove_owned_launcher "$BIN_DIR/codegraph-viz-mcp" "$destination/dist/bin/codegraph-viz-mcp.js"
    rmdir "$INSTALL_DIR" 2>/dev/null || true
    echo "codegraph-viz uninstalled."
    exit 0
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

validate_directory "install" "$INSTALL_DIR"
validate_directory "launcher" "$BIN_DIR"

command -v curl >/dev/null 2>&1 || { echo "codegraph-viz: curl is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "codegraph-viz: tar is required." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "codegraph-viz: Node.js 22.6 or newer is required." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "codegraph-viz: npm is required." >&2; exit 1; }

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 6) ? 0 : 1)' || {
  echo "codegraph-viz: Node.js 22.6 or newer is required; found $(node --version)." >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
archive="$tmp/source.tar.gz"
source_dir="$tmp/source"
url="https://github.com/$REPO/archive/$REF.tar.gz"

echo "Installing codegraph-viz from $REPO@$REF..."
curl -fsSL "$url" -o "$archive" || { echo "codegraph-viz: download failed: $url" >&2; exit 1; }
mkdir -p "$source_dir"
tar -xzf "$archive" -C "$source_dir" --strip-components=1

(cd "$source_dir" && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund)
chmod +x "$source_dir/dist/bin/codegraph-viz.js" "$source_dir/dist/bin/codegraph-viz-mcp.js"
touch "$source_dir/$MARKER_NAME"

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
destination="$INSTALL_DIR/current"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  if [ ! -f "$destination/$MARKER_NAME" ]; then
    echo "codegraph-viz: refusing to replace unowned installation at $destination." >&2
    exit 1
  fi
fi
for launcher in "$BIN_DIR/codegraph-viz" "$BIN_DIR/codegraph-viz-mcp"; do
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    case "$launcher" in
      "$BIN_DIR/codegraph-viz") expected="$destination/dist/bin/codegraph-viz.js" ;;
      *) expected="$destination/dist/bin/codegraph-viz-mcp.js" ;;
    esac
    if [ ! -L "$launcher" ] || [ "$(readlink "$launcher")" != "$expected" ]; then
      echo "codegraph-viz: refusing to replace unowned launcher at $launcher." >&2
      exit 1
    fi
  fi
done
if [ -e "$destination" ] || [ -L "$destination" ]; then rm -rf "$destination"; fi
mv "$source_dir" "$destination"
ln -sf "$destination/dist/bin/codegraph-viz.js" "$BIN_DIR/codegraph-viz"
ln -sf "$destination/dist/bin/codegraph-viz-mcp.js" "$BIN_DIR/codegraph-viz-mcp"

echo "Installed codegraph-viz to $destination"
echo "Linked $BIN_DIR/codegraph-viz"
echo "Linked $BIN_DIR/codegraph-viz-mcp"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR is not on PATH. Add it with:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Next:"
echo "  cd your-project"
echo "  codegraph-viz"
echo ""
echo "If the CodeGraph index is missing, codegraph-viz will ask to create it."
echo "For non-interactive use: codegraph-viz --init"
echo ""
echo "Optional MCP setup:"
echo "  codex mcp add codegraph-viz -- codegraph-viz-mcp"
echo "  claude mcp add --scope user codegraph-viz -- codegraph-viz-mcp"
echo ""
echo "Uninstall with:"
echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s -- --uninstall"
