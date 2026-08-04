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

test("retains changed-file evidence for recent commits after the working tree is clean", async () => {
  const path = await repository();
  git(path, "add", "--", "app.ts", "new.ts");
  git(path, "commit", "-m", "update application");

  const snapshot = inspectGit(path);
  assert.deepEqual(snapshot.changes, []);
  assert.equal(snapshot.recentCommits[0]?.subject, "update application");
  assert.deepEqual(snapshot.recentCommits[0]?.changes, [
    { path: "app.ts", additions: 1, deletions: 1 },
    { path: "new.ts", additions: 1, deletions: 0 }
  ]);
  assert.deepEqual(snapshot.recentCommits[1]?.changes, [
    { path: "app.ts", additions: 1, deletions: 0 }
  ]);
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
  assert.equal(app?.states.committed, false);
  assert.deepEqual(added?.agentIds, []);
  assert.deepEqual(added?.evidence, []);
});

test("correlates clean-tree paths with factual commit membership", async () => {
  const path = await repository();
  git(path, "add", "--", "app.ts", "new.ts");
  git(path, "commit", "-m", "commit agent work");
  const events = normalizeProvenance([
    { timestamp: "2026-08-04T12:00:00Z", runId: "run", id: "edit", agentId: "agent-a", kind: "file_edited", target: "app.ts" }
  ]);
  const app = correlateChanges(inspectGit(path), events, []).find((item) => item.path === "app.ts");
  assert.deepEqual(app?.agentIds, ["agent-a"]);
  assert.equal(app?.states.committed, true);
  assert.ok(app?.commitShas.length);
  assert.deepEqual(app?.evidence, ["explicit_event_target", "commit_membership"]);
});

test("applies explicit run-level delivery evidence to files authored in that run", async () => {
  const path = await repository();
  const events = normalizeProvenance([
    { timestamp: "2026-08-04T12:00:00Z", runId: "run-a", id: "edit", agentId: "agent-a", kind: "file_edited", target: "app.ts" },
    { timestamp: "2026-08-04T12:01:00Z", runId: "run-a", id: "test", agentId: "agent-a", kind: "test_run" },
    { timestamp: "2026-08-04T12:02:00Z", runId: "run-a", id: "review", agentId: "agent-a", kind: "review_received", target: { type: "pull_request", value: "12" } },
    { timestamp: "2026-08-04T12:03:00Z", runId: "run-b", id: "other-test", agentId: "agent-b", kind: "test_run" }
  ]);
  const app = correlateChanges(inspectGit(path), events, []).find((item) => item.path === "app.ts");
  assert.equal(app?.states.tested, true);
  assert.equal(app?.states.reviewed, true);
  assert.ok(app?.eventIds.includes("test"));
  assert.ok(!app?.eventIds.includes("other-test"));
});

test("preserves unusual and renamed paths with NUL-delimited Git output", async () => {
  const path = await repository();
  const unusual = 'odd -> "name".ts';
  await writeFile(join(path, unusual), "export const odd = 1;\n");
  git(path, "add", "--", unusual);
  git(path, "commit", "-m", "add unusual path");
  await writeFile(join(path, unusual), "export const odd = 2;\n");
  git(path, "mv", "--", "app.ts", "renamed app.ts");

  const snapshot = inspectGit(path);
  assert.deepEqual(snapshot.changes.map(({ path }) => path), ["new.ts", unusual, "renamed app.ts"]);
  assert.equal(snapshot.changes.find((change) => change.path === unusual)?.additions, 1);
  assert.equal(snapshot.changes.find((change) => change.path === "renamed app.ts")?.indexStatus, "R");
});

test("attributes committed rename statistics to the destination path", async () => {
  const path = await repository();
  git(path, "add", "--", "app.ts", "new.ts");
  git(path, "commit", "-m", "update application");
  git(path, "mv", "--", "app.ts", "renamed app.ts");
  git(path, "commit", "-m", "rename application");

  const [rename] = inspectGit(path).recentCommits;
  assert.deepEqual(rename?.changes, [{ path: "renamed app.ts", additions: 0, deletions: 0 }]);
});
