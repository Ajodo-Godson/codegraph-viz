import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createCodeGraphProject, insertFile, insertNode } from "./fixtures.ts";

const execute = promisify(execFile);

test("packed installation exposes working CLI and MCP stdio binaries", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codegraph-package-"));
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  let client: Client | undefined;
  try {
    const packed = await execute("npm", ["pack", "--json", "--pack-destination", directory], { cwd: new URL("..", import.meta.url) });
    const manifest = JSON.parse(packed.stdout)[0];
    const paths = manifest.files.map((file: { path: string }) => file.path);
    assert.ok(paths.includes("dist/bin/codegraph-viz.js"));
    assert.ok(paths.includes("dist/bin/codegraph-viz-mcp.js"));
    assert.ok(paths.includes("dist/src/template.html"));
    assert.ok(paths.every((path: string) => !path.endsWith(".ts") || path.endsWith(".d.ts")));
    assert.ok(paths.includes("LICENSE"));
    assert.ok(paths.every((path: string) => !path.startsWith("test/") && !path.startsWith(".github/")));

    const tarball = join(directory, manifest.filename);
    await execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumer });
    const bin = join(consumer, "node_modules", ".bin");
    const cli = await execute(join(bin, "codegraph-viz"), ["--version"]);
    assert.equal(cli.stdout.trim(), "1.0.0");

    const fixture = await createCodeGraphProject({ populate(database) {
      insertFile(database, { path: "src/index.ts", nodeCount: 1 });
      insertNode(database, { id: "main", kind: "function", name: "main", filePath: "src/index.ts" });
    } });
    const cliOutputPath = join(directory, "cli-map.html");
    const generated = await execute(join(bin, "codegraph-viz"), [fixture.projectPath, "-o", cliOutputPath, "--no-agent-traces"]);
    assert.match(generated.stdout, /1 files, 1 symbols/);
    assert.match(await readFile(cliOutputPath, "utf8"), /CodeGraph map/);

    const outputPath = join(directory, "mcp-map.html");
    const transport = new StdioClientTransport({ command: join(bin, "codegraph-viz-mcp"), stderr: "pipe" });
    client = new Client({ name: "package-verification", version: "1.0.0" });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ["visualize_codegraph"]);
    const result = await client.callTool({
      name: "visualize_codegraph",
      arguments: { projectPath: fixture.projectPath, outputPath, autoAgentTraces: false }
    });
    assert.equal(result.isError, undefined);
    assert.match(await readFile(outputPath, "utf8"), /CodeGraph map/);
    assert.doesNotMatch(JSON.stringify(result), /<!doctype html>/i);
  } finally {
    await client?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
