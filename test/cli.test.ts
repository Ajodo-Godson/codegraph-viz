import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createCodeGraphProject,
  insertFile,
  insertNode
} from "./fixtures.ts";

const execFileAsync = promisify(execFile);

test("--json writes only a normalized payload to stdout", async () => {
  const fixture = await createCodeGraphProject({
    populate(database) {
      insertFile(database, { path: "src/index.ts", nodeCount: 1 });
      insertNode(database, {
        id: "main",
        kind: "function",
        name: "main",
        filePath: "src/index.ts",
        startLine: 1
      });
    }
  });
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/codegraph-viz.ts", fixture.projectPath, "--json"],
    { cwd: process.cwd() }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.stats.fileCount, 1);
  assert.equal(payload.stats.symbolCount, 1);
  assert.equal(payload.symbols[0].id, "main");
  assert.doesNotMatch(stderr, /^Warning:/m);
});

test("--json remains parseable when --init creates the index", async () => {
  const fixture = await createCodeGraphProject({
    populate(database) {
      insertFile(database, { path: "src/index.ts", nodeCount: 1 });
      insertNode(database, { id: "main", kind: "function", name: "main", filePath: "src/index.ts" });
    }
  });
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-json-init-"));
  const projectPath = join(root, "project");
  const binDir = join(root, "bin");
  await mkdir(projectPath);
  await mkdir(binDir);
  const command = join(binDir, "codegraph");
  await writeFile(command, "#!/bin/sh\necho \"codegraph init progress\"\nmkdir -p \"$2/.codegraph\"\ncp \"$FIXTURE_DB\" \"$2/.codegraph/codegraph.db\"\n");
  await chmod(command, 0o755);

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/codegraph-viz.ts", projectPath, "--json", "--init"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FIXTURE_DB: join(fixture.projectPath, ".codegraph", "codegraph.db")
      }
    }
  );

  assert.equal(JSON.parse(stdout).stats.fileCount, 1);
  assert.match(stderr, /Initializing CodeGraph/);
  assert.match(stderr, /codegraph init progress/);
  assert.match(stderr, /CodeGraph index ready/);
});

test("--watch serves locally until terminated", { timeout: 15_000 }, async () => {
  const fixture = await createCodeGraphProject({ indexState: "indexing", populate(database) {
    insertFile(database, { path: "src/index.ts", nodeCount: 0 });
  } });
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-cli-watch-"));
  const outputPath = join(root, "map.html");
  const child = spawn(process.execPath, [
    "bin/codegraph-viz.ts", fixture.projectPath, "--watch", "--port", "0",
    "--no-agent-traces", "-o", outputPath
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolvePromise) => child.on("exit", resolvePromise));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const url = await new Promise<string>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for live URL. Output: ${stdout}`)), 10_000);
      child.stdout.on("data", () => {
        const match = stdout.match(/Live visualization: (http:\/\/127\.0\.0\.1:\d+\/)/);
        if (match?.[1]) { clearTimeout(timeout); resolvePromise(match[1]); }
      });
      child.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Watch process exited early with ${String(code)}.`)); });
    });
    assert.match(await fetch(url).then((response) => response.text()), /EventSource/);
    assert.match(stderr, /Warning: CodeGraph index_state is "indexing"/);
  } finally {
    child.kill("SIGTERM");
  }
  assert.equal(await exited, 0);
});
