# codegraph-viz

Generate a self-contained visualization of a
[CodeGraph](https://github.com/colbymchenry/codegraph) index, including code,
agent activity, changes, knowledge, and review evidence.

## Install

Requires Node.js 22.6 or newer.

```sh
curl -fsSL https://raw.githubusercontent.com/Ajodo-Godson/codegraph-viz/main/install.sh | sh
```

## Use

```sh
cd your-project
codegraph-viz
```

If the project has no CodeGraph index, confirm the prompt to create one. For
non-interactive use:

```sh
codegraph-viz --init
```

The visualization is written to `codegraph-map.html`.

```sh
open codegraph-map.html       # macOS
xdg-open codegraph-map.html   # Linux
```

## MCP

```sh
codex mcp add codegraph-viz -- codegraph-viz-mcp
claude mcp add --scope user codegraph-viz -- codegraph-viz-mcp
```

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/Ajodo-Godson/codegraph-viz/main/install.sh | sh -s -- --uninstall
```
