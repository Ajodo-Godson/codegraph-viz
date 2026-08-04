import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { adaptClaudeTrace, adaptCodexTrace, discoverAgentTraces } from "../src/discovery.ts";

test("adapts native Codex records without importing prompts or output", async () => {
  const project = await mkdtemp(join(tmpdir(), "codex-project-"));
  const records = [
    { type: "session_meta", timestamp: "2026-08-04T12:00:00Z", payload: { id: "run", cwd: project } },
    { type: "response_item", timestamp: "2026-08-04T12:01:00Z", payload: { type: "function_call", name: "exec_command", call_id: "test", arguments: JSON.stringify({ cmd: "npm test", workdir: project }) } },
    { type: "response_item", timestamp: "2026-08-04T12:02:00Z", payload: { type: "message", content: "private prompt" } },
    { type: "event_msg", timestamp: "2026-08-04T12:03:00Z", payload: { type: "task_complete", last_agent_message: "private output" } }
  ];
  const events = adaptCodexTrace(records, project, "codex:fixture");
  assert.deepEqual(events.map(({ kind }) => kind), ["run_started", "test_run", "run_finished"]);
  assert.doesNotMatch(JSON.stringify(events), /private/);
});

test("adapts Claude tool use and ignores sessions for other projects", async () => {
  const project = await mkdtemp(join(tmpdir(), "claude-project-"));
  const records = [{
    type: "assistant", timestamp: "2026-08-04T12:00:00Z", sessionId: "run", cwd: project,
    message: { content: [
      { type: "tool_use", id: "read", name: "Read", input: { file_path: join(project, "src/app.ts") } },
      { type: "tool_use", id: "edit", name: "Edit", input: { file_path: join(project, "src/app.ts"), new_string: "private source" } },
      { type: "tool_use", id: "agent", name: "Agent", input: { description: "Inspect parser", prompt: "private prompt" } }
    ] }
  }];
  assert.deepEqual(adaptClaudeTrace(records, project, "claude:fixture").map(({ kind }) => kind), ["run_started", "file_read", "file_edited", "agent_spawned", "run_finished"]);
  assert.equal(adaptClaudeTrace(records, join(project, "other"), "claude:fixture").length, 0);
});

test("discovers matching provider sessions and reports diagnostics", async () => {
  const project = await mkdtemp(join(tmpdir(), "trace-project-"));
  const codexRoot = await mkdtemp(join(tmpdir(), "codex-traces-"));
  const claudeRoot = await mkdtemp(join(tmpdir(), "claude-traces-"));
  await mkdir(join(project, "src"));
  await writeFile(join(codexRoot, "one.jsonl"), [
    { type: "session_meta", timestamp: "2026-08-04T12:00:00Z", payload: { id: "codex-run", cwd: project } },
    { type: "response_item", timestamp: "2026-08-04T12:01:00Z", payload: { type: "function_call", name: "view_image", call_id: "read", arguments: JSON.stringify({ path: join(project, "src/image.png") }) } }
  ].map((value) => JSON.stringify(value)).join("\n"));
  await writeFile(join(claudeRoot, "one.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-08-04T12:00:00Z", sessionId: "claude-run", cwd: "/other", message: { content: [] } }));
  const result = await discoverAgentTraces({ projectPath: project, roots: { codex: codexRoot, claude: claudeRoot } });
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.diagnostics.map(({ sessionsMatched }) => sessionsMatched), [1, 0]);
});
