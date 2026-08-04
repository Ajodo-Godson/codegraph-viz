import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateVisualization, loadLayerConfiguration } from "../src/app.ts";
import { parseArguments } from "../src/cli.ts";
import { createCodeGraphProject, insertFile, insertNode } from "./fixtures.ts";

test("parses complete CLI graph options", () => {
  assert.deepEqual(parseArguments(["repo", "-o", "map.html", "--level", "symbol", "--max-nodes", "25", "--filter", "src", "--trace", "events.jsonl", "--force"]), {
    projectPath: "repo", outputPath: "map.html", level: "symbol", maxNodes: 25,
    filterPaths: ["src"], tracePaths: ["events.jsonl"], json: false, force: true, help: false, version: false
  });
  assert.throws(() => parseArguments(["--max-nodes", "0"]), /positive integer/);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown option/);
});

test("generates HTML atomically and protects existing output", async () => {
  const fixture = await createCodeGraphProject({ populate(database) {
    insertFile(database, { path: "src/index.ts", nodeCount: 1 });
    insertNode(database, { id: "main", kind: "function", name: "main", filePath: "src/index.ts" });
  } });
  const directory = await mkdtemp(join(tmpdir(), "codegraph-output-"));
  const outputPath = join(directory, "map.html");
  const result = await generateVisualization({ projectPath: fixture.projectPath, outputPath, generatedAt: "2026-08-04T14:00:00Z" });
  assert.equal(result.graph.level, "file");
  assert.match(await readFile(outputPath, "utf8"), /CodeGraph map/);
  await assert.rejects(() => generateVisualization({ projectPath: fixture.projectPath, outputPath }), /use --force/);
});

test("loads and validates project layer configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codegraph-config-"));
  await writeFile(join(directory, "codegraph-viz.json"), JSON.stringify({ rename: { src: "app" } }));
  assert.deepEqual(await loadLayerConfiguration(directory), { rename: { src: "app" } });
  await writeFile(join(directory, "codegraph-viz.json"), JSON.stringify({ unsupported: true }));
  await assert.rejects(() => loadLayerConfiguration(directory), /unknown keys unsupported/);
});
