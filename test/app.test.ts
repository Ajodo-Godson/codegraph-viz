import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateVisualization, loadLayerConfiguration } from "../src/app.ts";
import { parseArguments } from "../src/cli.ts";
import { createCodeGraphProject, insertFile, insertNode } from "./fixtures.ts";

test("parses complete CLI graph options", () => {
  assert.deepEqual(parseArguments(["repo", "-o", "map.html", "--level", "symbol", "--max-nodes", "25", "--filter", "src", "--trace", "events.jsonl", "--provider", "codex", "--no-agent-traces", "--force"]), {
    projectPath: "repo", outputPath: "map.html", level: "symbol", maxNodes: 25,
    filterPaths: ["src"], tracePaths: ["events.jsonl"], autoTraces: false, providers: ["codex"], json: false, force: true, help: false, version: false
  });
  assert.throws(() => parseArguments(["--max-nodes", "0"]), /positive integer/);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown option/);
  assert.throws(() => parseArguments(["--provider", "other"]), /Invalid provider/);
});

test("generates HTML atomically and protects existing output", async () => {
  const fixture = await createCodeGraphProject({ populate(database) {
    insertFile(database, { path: "src/index.ts", nodeCount: 1 });
    insertNode(database, { id: "main", kind: "function", name: "main", filePath: "src/index.ts" });
  } });
  const directory = await mkdtemp(join(tmpdir(), "codegraph-output-"));
  const outputPath = join(directory, "map.html");
  const result = await generateVisualization({ projectPath: fixture.projectPath, outputPath, generatedAt: "2026-08-04T14:00:00Z", autoTraces: false });
  assert.equal(result.graph.level, "file");
  assert.match(await readFile(outputPath, "utf8"), /CodeGraph map/);
  await assert.rejects(() => generateVisualization({ projectPath: fixture.projectPath, outputPath, autoTraces: false }), /use --force/);
});

test("automatically imports matching local agent traces", async () => {
  const fixture = await createCodeGraphProject({ populate(database) {
    insertFile(database, { path: "src/index.ts", nodeCount: 1 });
    insertNode(database, { id: "main", kind: "function", name: "main", filePath: "src/index.ts" });
  } });
  const directory = await mkdtemp(join(tmpdir(), "codegraph-auto-trace-"));
  const codexRoot = join(directory, "codex");
  const claudeRoot = join(directory, "claude");
  await Promise.all([mkdir(codexRoot, { recursive: true }), mkdir(claudeRoot, { recursive: true })]);
  await writeFile(join(codexRoot, "session.jsonl"), [
    JSON.stringify({ type: "session_meta", timestamp: "2026-08-04T10:00:00Z", payload: { id: "run-1", cwd: fixture.projectPath } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-08-04T10:01:00Z", payload: { type: "task_complete" } })
  ].join("\n"));
  const result = await generateVisualization({
    projectPath: fixture.projectPath,
    outputPath: join(directory, "map.html"),
    traceRoots: { codex: codexRoot, claude: claudeRoot }
  });
  assert.equal(result.graph.provenance?.length, 2);
  assert.deepEqual(result.graph.traceDiagnostics?.map(({ provider, sessionsMatched }) => ({ provider, sessionsMatched })), [
    { provider: "codex", sessionsMatched: 1 }, { provider: "claude", sessionsMatched: 0 }
  ]);
});

test("preserves normalized source order when merging timestamp ties", async () => {
  const fixture = await createCodeGraphProject({ populate(database) {
    insertFile(database, { path: "src/index.ts", nodeCount: 1 });
    insertNode(database, { id: "main", kind: "function", name: "main", filePath: "src/index.ts" });
  } });
  const directory = await mkdtemp(join(tmpdir(), "codegraph-merge-order-"));
  const tracePath = join(directory, "events.json");
  await writeFile(tracePath, JSON.stringify([
    { id: "z-first", timestamp: "2026-08-04T12:00:00Z", runId: "run", kind: "file_read", target: "src/index.ts" },
    { id: "a-second", timestamp: "2026-08-04T12:00:00Z", runId: "run", kind: "file_edited", target: "src/index.ts" }
  ]));
  const result = await generateVisualization({
    projectPath: fixture.projectPath, outputPath: join(directory, "map.html"), tracePaths: [tracePath], autoTraces: false
  });
  assert.deepEqual(result.graph.provenance?.map(({ id }) => id), ["z-first", "a-second"]);
});

test("loads and validates project layer configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codegraph-config-"));
  await writeFile(join(directory, "codegraph-viz.json"), JSON.stringify({ rename: { src: "app" } }));
  assert.deepEqual(await loadLayerConfiguration(directory), { rename: { src: "app" } });
  await writeFile(join(directory, "codegraph-viz.json"), JSON.stringify({ unsupported: true }));
  await assert.rejects(() => loadLayerConfiguration(directory), /unknown keys unsupported/);
});
