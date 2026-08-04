import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendProvenanceEvents, normalizeProvenance, readProvenanceFile } from "../src/provenance.ts";

test("normalizes provider events and preserves parent-child provenance", () => {
  const events = normalizeProvenance({ provider: "codex", events: [{
    timestamp: "2026-08-04T12:00:00Z", runId: "run-1", agentId: "child",
    parentAgentId: "root", taskId: "task-1", type: "edit",
    target: { type: "file", path: "src/app.ts", startLine: 4 }, summary: "Updated parser"
  }] });
  assert.deepEqual(events[0], {
    id: "codex:run-1:0", timestamp: "2026-08-04T12:00:00.000Z", provider: "codex",
    runId: "run-1", agentId: "child", parentAgentId: "root", taskId: "task-1",
    kind: "file_edited", knownKind: true,
    target: { type: "file", path: "src/app.ts", startLine: 4 },
    summary: "Updated parser", sourceRef: "inline", metadata: {}
  });
});

test("retains unknown kinds and redacts secrets", () => {
  const [event] = normalizeProvenance([{
    timestamp: "2026-08-04T12:00:00Z", runId: "run", kind: "provider.new_event",
    summary: "used sk-abcdefghijk", metadata: { token: "visible", nested: { password: "bad" } }
  }]);
  assert.equal(event?.kind, "provider_new_event");
  assert.equal(event?.knownKind, false);
  assert.equal(event?.summary, "used [REDACTED]");
  assert.deepEqual(event?.metadata, { token: "[REDACTED]", nested: { password: "[REDACTED]" } });
});

test("preserves per-event providers in arrays and redacts free-form targets", () => {
  const events = normalizeProvenance([
    {
      timestamp: "2026-08-04T12:00:00Z", runId: "run", provider: "codex",
      kind: "file_read", target: { type: "command", value: "curl -H 'Authorization: Bearer abcdefghijk'" }
    },
    {
      timestamp: "2026-08-04T12:01:00Z", runId: "run", provider: "claude",
      kind: "knowledge_reported", target: { type: "other", value: "used sk-abcdefghijk" }
    }
  ]);

  assert.deepEqual(events.map(({ provider }) => provider), ["codex", "claude"]);
  assert.equal(events[0]?.target?.value, "curl -H 'Authorization: [REDACTED]'");
  assert.equal(events[1]?.target?.value, "used [REDACTED]");
});

test("orders timestamp ties deterministically without reordering events inside a run", () => {
  const events = normalizeProvenance([
    { id: "second-in-run", timestamp: "2026-08-04T12:00:00Z", runId: "run-b", kind: "file_read" },
    { id: "first-in-run", timestamp: "2026-08-04T12:00:00Z", runId: "run-b", kind: "file_edited" },
    { id: "other-run", timestamp: "2026-08-04T12:00:00Z", runId: "run-a", kind: "file_read" },
    { id: "finish", timestamp: "2026-08-04T12:00:00Z", runId: "run-a", kind: "run_finished" },
    { id: "start", timestamp: "2026-08-04T12:00:00Z", runId: "run-b", kind: "run_started" }
  ]);
  assert.deepEqual(events.map(({ id }) => id), ["start", "other-run", "second-in-run", "first-in-run", "finish"]);
});

test("rejects absolute targets and invalid timestamps", () => {
  assert.throws(() => normalizeProvenance([{ timestamp: "bad", runId: "run" }]), /valid timestamp/);
  assert.throws(() => normalizeProvenance([{ timestamp: "2026-08-04T12:00:00Z", runId: "run", target: "/secret" }]), /repository-relative/);
});

test("appends and imports JSONL without rewriting prior events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provenance-"));
  const path = join(directory, "events.jsonl");
  const first = normalizeProvenance([{ timestamp: "2026-08-04T12:00:00Z", runId: "run", kind: "run_started" }]);
  const second = normalizeProvenance([{ timestamp: "2026-08-04T12:01:00Z", runId: "run", kind: "run_finished" }]);
  await appendProvenanceEvents(path, first);
  const original = await readFile(path, "utf8");
  await appendProvenanceEvents(path, second);
  assert.ok((await readFile(path, "utf8")).startsWith(original));
  assert.equal((await readProvenanceFile(path)).length, 2);
});
