import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  createCodeGraphProject,
  insertFile,
  insertNode
} from "./fixtures.js";

const execFileAsync = promisify(execFile);

test("--json writes only a normalized payload to stdout", async () => {
  const fixture = await createCodeGraphProject({
    populate(database) {
      insertFile(database, { path: "src/index.js", nodeCount: 1 });
      insertNode(database, {
        id: "main",
        kind: "function",
        name: "main",
        filePath: "src/index.js",
        startLine: 1
      });
    }
  });
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/codegraph-viz.js", fixture.projectPath, "--json"],
    { cwd: process.cwd() }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.stats.fileCount, 1);
  assert.equal(payload.stats.symbolCount, 1);
  assert.equal(payload.symbols[0].id, "main");
  assert.doesNotMatch(stderr, /^Warning:/m);
});
