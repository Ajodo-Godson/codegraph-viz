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

function parseLines(content: string): { records: JsonRecord[]; malformed: number } {
  const records: JsonRecord[] = [];
  let malformed = 0;
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) malformed += 1;
      else records.push(parsed as JsonRecord);
    } catch { malformed += 1; }
  }
  return { records, malformed };
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

function traceMatches(provider: TraceProvider, records: JsonRecord[], projectPath: string): boolean {
  if (provider === "claude") return records.some((item) => cwdMatches(item.cwd, projectPath));
  return records.some((item) => {
    if (item.type !== "session_meta" && item.type !== "turn_context") return false;
    return cwdMatches(record(item.payload).cwd, projectPath);
  });
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

function identifier(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
}

function deliveryEvent(name: string, input: JsonRecord, base: JsonRecord): JsonRecord | null {
  const normalized = name.toLowerCase();
  if (["commit_created", "create_commit"].some((value) => normalized === value || normalized.endsWith(`__${value}`))) {
    const sha = identifier(input.sha) ?? identifier(input.commit_sha) ?? identifier(input.oid);
    return rawEvent(base, { kind: "commit_created", target: sha ? { type: "commit", value: sha } : null, summary: "Commit creation recorded by agent tool" });
  }
  if (["pr_opened", "create_pull_request", "pull_request_opened"].some((value) => normalized === value || normalized.endsWith(`__${value}`))) {
    const number = identifier(input.pull_number) ?? identifier(input.number) ?? identifier(input.pr_number);
    return rawEvent(base, { kind: "pr_opened", target: { type: "pull_request", ...(number ? { value: number } : {}) }, summary: "Pull request creation recorded by agent tool" });
  }
  if (["review_received", "pull_request_review_received"].some((value) => normalized === value || normalized.endsWith(`__${value}`))) {
    const number = identifier(input.pull_number) ?? identifier(input.number) ?? identifier(input.pr_number);
    return rawEvent(base, { kind: "review_received", target: { type: "pull_request", ...(number ? { value: number } : {}) }, summary: "Received review recorded by agent tool" });
  }
  return null;
}

function deliveryTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return [
    "commit_created", "create_commit", "pr_opened", "create_pull_request",
    "pull_request_opened", "review_received", "pull_request_review_received"
  ].some((value) => normalized === value || normalized.endsWith(`__${value}`));
}

function traceQuality(provider: TraceProvider, records: JsonRecord[], projectPath: string): { unsupported: number; incomplete: number } {
  let unsupported = 0;
  let incomplete = 0;
  if (provider === "codex") {
    for (const item of records.filter((entry) => entry.type === "response_item")) {
      const payload = record(item.payload);
      if (payload.type === "custom_tool_call") {
        const input = text(payload.input);
        if (payload.name !== "exec") unsupported += 1;
        else if (!input) incomplete += 1;
        else if (!["apply_patch", "exec_command", "view_image"].some((name) => input.includes(name))) unsupported += 1;
        continue;
      }
      if (payload.type !== "function_call") continue;
      const name = text(payload.name) ?? "";
      const input = parseArguments(payload.arguments);
      if (deliveryTool(name)) continue;
      if (["exec_command", "shell_command"].includes(name)) { if (!text(input.cmd) && !text(input.command)) incomplete += 1; }
      else if (name === "view_image") { if (!projectRelative(input.path, projectPath)) incomplete += 1; }
      else if (name === "spawn_agent") { if (!text(input.task_name)) incomplete += 1; }
      else if (name === "send_message") { if (!text(input.target)) incomplete += 1; }
      else unsupported += 1;
    }
    return { unsupported, incomplete };
  }
  for (const item of records.filter((entry) => cwdMatches(entry.cwd, projectPath) && entry.type === "assistant")) {
    const content = record(item.message).content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      const block = record(value);
      if (block.type !== "tool_use") continue;
      const name = text(block.name) ?? "";
      const input = record(block.input);
      if (deliveryTool(name) || name === "Agent") continue;
      if (["Read", "Edit", "Write"].includes(name)) { if (!projectRelative(input.file_path, projectPath)) incomplete += 1; }
      else if (name === "Bash") { if (!text(input.command)) incomplete += 1; }
      else if (name === "SendMessage") { if (!text(input.recipient) && !text(input.to)) incomplete += 1; }
      else unsupported += 1;
    }
  }
  return { unsupported, incomplete };
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function codexWrapperEvents(payload: JsonRecord, timestamp: string, runId: string, projectPath: string): JsonRecord[] {
  const input = text(payload.input);
  if (payload.name !== "exec" || !input) return [];
  const id = text(payload.call_id) ?? text(payload.id) ?? `${runId}:wrapper`;
  if (input.includes("apply_patch")) {
    const paths = [...input.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\\\n\r"]+)/g)]
      .map((match) => projectRelative(match[1], projectPath)).filter((path): path is string => Boolean(path));
    return [...new Set(paths)].map((path, index) => rawEvent({}, {
      id: `${id}:${index}`, timestamp, runId, agentId: "root", kind: "file_edited",
      target: { type: "file", path }, summary: "Edited a repository file"
    }));
  }
  if (input.includes("exec_command")) {
    const kind = commandKind(input);
    return [rawEvent({}, { id, timestamp, runId, agentId: "root", kind, summary: kind === "test_run" ? "Ran repository tests" : "Executed a repository command" })];
  }
  if (input.includes("view_image")) return [rawEvent({}, { id, timestamp, runId, agentId: "root", kind: "file_read", summary: "Inspected a repository image" })];
  return [];
}

function reconcileCodexAgentIds(events: JsonRecord[]): JsonRecord[] {
  const candidates = new Map<string, Set<string>>();
  for (const event of events) {
    const agentId = text(event.agentId);
    if (!agentId?.startsWith("/root/")) continue;
    const short = agentId.slice(agentId.lastIndexOf("/") + 1);
    const values = candidates.get(short) ?? new Set<string>();
    values.add(agentId);
    candidates.set(short, values);
  }
  const canonical = new Map([...candidates].flatMap(([short, values]) => values.size === 1 ? [[short, [...values][0]!] as const] : []));
  const normalize = (value: unknown): unknown => {
    const agentId = text(value);
    if (agentId === "/root") return "root";
    return agentId ? canonical.get(agentId) ?? agentId : value;
  };
  return events.map((event) => {
    const taskId = text(event.taskId);
    const spawnedCanonical = event.kind === "agent_spawned" && taskId ? canonical.get(taskId) : null;
    return {
      ...event,
      agentId: spawnedCanonical ?? normalize(event.agentId),
      parentAgentId: normalize(event.parentAgentId)
    };
  });
}

function applyCodexSessionIdentity(events: JsonRecord[], agentPath: string | null): JsonRecord[] {
  if (!agentPath || agentPath === "root" || agentPath === "/root") return events;
  const separator = agentPath.lastIndexOf("/");
  const parentAgentId = separator <= 0 ? "root" : agentPath.slice(0, separator) || "root";
  return events.map((event) => {
    const ownedBySession = event.agentId === "root";
    return {
      ...event,
      agentId: ownedBySession ? agentPath : event.agentId,
      parentAgentId: ownedBySession
        ? event.parentAgentId ?? parentAgentId
        : event.parentAgentId === "root" ? agentPath : event.parentAgentId
    };
  });
}

export function adaptCodexTrace(records: JsonRecord[], projectPath: string, sourceRef: string): ProvenanceEvent[] {
  const meta = records.find((item) => item.type === "session_meta");
  const metaPayload = record(meta?.payload);
  const contexts = records.filter((item) => item.type === "turn_context").map((item) => record(item.payload));
  if (![metaPayload, ...contexts].some((item) => cwdMatches(item.cwd, projectPath))) return [];
  const runId = text(metaPayload.id) ?? `codex:${sourceRef}`;
  const startedAt = text(meta?.timestamp) ?? text(metaPayload.timestamp);
  const raw: JsonRecord[] = [];
  const outputsByCall = new Map(records.flatMap((item) => {
    if (item.type !== "response_item") return [];
    const payload = record(item.payload);
    const callId = text(payload.call_id);
    if (payload.type !== "function_call_output" || !callId) return [];
    return [[callId, parseArguments(payload.output)] as const];
  }));
  if (startedAt) raw.push(rawEvent({}, { id: `${runId}:start`, timestamp: startedAt, runId, agentId: "root", kind: "run_started", summary: "Codex session started" }));

  for (const item of records) {
    if (item.type !== "response_item") continue;
    const payload = record(item.payload);
    const timestamp = text(item.timestamp);
    if (!timestamp) continue;
    if (payload.type === "agent_message") {
      const author = text(payload.author) ?? "agent";
      raw.push(rawEvent({}, {
        id: text(payload.id) ?? `${runId}:report:${raw.length}`, timestamp, runId, agentId: author,
        parentAgentId: "root", kind: "knowledge_reported",
        summary: "Agent completion report received"
      }));
      continue;
    }
    if (payload.type === "custom_tool_call") {
      raw.push(...codexWrapperEvents(payload, timestamp, runId, projectPath));
      continue;
    }
    if (payload.type !== "function_call") continue;
    const name = text(payload.name) ?? "unknown";
    const args = parseArguments(payload.arguments);
    const id = text(payload.call_id) ?? `${runId}:${raw.length}`;
    const delivered = deliveryEvent(name, args, { id, timestamp, runId, agentId: "root" });
    if (delivered) {
      raw.push(delivered);
      continue;
    }
    if (["exec_command", "shell_command"].includes(name)) {
      const command = text(args.cmd) ?? text(args.command);
      if (command) raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: commandKind(command), target: { type: "command", value: command.slice(0, 500) }, summary: "Executed a repository command" }));
    } else if (name === "view_image") {
      const path = projectRelative(args.path, projectPath);
      if (path) raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: "file_read", target: { type: "file", path }, summary: "Inspected an image" }));
    } else if (name === "spawn_agent") {
      const output = outputsByCall.get(id) ?? {};
      const agentId = text(output.agent_id) ?? text(args.task_name) ?? `agent:${id}`;
      raw.push(rawEvent({}, { id, timestamp, runId, agentId, parentAgentId: "root", taskId: text(args.task_name), kind: "agent_spawned", target: { type: "task", value: text(args.task_name) }, summary: text(args.task_name) ? `Spawned agent for ${text(args.task_name)}` : "Spawned agent" }));
    } else if (name === "send_message") {
      raw.push(rawEvent({}, { id, timestamp, runId, agentId: text(args.target) ?? "root", parentAgentId: "root", kind: "knowledge_reported", summary: "Agent knowledge handoff sent" }));
    }
  }
  const completed = [...records].reverse().find((item) => item.type === "event_msg" && record(item.payload).type === "task_complete");
  if (completed?.timestamp) raw.push(rawEvent({}, { id: `${runId}:finish`, timestamp: completed.timestamp, runId, agentId: "root", kind: "run_finished", summary: "Codex session completed" }));
  return normalizeProvenance(reconcileCodexAgentIds(applyCodexSessionIdentity(raw, text(metaPayload.agent_path))), { provider: "codex", sourceRef });
}

export function adaptClaudeTrace(records: JsonRecord[], projectPath: string, sourceRef: string): ProvenanceEvent[] {
  const matching = records.filter((item) => cwdMatches(item.cwd, projectPath));
  if (matching.length === 0) return [];
  const runId = text(matching[0]?.sessionId) ?? `claude:${sourceRef}`;
  const raw: JsonRecord[] = [];
  const agentResults = new Map<string, { agentId: string | null; timestamp: string }>();
  for (const item of matching) {
    const timestamp = text(item.timestamp);
    if (!timestamp) continue;
    const result = record(item.toolUseResult);
    const message = record(item.message);
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const blockValue of blocks) {
      const block = record(blockValue);
      const toolUseId = text(block.tool_use_id);
      if (block.type === "tool_result" && toolUseId) {
        agentResults.set(toolUseId, { agentId: text(result.agentId) ?? text(result.agent_id), timestamp });
      }
    }
  }
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
      const delivered = deliveryEvent(name, input, { id, timestamp, runId, agentId: "root" });
      if (delivered) {
        raw.push(delivered);
        continue;
      }
      if (name === "Read" && filePath) raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: "file_read", target: { type: "file", path: filePath }, summary: "Read a repository file" }));
      else if (["Edit", "Write"].includes(name) && filePath) raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: "file_edited", target: { type: "file", path: filePath }, summary: `${name === "Edit" ? "Edited" : "Wrote"} a repository file` }));
      else if (name === "Bash" && text(input.command)) {
        const command = text(input.command)!;
        raw.push(rawEvent({}, { id, timestamp, runId, agentId: "root", kind: commandKind(command), target: { type: "command", value: command.slice(0, 500) }, summary: "Executed a repository command" }));
      } else if (name === "Agent") {
        const agentId = agentResults.get(id)?.agentId ?? `agent:${id}`;
        raw.push(rawEvent({}, { id, timestamp, runId, agentId, parentAgentId: "root", taskId: text(input.description), kind: "agent_spawned", target: { type: "task", value: safeSummary(input.description) }, summary: safeSummary(input.description) }));
      } else if (name === "SendMessage") {
        raw.push(rawEvent({}, { id, timestamp, runId, agentId: text(input.recipient) ?? text(input.to) ?? "root", parentAgentId: "root", kind: "knowledge_reported", summary: "Agent knowledge handoff sent" }));
      }
    }
  }
  for (const [toolUseId, result] of agentResults) {
    raw.push(rawEvent({}, {
      id: `${toolUseId}:result`, timestamp: result.timestamp, runId,
      agentId: result.agentId ?? `agent:${toolUseId}`, parentAgentId: "root",
      kind: "knowledge_reported", summary: "Agent completion report received"
    }));
  }
  const lastTimestamp = [...matching].reverse().map((item) => text(item.timestamp)).find(Boolean);
  if (lastTimestamp) raw.push(rawEvent({}, { id: `${runId}:finish`, timestamp: lastTimestamp, runId, agentId: "root", kind: "run_finished", summary: "Claude session ended" }));
  return normalizeProvenance(raw, { provider: "claude", sourceRef });
}

export async function findTraceFiles(root: string): Promise<string[]> {
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

export function defaultTraceRoot(provider: TraceProvider): string {
  if (provider === "codex") {
    return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "sessions") : join(homedir(), ".codex", "sessions");
  }
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "projects") : join(homedir(), ".claude", "projects");
}

interface TraceMatchCacheEntry {
  size: bigint;
  mtimeNs: bigint;
  matched: boolean;
}

const traceMatchCache = new Map<string, TraceMatchCacheEntry>();

export async function findMatchingTraceFiles(
  provider: TraceProvider,
  root: string,
  projectPath: string
): Promise<string[]> {
  const resolvedProjectPath = resolve(projectPath);
  const matched: string[] = [];
  for (const path of await findTraceFiles(root)) {
    try {
      const info = await stat(path, { bigint: true });
      if (info.size > MAX_TRACE_BYTES) continue;
      const key = `${provider}\0${resolvedProjectPath}\0${path}`;
      const cached = traceMatchCache.get(key);
      let isMatch = cached?.size === info.size && cached.mtimeNs === info.mtimeNs
        ? cached.matched
        : traceMatches(provider, parseLines(await readFile(path, "utf8")).records, resolvedProjectPath);
      if (!cached || cached.size !== info.size || cached.mtimeNs !== info.mtimeNs) {
        traceMatchCache.set(key, { size: info.size, mtimeNs: info.mtimeNs, matched: isMatch });
      }
      if (isMatch) matched.push(path);
    } catch {
      // Discovery reports unreadable files; fingerprinting only needs usable inputs.
    }
  }
  return matched;
}

export async function discoverAgentTraces(options: DiscoverTraceOptions): Promise<TraceDiscoveryResult> {
  const projectPath = resolve(options.projectPath);
  const providers = options.providers?.length ? [...new Set(options.providers)] : ["codex", "claude"] as TraceProvider[];
  const diagnostics: TraceDiscoveryDiagnostic[] = [];
  const allEvents: ProvenanceEvent[] = [];

  for (const provider of providers) {
    const root = options.roots?.[provider] ?? defaultTraceRoot(provider);
    const files = await findTraceFiles(root);
    const diagnostic: TraceDiscoveryDiagnostic = {
      provider, filesScanned: files.length, sessionsMatched: 0, eventsImported: 0, skippedFiles: 0,
      malformedRecords: 0, unsupportedRecords: 0, incompleteRecords: 0, warnings: []
    };
    for (const path of files) {
      try {
        const info = await stat(path);
        if (info.size > MAX_TRACE_BYTES) { diagnostic.skippedFiles += 1; diagnostic.warnings.push(`Skipped oversized trace ${basename(path)}`); continue; }
        const parsed = parseLines(await readFile(path, "utf8"));
        const records = parsed.records;
        const sourceRef = `${provider}:${basename(path)}`;
        const matched = traceMatches(provider, records, projectPath);
        const events = matched ? (provider === "codex" ? adaptCodexTrace(records, projectPath, sourceRef) : adaptClaudeTrace(records, projectPath, sourceRef)) : [];
        if (matched) {
          const quality = traceQuality(provider, records, projectPath);
          diagnostic.sessionsMatched += 1;
          diagnostic.eventsImported += events.length;
          diagnostic.malformedRecords += parsed.malformed;
          diagnostic.unsupportedRecords += quality.unsupported;
          diagnostic.incompleteRecords += quality.incomplete;
          const issues = [
            ...(parsed.malformed ? [countLabel(parsed.malformed, "malformed record")] : []),
            ...(quality.unsupported ? [countLabel(quality.unsupported, "unsupported tool record")] : []),
            ...(quality.incomplete ? [countLabel(quality.incomplete, "incomplete tool record")] : [])
          ];
          if (issues.length) diagnostic.warnings.push(`${basename(path)}: ${issues.join(", ")}`);
          if (events.length) allEvents.push(...events);
        }
      } catch (error) {
        diagnostic.skippedFiles += 1;
        diagnostic.warnings.push(`Skipped ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    diagnostics.push(diagnostic);
  }
  const deduplicated = [...new Map(allEvents.map((event) => [`${event.provider}\0${event.runId}\0${event.id}`, event])).values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return { events: deduplicated, diagnostics };
}
