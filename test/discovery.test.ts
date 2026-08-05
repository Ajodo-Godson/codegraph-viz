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

test("adapts Codex agent reports and explicit delivery events without retaining message bodies", async () => {
  const project = await mkdtemp(join(tmpdir(), "codex-handoff-project-"));
  const records = [
    { type: "session_meta", timestamp: "2026-08-04T12:00:00Z", payload: { id: "run", cwd: project } },
    { type: "response_item", timestamp: "2026-08-04T12:01:00Z", payload: { type: "function_call", name: "spawn_agent", call_id: "spawn", arguments: JSON.stringify({ task_name: "audit", message: "PRIVATE TASK PROMPT" }) } },
    { type: "response_item", timestamp: "2026-08-04T12:01:01Z", payload: { type: "function_call_output", call_id: "spawn", output: JSON.stringify({ agent_id: "agent-42", nickname: "audit" }) } },
    { type: "response_item", timestamp: "2026-08-04T12:02:00Z", payload: { type: "agent_message", id: "report", author: "agent-42", recipient: "root", content: "PRIVATE PATCH AND COMPLETION REPORT" } },
    { type: "response_item", timestamp: "2026-08-04T12:03:00Z", payload: { type: "function_call", name: "send_message", call_id: "handoff", arguments: JSON.stringify({ target: "agent-42", message: "PRIVATE HANDOFF" }) } }
  ];
  const events = adaptCodexTrace(records, project, "codex:fixture");
  assert.deepEqual(events.map(({ kind }) => kind), ["run_started", "agent_spawned", "knowledge_reported", "knowledge_reported"]);
  assert.equal(events[1]?.agentId, "agent-42");
  assert.equal(events[2]?.agentId, "agent-42");
  assert.equal(events[2]?.parentAgentId, "root");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test("reconciles Codex short task names with canonical agent paths", async () => {
  const project = await mkdtemp(join(tmpdir(), "codex-agent-identity-"));
  const records = [
    { type: "session_meta", timestamp: "2026-08-04T12:00:00Z", payload: { id: "run", cwd: project } },
    { type: "response_item", timestamp: "2026-08-04T12:01:00Z", payload: { type: "function_call", name: "spawn_agent", call_id: "spawn", arguments: JSON.stringify({ task_name: "audit", message: "private" }) } },
    { type: "response_item", timestamp: "2026-08-04T12:02:00Z", payload: { type: "agent_message", id: "root-report", author: "/root", content: "private" } },
    { type: "response_item", timestamp: "2026-08-04T12:03:00Z", payload: { type: "agent_message", id: "child-report", author: "/root/audit", content: "private" } }
  ];
  const events = adaptCodexTrace(records, project, "codex:fixture");
  assert.deepEqual([...new Set(events.map(({ agentId }) => agentId))], ["root", "/root/audit"]);
  assert.equal(events.find(({ kind }) => kind === "agent_spawned")?.agentId, "/root/audit");
});

test("attributes subagent session file edits to the native agent path", async () => {
  const project = await mkdtemp(join(tmpdir(), "codex-subagent-session-"));
  const records = [
    { type: "session_meta", timestamp: "2026-08-04T12:00:00Z", payload: { id: "run", cwd: project, agent_path: "/root/audit" } },
    { type: "response_item", timestamp: "2026-08-04T12:01:00Z", payload: {
      type: "custom_tool_call", name: "exec", call_id: "edit", input: `await tools.apply_patch(\"*** Begin Patch\\n*** Update File: ${join(project, "src/audit.ts")}\\n*** End Patch\")`
    } }
  ];
  const events = adaptCodexTrace(records, project, "codex:fixture");
  assert.equal(events.find(({ kind }) => kind === "file_edited")?.agentId, "/root/audit");
  assert.equal(events.find(({ kind }) => kind === "file_edited")?.parentAgentId, "root");
});

test("adapts explicit Codex commit, pull request, and received-review tool evidence", async () => {
  const project = await mkdtemp(join(tmpdir(), "codex-delivery-project-"));
  const records = [
    { type: "session_meta", timestamp: "2026-08-04T12:00:00Z", payload: { id: "run", cwd: project } },
    { type: "response_item", timestamp: "2026-08-04T12:01:00Z", payload: { type: "function_call", name: "commit_created", call_id: "commit", arguments: JSON.stringify({ sha: "abc123", message: "PRIVATE COMMIT MESSAGE" }) } },
    { type: "response_item", timestamp: "2026-08-04T12:02:00Z", payload: { type: "function_call", name: "create_pull_request", call_id: "pr", arguments: JSON.stringify({ number: 17, title: "PRIVATE PR TITLE" }) } },
    { type: "response_item", timestamp: "2026-08-04T12:03:00Z", payload: { type: "function_call", name: "review_received", call_id: "review", arguments: JSON.stringify({ pull_number: 17, body: "PRIVATE REVIEW BODY" }) } }
  ];
  const events = adaptCodexTrace(records, project, "codex:fixture");
  assert.deepEqual(events.map(({ kind }) => kind), ["run_started", "commit_created", "pr_opened", "review_received"]);
  assert.equal(events[1]?.target?.value, "abc123");
  assert.equal(events[2]?.target?.value, "17");
  assert.equal(events[3]?.target?.value, "17");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test("adapts current Codex exec wrappers without retaining patch source", async () => {
  const project = await mkdtemp(join(tmpdir(), "codex-wrapper-project-"));
  const privateSource = "PRIVATE_SOURCE_VALUE";
  const records = [
    { type: "session_meta", timestamp: "2026-08-04T12:00:00Z", payload: { id: "run", cwd: project } },
    { type: "response_item", timestamp: "2026-08-04T12:01:00Z", payload: {
      type: "custom_tool_call", name: "exec", call_id: "edit", input: `await tools.apply_patch(\"*** Begin Patch\\n*** Update File: ${join(project, "src/app.ts")}\\n@@\\n-${privateSource}\\n*** End Patch\")`
    } },
    { type: "response_item", timestamp: "2026-08-04T12:02:00Z", payload: {
      type: "custom_tool_call", name: "exec", call_id: "command", input: "await tools.exec_command({cmd:\"npm test\"})"
    } }
  ];
  const events = adaptCodexTrace(records, project, "codex:fixture");
  assert.deepEqual(events.map(({ kind }) => kind), ["run_started", "file_edited", "test_run"]);
  assert.equal(events[1]?.target?.path, "src/app.ts");
  assert.doesNotMatch(JSON.stringify(events), new RegExp(privateSource));
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

test("adapts Claude agent completion and explicit delivery tools without retaining sensitive content", async () => {
  const project = await mkdtemp(join(tmpdir(), "claude-evidence-project-"));
  const records = [
    {
      type: "assistant", timestamp: "2026-08-04T12:00:00Z", sessionId: "run", cwd: project,
      message: { content: [
        { type: "tool_use", id: "agent", name: "Agent", input: { description: "Audit parser", prompt: "PRIVATE TASK PROMPT" } },
        { type: "tool_use", id: "commit", name: "commit_created", input: { sha: "def456", message: "PRIVATE COMMIT" } },
        { type: "tool_use", id: "pr", name: "create_pull_request", input: { pull_number: 23, body: "PRIVATE PR" } },
        { type: "tool_use", id: "review", name: "review_received", input: { pull_number: 23, body: "PRIVATE REVIEW" } }
      ] }
    },
    { type: "user", timestamp: "2026-08-04T12:01:00Z", sessionId: "run", cwd: project, toolUseResult: { agentId: "agent-9", status: "completed", prompt: "PRIVATE TASK PROMPT", content: "PRIVATE PATCH OUTPUT" }, message: { content: [{ type: "tool_result", tool_use_id: "agent", content: "PRIVATE COMPLETION REPORT" }] } }
  ];
  const events = adaptClaudeTrace(records, project, "claude:fixture");
  assert.deepEqual(events.map(({ kind }) => kind), ["run_started", "agent_spawned", "commit_created", "pr_opened", "review_received", "knowledge_reported", "run_finished"]);
  assert.equal(events[1]?.agentId, "agent-9");
  assert.equal(events[5]?.agentId, "agent-9");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
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

test("preserves normalized source order for discovered timestamp ties", async () => {
  const project = await mkdtemp(join(tmpdir(), "trace-order-project-"));
  const codexRoot = await mkdtemp(join(tmpdir(), "trace-order-codex-"));
  await writeFile(join(codexRoot, "one.jsonl"), [
    { type: "session_meta", timestamp: "2026-08-04T11:59:00Z", payload: { id: "run", cwd: project } },
    { type: "response_item", timestamp: "2026-08-04T12:00:00Z", payload: { type: "function_call", name: "exec_command", call_id: "z-first", arguments: JSON.stringify({ cmd: "npm test" }) } },
    { type: "response_item", timestamp: "2026-08-04T12:00:00Z", payload: { type: "function_call", name: "exec_command", call_id: "a-second", arguments: JSON.stringify({ cmd: "npm test" }) } }
  ].map((value) => JSON.stringify(value)).join("\n"));
  const result = await discoverAgentTraces({ projectPath: project, providers: ["codex"], roots: { codex: codexRoot } });
  assert.deepEqual(result.events.filter(({ kind }) => kind === "test_run").map(({ id }) => id), ["z-first", "a-second"]);
});

test("keeps reused native event ids across concurrent nested Codex runs", async () => {
  const project = await mkdtemp(join(tmpdir(), "trace-concurrent-project-"));
  const codexRoot = await mkdtemp(join(tmpdir(), "trace-concurrent-codex-"));
  const sessions = [
    { file: "parent.jsonl", run: "parent-run", agent: "/root/audit", path: "src/parent.ts" },
    { file: "child.jsonl", run: "child-run", agent: "/root/audit/deep", path: "src/child.ts" }
  ];
  for (const session of sessions) {
    await writeFile(join(codexRoot, session.file), [
      { type: "session_meta", timestamp: "2026-08-04T12:00:00Z", payload: { id: session.run, cwd: project, agent_path: session.agent } },
      { type: "response_item", timestamp: "2026-08-04T12:01:00Z", payload: {
        type: "custom_tool_call", name: "exec", call_id: "shared-edit-id",
        input: `await tools.apply_patch("*** Begin Patch\\n*** Update File: ${join(project, session.path)}\\n*** End Patch")`
      } }
    ].map((value) => JSON.stringify(value)).join("\n"));
  }
  const result = await discoverAgentTraces({ projectPath: project, providers: ["codex"], roots: { codex: codexRoot } });
  const edits = result.events.filter(({ kind }) => kind === "file_edited");
  assert.deepEqual(edits.map(({ runId, agentId, parentAgentId, target }) => ({ runId, agentId, parentAgentId, path: target?.path })), [
    { runId: "child-run", agentId: "/root/audit/deep", parentAgentId: "/root/audit", path: "src/child.ts" },
    { runId: "parent-run", agentId: "/root/audit", parentAgentId: "root", path: "src/parent.ts" }
  ]);
});

test("reports malformed, unsupported, and incomplete provider records", async () => {
  const project = await mkdtemp(join(tmpdir(), "trace-diagnostic-project-"));
  const claudeRoot = await mkdtemp(join(tmpdir(), "trace-diagnostic-claude-"));
  await writeFile(join(claudeRoot, "diagnostic.jsonl"), [
    JSON.stringify({ type: "assistant", timestamp: "2026-08-04T12:00:00Z", sessionId: "run", cwd: project, message: { content: [
      { type: "tool_use", id: "missing-path", name: "Edit", input: { new_string: "private" } },
      { type: "tool_use", id: "future-tool", name: "FutureTool", input: { secret: "private" } }
    ] } }),
    "{not-json"
  ].join("\n"));
  const result = await discoverAgentTraces({ projectPath: project, providers: ["claude"], roots: { claude: claudeRoot } });
  assert.deepEqual(result.diagnostics[0], {
    provider: "claude", filesScanned: 1, sessionsMatched: 1, eventsImported: 2, skippedFiles: 0,
    malformedRecords: 1, unsupportedRecords: 1, incompleteRecords: 1,
    warnings: ["diagnostic.jsonl: 1 malformed record, 1 unsupported tool record, 1 incomplete tool record"]
  });
  assert.doesNotMatch(JSON.stringify(result), /private|FutureTool/);
});
