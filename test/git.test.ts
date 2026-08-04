import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { correlateChanges } from "../src/correlate.ts";
import { inspectGit } from "../src/git.ts";
import { normalizeProvenance } from "../src/provenance.ts";
import type { GraphSymbol } from "../src/types.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function repository() {
  const path = await mkdtemp(join(tmpdir(), "codegraph-git-"));
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Fixture User");
  git(path, "config", "user.email", "fixture@example.com");
  await writeFile(join(path, "app.ts"), "export const value = 1;\n");
  git(path, "add", "--", "app.ts");
  git(path, "commit", "-m", "initial");
  await writeFile(join(path, "app.ts"), "export const value = 2;\n");
  await writeFile(join(path, "new.ts"), "export const added = true;\n");
  return path;
}

test("inspects working tree and commits without changing Git state", async () => {
  const path = await repository();
  const before = execFileSync("git", ["status", "--porcelain=v1"], { cwd: path, encoding: "utf8" });
  const snapshot = inspectGit(path);
  const after = execFileSync("git", ["status", "--porcelain=v1"], { cwd: path, encoding: "utf8" });
  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.recentCommits.length, 1);
  assert.deepEqual(snapshot.changes.map(({ path }) => path), ["app.ts", "new.ts"]);
  assert.equal(snapshot.changes[0]?.additions, 1);
  assert.equal(before, after);
});

test("attributes changes only from explicit evidence and detects overlaps", async () => {
  const path = await repository();
  const events = normalizeProvenance([
    { timestamp: "2026-08-04T12:00:00Z", runId: "run", id: "read", agentId: "reader", kind: "file_read", target: "app.ts" },
    { timestamp: "2026-08-04T12:01:00Z", runId: "run", id: "edit-a", agentId: "agent-a", kind: "file_edited", target: { path: "app.ts", startLine: 1 } },
    { timestamp: "2026-08-04T12:02:00Z", runId: "run", id: "edit-b", agentId: "agent-b", kind: "edit_proposed", target: "app.ts" },
    { timestamp: "2026-08-04T12:03:00Z", runId: "run", id: "unrelated", agentId: "agent-c", kind: "file_edited", target: "other.ts" }
  ]);
  const symbols: GraphSymbol[] = [{
    id: "value", kind: "constant", name: "value", qualifiedName: "value", filePath: "app.ts",
    startLine: 1, endLine: 1, signature: null, degree: 0, callers: [], callees: [], callerCount: 0, calleeCount: 0
  }];
  const correlations = correlateChanges(inspectGit(path), events, symbols);
  const app = correlations.find((item) => item.path === "app.ts");
  const added = correlations.find((item) => item.path === "new.ts");
  assert.deepEqual(app?.agentIds, ["agent-a", "agent-b"]);
  assert.equal(app?.overlappingAgents, true);
  assert.deepEqual(app?.symbolIds, ["value"]);
  assert.deepEqual(added?.agentIds, []);
  assert.deepEqual(added?.evidence, []);
});
