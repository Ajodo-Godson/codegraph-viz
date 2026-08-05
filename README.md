# codegraph-viz

`codegraph-viz` turns a CodeGraph SQLite index into one self-contained HTML map.
It combines the code graph with local Codex or Claude activity, Git changes, and
optional GitHub pull request evidence so agent contributions can be inspected
without sending the report over the network.

The generated page includes Code, Agents, Timeline, Changes, Knowledge, and
Review views. Agent attribution is evidence-based and is never inferred from
event timing.

## Requirements

- Node.js 22.6 or newer. Node.js 24 is used in CI.
- A completed CodeGraph index at `<project>/.codegraph/codegraph.db`.
- Chromium installed by Playwright when running the browser suite.
- Optional: an authenticated GitHub CLI for pull request review evidence.

## Install from this repository

```bash
npm install
npm run build
```

Generate a report for the current project:

```bash
node /path/to/codegraph-viz/bin/codegraph-viz.ts . \
  -o codegraph-map.html \
  --force
open codegraph-map.html
```

Automatic local Codex and Claude trace discovery is enabled by default. Disable
it or restrict it when needed:

```bash
node /path/to/codegraph-viz/bin/codegraph-viz.ts . \
  -o codegraph-map.html \
  --no-agent-traces \
  --force

node /path/to/codegraph-viz/bin/codegraph-viz.ts . \
  -o codegraph-map.html \
  --provider codex \
  --force
```

Import canonical JSON or JSONL provenance explicitly:

```bash
node /path/to/codegraph-viz/bin/codegraph-viz.ts . \
  -o codegraph-map.html \
  --trace ./events.jsonl \
  --force
```

Use `--json` to print only the normalized CodeGraph payload. Run `--help` for
the complete CLI option list.

## MCP server

The stdio MCP server exposes one tool, `visualize_codegraph`. The tool writes an
HTML file and returns its path and a compact structured summary. It never places
the HTML document in the agent context.

Example client configuration:

```json
{
  "mcpServers": {
    "codegraph-viz": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph-viz/bin/codegraph-viz-mcp.ts"]
    }
  }
}
```

After installing a packed or published package, the MCP command is simply
`codegraph-viz-mcp`.

## Evidence model

- Code structure comes from the read-only CodeGraph SQLite database.
- Agent activity comes from imported or discovered provider traces.
- Working-tree and commit evidence comes from read-only Git commands.
- Pull request checks, reviews, and unresolved-thread totals are read through
  the optional `gh` CLI.
- Missing evidence means unknown, not successful, reviewed, or authored.
- Prompts, review bodies, credentials, patches, and complete command output are
  excluded from the report.

The HTML is fully self-contained and performs no external requests. GitHub URLs
are displayed as text rather than active network links.

## Development

```bash
npm run typecheck
npm run build
npm test
npm run check
npm pack --dry-run
```

`npm run check` is also run by GitHub Actions. The test suite includes a
checked-in golden extraction payload and Playwright verification for navigation,
filters, both themes, reduced motion, desktop and narrow viewports, page errors,
horizontal overflow, and external requests.
The package test installs the generated tarball into a clean temporary project,
runs the compiled CLI, connects to the compiled MCP server over stdio, invokes
`visualize_codegraph`, and verifies that neither result contains the HTML body.

## Project status

Milestones M0 through M9, including M5.1 native trace discovery, are complete.
An append-only local live collector is a possible later feature. Offline,
immutable HTML snapshots remain the product default.
