import assert from "node:assert/strict";
import test from "node:test";

import { correlateChanges, deduplicateCorrelationEvents } from "../src/correlate.ts";
import { normalizeProvenance } from "../src/provenance.ts";
import type { GitSnapshot } from "../src/types.ts";

const snapshot: GitSnapshot = {
  root: "/repo",
  branch: "main",
  head: "abc123",
  changes: [
    { path: "a.ts", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, additions: 1, deletions: 0 },
    { path: "b.ts", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, additions: 1, deletions: 0 }
  ],
  recentCommits: []
};

function events(values: Record<string, unknown>[]) {
  return normalizeProvenance(values.map((value, index) => ({
    timestamp: `2026-08-04T12:00:${String(index).padStart(2, "0")}Z`,
    runId: "run",
    ...value
  })));
}

test("scopes untargeted run evidence to the authoring agent", () => {
  const correlated = correlateChanges(snapshot, events([
    { id: "edit-a", agentId: "agent-a", kind: "file_edited", target: "a.ts" },
    { id: "edit-b", agentId: "agent-b", kind: "file_edited", target: "b.ts" },
    { id: "test-a", agentId: "agent-a", kind: "test_run" },
    { id: "pr-b", agentId: "agent-b", kind: "pr_opened" }
  ]), []);

  const a = correlated.find((item) => item.path === "a.ts")!;
  const b = correlated.find((item) => item.path === "b.ts")!;
  assert.equal(a.states.tested, true);
  assert.equal(a.states.prOpened, false);
  assert.equal(b.states.tested, false);
  assert.equal(b.states.prOpened, true);
});

test("scopes untargeted evidence to a task when both events identify one", () => {
  const correlated = correlateChanges(snapshot, events([
    { id: "edit-a", agentId: "agent", taskId: "task-a", kind: "file_edited", target: "a.ts" },
    { id: "edit-b", agentId: "agent", taskId: "task-b", kind: "file_edited", target: "b.ts" },
    { id: "review-a", agentId: "agent", taskId: "task-a", kind: "review_received" }
  ]), []);

  assert.equal(correlated.find((item) => item.path === "a.ts")?.states.reviewed, true);
  assert.equal(correlated.find((item) => item.path === "b.ts")?.states.reviewed, false);
});

test("retains explicitly targeted evidence independent of its actor", () => {
  const correlated = correlateChanges(snapshot, events([
    { id: "edit", agentId: "author", taskId: "implementation", kind: "file_edited", target: "a.ts" },
    { id: "review", agentId: "reviewer", taskId: "review", kind: "review_received", target: "a.ts" }
  ]), []);

  const a = correlated.find((item) => item.path === "a.ts")!;
  assert.equal(a.states.reviewed, true);
  assert.deepEqual(a.agentIds, ["author"]);
  assert.deepEqual(a.eventIds, ["edit", "review"]);
});

test("deduplicates equivalent provider events deterministically", () => {
  const duplicates = normalizeProvenance([
    { id: "z-copy", timestamp: "2026-08-04T12:00:00Z", provider: "codex", runId: "run", agentId: "agent", kind: "file_edited", target: "a.ts", sourceRef: "copy.jsonl" },
    { id: "a-original", timestamp: "2026-08-04T12:00:00Z", provider: "codex", runId: "run", agentId: "agent", kind: "file_edited", target: "a.ts", sourceRef: "original.jsonl" }
  ]);

  assert.deepEqual(deduplicateCorrelationEvents(duplicates).map((event) => event.id), ["a-original"]);
  assert.deepEqual(deduplicateCorrelationEvents([...duplicates].reverse()).map((event) => event.id), ["a-original"]);
  assert.deepEqual(correlateChanges(snapshot, duplicates, [])[0]?.eventIds, ["a-original"]);
});
