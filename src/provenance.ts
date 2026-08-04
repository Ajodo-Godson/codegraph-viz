import { open, readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import type { ProvenanceEvent, ProvenanceTarget } from "./types.ts";

export const KNOWN_EVENT_KINDS = new Set([
  "run_started", "agent_spawned", "task_assigned", "file_read",
  "symbol_inspected", "knowledge_reported", "edit_proposed", "file_edited",
  "test_run", "commit_created", "pr_opened", "review_received", "run_finished"
]);

const KIND_ALIASES: Record<string, string> = {
  spawn_agent: "agent_spawned", agent_started: "agent_spawned",
  read: "file_read", file_opened: "file_read", edit: "file_edited",
  write: "file_edited", test: "test_run", commit: "commit_created",
  pull_request_opened: "pr_opened", pr_created: "pr_opened"
};
const SECRET_KEY = /(authorization|cookie|credential|password|secret|token|api[_-]?key)/i;
const SECRET_VALUE = /\b(sk-[a-z0-9_-]{8,}|gh[opsu]_[a-z0-9]{8,}|bearer\s+[a-z0-9._~-]+)\b/gi;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

function normalizeTarget(value: unknown): ProvenanceTarget | null {
  if (typeof value === "string") value = { type: "file", path: value };
  const target = record(value);
  if (Object.keys(target).length === 0) return null;
  const type = text(target.type) ?? (target.path ? "file" : "other");
  const allowed = new Set(["file", "symbol", "command", "commit", "pull_request", "task", "other"]);
  const path = text(target.path);
  if (path && (isAbsolute(path) || normalize(path).startsWith(".."))) {
    throw new Error(`Provenance target path must be repository-relative: ${path}`);
  }
  return {
    type: (allowed.has(type) ? type : "other") as ProvenanceTarget["type"],
    ...(path ? { path: normalize(path).replaceAll("\\", "/") } : {}),
    ...(text(target.symbolId) ? { symbolId: text(target.symbolId)! } : {}),
    ...(text(target.value) ? { value: text(target.value)! } : {}),
    ...(Number.isInteger(target.startLine) ? { startLine: Number(target.startLine) } : {}),
    ...(Number.isInteger(target.endLine) ? { endLine: Number(target.endLine) } : {})
  };
}

export interface NormalizeProvenanceOptions {
  provider?: string;
  sourceRef?: string;
}

export function normalizeProvenance(input: unknown, options: NormalizeProvenanceOptions = {}): ProvenanceEvent[] {
  const envelope = record(input);
  const rawEvents = Array.isArray(input) ? input : Array.isArray(envelope.events) ? envelope.events : [input];
  const provider = options.provider ?? text(envelope.provider) ?? "generic";
  const sourceRef = options.sourceRef ?? text(envelope.sourceRef) ?? "inline";

  return rawEvents.map((value, index) => {
    const raw = record(value);
    const timestampValue = text(raw.timestamp) ?? text(raw.created_at);
    if (!timestampValue || Number.isNaN(Date.parse(timestampValue))) {
      throw new Error(`Provenance event ${index} requires a valid timestamp.`);
    }
    const runId = text(raw.runId) ?? text(raw.run_id) ?? text(raw.sessionId);
    if (!runId) throw new Error(`Provenance event ${index} requires runId.`);
    const rawKind = (text(raw.kind) ?? text(raw.type) ?? "unknown").toLowerCase().replaceAll(".", "_");
    const kind = KIND_ALIASES[rawKind] ?? rawKind;
    const agentId = text(raw.agentId) ?? text(raw.agent_id) ?? "root";
    const metadata = redact(record(raw.metadata)) as Record<string, unknown>;
    const summary = text(redact(raw.summary));
    return {
      id: text(raw.id) ?? `${provider}:${runId}:${index}`,
      timestamp: new Date(timestampValue).toISOString(),
      provider,
      runId,
      agentId,
      parentAgentId: text(raw.parentAgentId) ?? text(raw.parent_agent_id),
      taskId: text(raw.taskId) ?? text(raw.task_id),
      kind,
      knownKind: KNOWN_EVENT_KINDS.has(kind),
      target: normalizeTarget(raw.target),
      summary,
      sourceRef: text(raw.sourceRef) ?? sourceRef,
      metadata
    };
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
}

export async function readProvenanceFile(path: string, provider?: string): Promise<ProvenanceEvent[]> {
  const content = await readFile(path, "utf8");
  let input: unknown;
  try { input = JSON.parse(content); }
  catch {
    input = content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    });
  }
  return normalizeProvenance(input, { provider, sourceRef: path });
}

export async function appendProvenanceEvents(path: string, events: ProvenanceEvent[]): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  } finally { await handle.close(); }
}
