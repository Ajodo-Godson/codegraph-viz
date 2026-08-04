import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runVisualizeTool, toolDefinition } from "../src/mcp.ts";
import { createCodeGraphProject, insertFile, insertNode } from "./fixtures.ts";

test("MCP tool writes a visualization and returns only a compact summary", async () => {
  const fixture = await createCodeGraphProject({ populate(database) {
    insertFile(database, { path: "src/index.ts", nodeCount: 1 });
    insertNode(database, { id: "main", kind: "function", name: "main", filePath: "src/index.ts" });
  } });
  const outputPath = join(await mkdtemp(join(tmpdir(), "codegraph-mcp-")), "map.html");
  const result = await runVisualizeTool({ projectPath: fixture.projectPath, outputPath, autoAgentTraces: false });
  const serialized = JSON.stringify(result);
  assert.equal(result.structuredContent.outputPath, outputPath);
  assert.equal(result.content[0]?.type, "text");
  assert.ok(result.content[0]?.type === "text" && result.content[0].text.split("\n").length <= 15);
  assert.doesNotMatch(serialized, /<!doctype html>/i);
  assert.match(await readFile(outputPath, "utf8"), /CodeGraph map/);
});

test("MCP tool definition exposes validated graph options", async () => {
  assert.equal(toolDefinition.name, "visualize_codegraph");
  assert.deepEqual(toolDefinition.inputSchema.properties.providers.items.enum, ["codex", "claude"]);
  await assert.rejects(() => runVisualizeTool({ projectPath: ".", outputPath: "map.txt" }), /\.html/);
});
