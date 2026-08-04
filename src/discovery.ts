import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { normalizeProvenance } from "./provenance.ts";
import type {
  ProvenanceEvent, TraceDiscoveryDiagnostic, TraceProvider
} from "./types.ts";

const MAX_TRACE_BYTES = 50 * 1024 * 1024;
const MAX_SUMMARY_LENGTH = 500;

type JsonRecord = Record<string, unknown>;

export interface DiscoverTraceOptions {
  projectPath: string;
  providers?: TraceProvider[];
  roots?: Partial<Record<TraceProvider, string>>;
}

export interface TraceDiscoveryResult {
  events: ProvenanceEvent[];
  diagnostics: TraceDiscoveryDiagnostic[];
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseLines(content: string): JsonRecord[] {
  return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [record(JSON.parse(line))]; } catch { return []; }
  });
}

function safeSummary(value: unknown): string | null {
  const valueText = text(value);
  return valueText ? valueText.slice(0, MAX_SUMMARY_LENGTH) : null;
}

function projectRelative(path: unknown, projectPath: string): string | null {
  const value = text(path);
  if (!value) return null;
  const absolute = isAbsolute(value) ? resolve(value) : resolve(projectPath, value);
  const result = relative(projectPath, absolute);
  if (!result || result.startsWith("..") || isAbsolute(result)) return null;
  return result.split(sep).join("/");
}

function cwdMatches(value: unknown, projectPath: string): boolean {
  const cwd = text(value);
  if (!cwd) return false;
  const resolved = resolve(cwd);
  return resolved === projectPath || resolved.startsWith(`${projectPath}${sep}`);
}

function commandKind(command: string): string {
  return /(^|\s)(npm|pnpm|yarn|bun)?\s*(run\s+)?(test|check)|\b(pytest|cargo test|go test|node --test|playwright test)\b/i.test(command)
    ? "test_run"
    : "command_run";
}

function rawEvent(base: JsonRecord, data: JsonRecord): JsonRecord {
  return { ...base, ...data };
}

function parseArguments(value: unknown): JsonRecord {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}

export function adaptCodexTrace(records: JsonRecord[], projectPath: string, sourceRef: string): ProvenanceEvent[] {
  const meta = records.find((item) => item.type === "session_meta");
  const metaPayload = record(meta?.payload);
  const contexts = records.filter((item) => item.type === "turn_context").map((item) => record(item.payload));
  if (![metaPayload, ...contexts].some((item) => cwdMatches(item.cwd, projectPath))) return [];
  const runId = text(metaPayload.id) ?? `codex:${sourceRef}`;
  const startedAt = text(meta?.timestamp) ?? text(metaPayload.timestamp);
  const raw: JsonRecord[] = [];
  if (startedAt) raw.push(rawEvent({}, { id: `${runId}:start`, timestamp: startedAt, runId, agentId: "root", kind: "run_started", summary: "Codex session started" }));

  for (const item of records) {
    if (item.type !== "response_item") continue;
    const payload = record(item.payload);
    if (payload.type !== "function_call") continue;
    const name = text(payload.name) ?? "unknown";
    const args = parseArguments(payload.arguments);
    const timestamp = text(item.timestamp);
    if (!timestamp) continue;
    const id = text(payload.call_id) ?? `${runId}:${raw.length}`;
    if (["exec_command", "shell_command"].includes(name)) {
      const command = text(args.cmd) ?? text(args.command);
      if (command) raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: commandKind(command), target: { type: "command", value: command.slice(0, 500) }, summary: "Executed a repository command" }));
    } else if (name === "view_image") {
      const path = projectRelative(args.path, projectPath);
      if (path) raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: "file_read", target: { type: "file", path }, summary: "Inspected an image" }));
    } else if (name === "spawn_agent") {
      const agentId = text(args.task_name) ?? `agent:${id}`;
      raw.push(rawEvent({}, { id, timestamp, runId, agentId, parentAgentId: "root", taskId: text(args.task_name), kind: "agent_spawned", target: { type: "task", value: safeSummary(args.message) }, summary: safeSummary(args.message) }));
    } else if (name === "send_message") {
      raw.push(rawEvent({}, { id, timestamp, runId, agentId: text(args.target) ?? "root", parentAgentId: "root", kind: "knowledge_reported", summary: safeSummary(args.message) }));
    }
  }
  const completed = [...records].reverse().find((item) => item.type === "event_msg" && record(item.payload).type === "task_complete");
  if (completed?.timestamp) raw.push(rawEvent({}, { id: `${runId}:finish`, timestamp: completed.timestamp, runId, agentId: "root", kind: "run_finished", summary: "Codex session completed" }));
  return normalizeProvenance(raw, { provider: "codex", sourceRef });
}

export function adaptClaudeTrace(records: JsonRecord[], projectPath: string, sourceRef: string): ProvenanceEvent[] {
  const matching = records.filter((item) => cwdMatches(item.cwd, projectPath));
  if (matching.length === 0) return [];
  const runId = text(matching[0]?.sessionId) ?? `claude:${sourceRef}`;
  const raw: JsonRecord[] = [];
  const firstTimestamp = matching.map((item) => text(item.timestamp)).find(Boolean);
  if (firstTimestamp) raw.push(rawEvent({}, { id: `${runId}:start`, timestamp: firstTimestamp, runId, agentId: "root", kind: "run_started", summary: "Claude session started" }));

  for (const item of matching) {
    if (item.type !== "assistant") continue;
    const message = record(item.message);
    if (!Array.isArray(message.content)) continue;
    for (const blockValue of message.content) {
      const block = record(blockValue);
      if (block.type !== "tool_use") continue;
      const name = text(block.name) ?? "unknown";
      const input = record(block.input);
      const timestamp = text(item.timestamp);
      if (!timestamp) continue;
      const id = text(block.id) ?? `${runId}:${raw.length}`;
      const filePath = projectRelative(input.file_path, projectPath);
      if (name === "Read" && filePath) raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: "file_read", target: { type: "file", path: filePath }, summary: "Read a repository file" }));
      else if (["Edit", "Write"].includes(name) && filePath) raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: "file_edited", target: { type: "file", path: filePath }, summary: `${name === "Edit" ? "Edited" : "Wrote"} a repository file` }));
      else if (name === "Bash" && text(input.command)) {
        const command = text(input.command)!;
        raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: commandKind(command), target: { type: "command", value: command.slice(0, 500) }, summary: "Executed a repository command" }));
      } else if (name === "Agent") {
        const agentId = `agent:${id}`;
        raw.push(rawEvent({}, { id, timestamp, runId, agentId, parentAgentId: "root", taskId: text(input.description), kind: "agent_spawned", target: { type: "task", value: safeSummary(input.description) }, summary: safeSummary(input.description) }));
      } else if (name === "SendMessage") {
        raw.push(rawEvent({}, { id, timestamp, runId, agentId: text(input.recipient) ?? text(input.to) ?? "root", parentAgentId: "root", kind: "knowledge_reported", summary: safeSummary(input.summary) ?? "Agent message sent" }));
      }
    }
  }
  const lastTimestamp = [...matching].reverse().map((item) => text(item.timestamp)).find(Boolean);
  if (lastTimestamp) raw.push(rawEvent({}, { id: `${runId}:finish`, timestamp: lastTimestamp, runId, agentId: "root", kind: "run_finished", summary: "Claude session ended" }));
  return normalizeProvenance(raw, { provider: "claude", sourceRef });
}

async function traceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 7) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.name.endsWith(".jsonl")) result.push(path);
    }
  }
  await walk(root, 0);
  return result.sort();
}

export async function discoverAgentTraces(options: DiscoverTraceOptions): Promise<TraceDiscoveryResult> {
  const projectPath = resolve(options.projectPath);
  const providers = options.providers?.length ? [...new Set(options.providers)] : ["codex", "claude"] as TraceProvider[];
  const defaults: Record<TraceProvider, string> = {
    codex: process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "sessions") : join(homedir(), ".codex", "sessions"),
    claude: process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "projects") : join(homedir(), ".claude", "projects")
  };
  const diagnostics: TraceDiscoveryDiagnostic[] = [];
  const allEvents: ProvenanceEvent[] = [];

  for (const provider of providers) {
    const root = options.roots?.[provider] ?? defaults[provider];
    const files = await traceFiles(root);
    const diagnostic: TraceDiscoveryDiagnostic = { provider, filesScanned: files.length, sessionsMatched: 0, eventsImported: 0, skippedFiles: 0, warnings: [] };
    for (const path of files) {
      try {
        const info = await stat(path);
        if (info.size > MAX_TRACE_BYTES) { diagnostic.skippedFiles += 1; diagnostic.warnings.push(`Skipped oversized trace ${basename(path)}`); continue; }
        const records = parseLines(await readFile(path, "utf8"));
        const sourceRef = `${provider}:${basename(path)}`;
        const events = provider === "codex" ? adaptCodexTrace(records, projectPath, sourceRef) : adaptClaudeTrace(records, projectPath, sourceRef);
        if (events.length) { diagnostic.sessionsMatched += 1; diagnostic.eventsImported += events.length; allEvents.push(...events); }
      } catch (error) {
        diagnostic.skippedFiles += 1;
        diagnostic.warnings.push(`Skipped ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    diagnostics.push(diagnostic);
  }
  const deduplicated = [...new Map(allEvents.map((event) => [`${event.provider}\0${event.id}`, event])).values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
  return { events: deduplicated, diagnostics };
}
