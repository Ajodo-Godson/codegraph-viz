import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  await writeFile(command, "#!/bin/sh\nmkdir -p \"$2/.codegraph\"\ncp \"$FIXTURE_DB\" \"$2/.codegraph/codegraph.db\"\n");
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
  assert.match(stderr, /CodeGraph index ready/);
});
