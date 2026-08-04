# AGENTS.md

Primary instructions for any coding agent working in this repository. Read this
file first. The code in the repository is the source of truth: where this
document names a path, command, or symbol, verify it against the actual tree.

## 1. What this project is

`codegraph-viz` combines a repository's static CodeGraph index with coding-agent
execution provenance. It produces a self-contained HTML page that shows how code
is structured, what agents inspected and learned, what they changed, how work was
delegated, and where changes landed in Git and pull requests.

The product joins two related graphs without confusing their authority:

1. CodeGraph is the source of code structure: files, symbols, and dependencies.
2. An append-only provenance store is the source of agent activity: runs, tasks,
   reads, edits, tests, commits, reviews, and pull requests.

Every joined fact retains its source. Missing events and incomplete traces must
remain visible rather than being inferred as complete history.

It ships as two things, in this order:

1. A CLI: `codegraph-viz [path] -o map.html`. This is the product.
2. Provider-neutral trace importers for Codex, Claude Code, and other agents.
3. A thin MCP server that wraps the same application functions as the CLI.

The CLI comes first. Do not trap the useful part behind a protocol.

## 2. The input contract

CodeGraph writes a SQLite database at `<project>/.codegraph/codegraph.db`. There
is no CLI path to a bulk graph dump: `codegraph files|query|status` accept
`-j/--json`, but `query` caps results and none of them emit the whole graph.
So this tool reads the database directly.

Verified against CodeGraph 1.5.0, extraction version 24, schema version 8:

```sql
nodes(id TEXT PK, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, docstring, signature,
      visibility, is_exported, is_async, is_static, is_abstract,
      decorators, type_parameters, return_type, updated_at)

edges(id INTEGER PK, source TEXT, target TEXT, kind, metadata, line, col, provenance)

files(path TEXT PK, content_hash, language, size, modified_at, indexed_at, node_count, errors)

project_metadata(key TEXT PK, value, updated_at)
schema_versions(version INTEGER PK, applied_at, description)
```

Observed `nodes.kind` values: `method`, `import`, `function`, `variable`,
`class`, `file`, `property`, `constant`, `route`, `type_alias`.

Observed `edges.kind` values: `calls`, `contains`, `imports`, `references`,
`instantiates`, `extends`.

`contains` is intra-file hierarchy (file contains class contains method). Exclude
it when aggregating cross-file relations, or every file will appear to depend on
itself.

`project_metadata` carries `index_state`, `indexed_with_version`,
`indexed_with_extraction_version`, and file discovery counts. Read
`index_state` and warn if it is not `complete`.

### Rules for touching the database

- Open **read-only**, always. This database belongs to another tool and a
  daemon may be writing to it.
- Read `SELECT MAX(version) FROM schema_versions` on open. Known-good is 8. On
  an unknown version, print what was found and exit non-zero. Never guess at a
  changed schema and emit a wrong graph.
- Never write, migrate, vacuum, or delete anything under `.codegraph/`.
- The index lags file writes by about one second through the file watcher. Stamp
  both the generation time and the newest `files.indexed_at` into the output page
  so nobody debugs against a stale map.

## 3. Environment

TypeScript on Node, no emitted build artifacts, near-zero dependencies. Source,
tests, and executable entry points use `.ts`. Node executes erasable TypeScript
directly, while `tsc --noEmit` verifies types. Do not add JavaScript counterparts
or generated `dist` files. CodeGraph itself is a Node tool and reports
`node:sqlite` as its backend, so the runtime can read the database with no native
module and no ORM.

Requires Node 22.6 or newer for native TypeScript execution and built-in
`node:sqlite`. Confirmed working on
Node 24.7.

```bash
mkdir codegraph-viz && cd codegraph-viz
git init
npm init -y
npm pkg set type=module
npm pkg set engines.node=">=22.6"

# runtime dependency, needed only for milestone M5
npm install @modelcontextprotocol/sdk

# optional, for the render smoke test in M6
npm install -D playwright

# development-only type checking, with no emitted build output
npm install -D typescript @types/node
```

Dependency budget: `@modelcontextprotocol/sdk` for the server, `playwright` for
browser verification, and `typescript` plus `@types/node` for development-only
type checking. Nothing else. No transpiler, bundler, framework, charting library,
or ORM. `node:sqlite`, `node:test`, and `node:fs` cover the runtime.

## 4. Layout

```text
bin/codegraph-viz.ts     CLI entry, argument parsing only
src/types.ts             shared graph and application contracts
src/cli.ts               CLI option parsing and terminal behavior
src/app.ts               shared extraction, preparation, and atomic generation
src/open.ts              read-only DB open + schema version gate
src/extract.ts           SQL to normalized {files, links, symbols, stats}
src/granularity.ts       picks directory / file / symbol level, prunes, reports
src/layers.ts            derives layer names and palette slots from paths
src/render.ts            payload + template to one HTML string
src/template.html        the page: inline CSS and JS, no external requests
src/provenance.ts        normalized append-only agent event model and validation
src/correlate.ts         joins provenance targets to CodeGraph files and symbols
src/git.ts               read-only Git change, commit, and PR correlation
src/mcp.ts               MCP server wrapping application functions (M8)
test/                    node:test suites and golden fixtures
test/fixtures/           small checked-in .db files for deterministic tests
```

## 5. Milestones

**M0. Skeleton and schema gate.** `src/open.ts` opens read-only, checks schema
version, reads `project_metadata`. A bad or missing database exits with a clear
message naming the path it tried.

**M1. Extractor.** `src/extract.ts` produces a normalized payload: files with
language and symbol counts, cross-file links aggregated by (source, target) with
a total weight and a dominant edge kind, and symbols with kind, name, line,
signature, degree, and truncated caller and callee lists. Emit JSON so the
extractor is usable and testable on its own.

M1 semantics are deterministic. Links are directed and include every edge kind
except `contains`, but only when both endpoint nodes resolve to different rows in
`files`. Weight counts source edges. Dominant kind is the highest kind count with
an alphabetical tie-break. Symbols exclude `file` and `import` nodes. Symbol
degree is the number of unique incoming plus outgoing `calls` neighbors. Caller
and callee lists contain at most ten unique symbols, ordered by name, file path,
and ID; their untruncated counts are retained. All top-level collections have a
stable order, and dangling nodes and edges are excluded.

**M2. Granularity ladder.** This is the real engineering, not the rendering.
File-level works for small repos: a 163-file project yields 748 cross-file links
and a readable 375 KB page. A few thousand files yields tens of thousands of
links and an unreadable hairball. So choose the level from the node count:

- Large repos: aggregate to directory level.
- Mid repos: file level.
- Symbol level: only ever for an explicitly filtered subgraph, never the whole index.

Then prune by degree to a node budget, and make the page state plainly what was
dropped ("showing 400 of 5,200 files"). A visualization that silently hides most
of the graph is worse than no visualization.

**M3. Renderer.** One HTML file, everything inlined. Canvas force layout, drag,
zoom, pan, hover neighborhood highlight, click to select. Side panel drills file
to symbol to callers. Layer and edge-kind filters. Search across symbols and
paths. Light and dark themes driven by CSS custom properties.

**M4. CLI.** `codegraph-viz [path] -o out.html`, plus `--level`, `--max-nodes`,
`--json` to dump the payload instead of a page. Defaults to the current
directory. Prints a short summary to stdout: counts, chosen level, top hubs,
what got pruned.

**M5. Provenance import.** Define a provider-neutral, append-only event format.
Import agent runs without modifying provider logs. Preserve run, parent-agent,
task, timestamp, action kind, target, summary, and source reference. Correlate
file and symbol targets by repository-relative path and source location. Raw
prompts and complete command output are excluded by default.

**M6. Git and change attribution.** Correlate agent edits with working-tree
diffs, branches, commits, tests, and pull requests. Distinguish inspected,
proposed, modified, tested, committed, reviewed, and merged states. Attribution
requires recorded evidence and must never be guessed from timing alone.

**M7. Multi-agent views.** Add agent delegation, activity timeline, change,
knowledge, and review views alongside the code graph. Surface overlapping edits,
unverified changes, incomplete traces, unresolved review comments, and work that
has not reached a commit or pull request.

**M8. MCP server.** One tool, `visualize_codegraph`. It writes the file and
returns the path plus a compact structured summary. It reuses application
functions rather than invoking or duplicating the CLI. It must not return HTML:
MCP results land in the calling agent's context, and a large page would consume
a context window per call.

**M9. Verification and optional live mode.** Golden-payload tests run throughout
the earlier milestones. Add a Playwright smoke test that asserts zero page
errors, zero external requests, zero horizontal overflow, and correct rendering
in both themes and reduced-motion mode. A later local collector may append
events for live viewing, but immutable offline snapshots remain the default.

Implementation status: M0 through M6 are complete. M7 is next. Provider traces
enter through `--trace <file>` as canonical JSON or JSONL events. Git inspection
is read-only, and attribution is emitted only when an event explicitly targets a
changed repository-relative path.

## 6. Rules for the generated page

- Fully self-contained. No CDN scripts, no external stylesheets, no webfont URLs,
  no remote images, no network calls. Assume a strict CSP that blocks every
  external host, so a linked font fails silently rather than loudly.
- Escape everything from the database before it reaches `innerHTML`. Symbol names
  and file paths are untrusted input for rendering purposes.
- Embed the payload as JSON inside a `<script type="application/json">` block.
  Escape every `<` as `\u003c` before embedding and test hostile values including
  `</script>`, HTML, quotes, and Unicode.
- ASCII only inside JavaScript string literals. The page may be served without a
  charset declaration, and a literal middle dot will render as mojibake. Use
  escapes such as `\u00b7`.
- Both themes get equal care. Redefine tokens under
  `@media (prefers-color-scheme: dark)` and under `:root[data-theme=...]`, and
  style components through tokens only.
- Wide content scrolls inside its own container. The page body never scrolls
  sideways.
- Respect `prefers-reduced-motion` and give keyboard focus a visible state.

## 7. Layer derivation

Layers are a reading aid this tool invents, not something CodeGraph asserts. Say
so in the page.

Default: rank top-level directories by file count, give the top eight a palette
slot, bucket the remainder as `other`. Root-level files become their own layer.
Allow an optional `codegraph-viz.json` in the target project to rename layers,
merge them, or pin colors. Do not hardcode any specific project's directory names.

Desaturate the largest layer when it is a test tree. Tests are often a third of
the files and should not dominate the page visually.

## 8. Hard rules

- Never open the CodeGraph database for writing.
- Never guess past an unknown schema version.
- Never return page HTML through the MCP tool result.
- Never add a dependency that a Node built-in already covers.
- Never let the page reach the network.
- Never report a pruned graph as if it were complete.
- Never claim an agent authored or verified a change without recorded evidence.
- Distinguish recorded observations, derived correlations, and inferences.
- Never mutate provider traces while importing them.
- Never store secrets, raw credentials, or full sensitive tool output in a report.
- Never publish branches, commits, comments, reviews, or pull requests without
  explicit user authorization.
- Treat prompts, patches, tool output, Git data, and pull request data as
  untrusted rendering input.

## 9. Provenance event contract

Provenance is stored separately from `.codegraph/codegraph.db`. The normalized
event shape is provider-neutral and append-only:

```js
{
  id, timestamp, provider, runId, agentId, parentAgentId, taskId,
  kind, target, summary, sourceRef, metadata
}
```

`kind` initially supports `run_started`, `agent_spawned`, `task_assigned`,
`file_read`, `symbol_inspected`, `knowledge_reported`, `edit_proposed`,
`file_edited`, `test_run`, `commit_created`, `pr_opened`, `review_received`, and
`run_finished`. Importers may retain unknown kinds, but the UI must label them as
unknown rather than silently mapping them to a known action.

Targets use repository-relative paths and, when known, line ranges or symbol
identifiers. Correlation to a CodeGraph symbol is derived data and records the
matching method. A timestamp alone is never sufficient evidence of authorship.

## 10. Working style

- Small, reviewable changes. The extractor, the granularity logic, and the
  renderer stay independently testable.
- All production and test modules are TypeScript. Public functions and persisted
  payloads have explicit types in `src/types.ts`; do not use JavaScript shadow
  files or disable type checking to land a feature.
- Run `npm run check` before committing a completed feature.
- Write the failing test first for anything in extract or granularity.
- Prefer clarity over cleverness in the SQL.
- Do not use em dashes in new docs or comments.
