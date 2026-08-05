import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureCodeGraphIndex, hasCodeGraphIndex } from "../src/setup.ts";

test("detects an existing CodeGraph index without initializing", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "codegraph-viz-index-"));
  await mkdir(join(projectPath, ".codegraph"));
  await writeFile(join(projectPath, ".codegraph", "codegraph.db"), "fixture");
  let calls = 0;

  assert.equal(hasCodeGraphIndex(projectPath), true);
  assert.equal(await ensureCodeGraphIndex(projectPath, async () => { calls += 1; }), "existing");
  assert.equal(calls, 0);
});

test("treats a missing or non-file database path as no index", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "codegraph-viz-missing-index-"));
  assert.equal(hasCodeGraphIndex(projectPath), false);
  await mkdir(join(projectPath, ".codegraph", "codegraph.db"), { recursive: true });
  assert.equal(hasCodeGraphIndex(projectPath), false);
});

test("runs CodeGraph initialization and waits for its database", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "codegraph-viz-init-"));
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = await ensureCodeGraphIndex(projectPath, async (command, args) => {
    calls.push({ command, args });
    await mkdir(join(projectPath, ".codegraph"));
    await writeFile(join(projectPath, ".codegraph", "codegraph.db"), "fixture");
  });

  assert.equal(result, "initialized");
  assert.deepEqual(calls, [{ command: "codegraph", args: ["init", projectPath] }]);
});

test("reports when CodeGraph finishes without creating an index", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "codegraph-viz-no-index-"));
  await assert.rejects(
    ensureCodeGraphIndex(projectPath, async () => {}, { timeoutMs: 10, pollMs: 1 }),
    /did not create an index/
  );
});
