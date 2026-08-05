import type {
  ChangeCorrelation, GitSnapshot, GraphSymbol, ProvenanceEvent
} from "./types.ts";
import { provenanceEventKey } from "./provenance.ts";

const AUTHORING_KINDS = new Set(["edit_proposed", "file_edited"]);
const RUN_EVIDENCE_KINDS = new Set(["test_run", "commit_created", "pr_opened", "review_received"]);

function metadataPaths(event: ProvenanceEvent): string[] {
  const paths = event.metadata.paths;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}

function appliesToPath(event: ProvenanceEvent, path: string): boolean {
  return event.target?.path === path || metadataPaths(event).includes(path);
}

function semanticEventKey(event: ProvenanceEvent): string {
  const target = event.target ? {
    type: event.target.type,
    path: event.target.path ?? null,
    symbolId: event.target.symbolId ?? null,
    value: event.target.value ?? null,
    startLine: event.target.startLine ?? null,
    endLine: event.target.endLine ?? null
  } : null;
  return JSON.stringify([
    event.provider,
    event.runId,
    event.agentId,
    event.parentAgentId,
    event.taskId,
    event.timestamp,
    event.kind,
    target,
    [...new Set(metadataPaths(event))].sort()
  ]);
}

/** Removes duplicate imported records without treating nearby timestamps as identity. */
export function deduplicateCorrelationEvents(events: ProvenanceEvent[]): ProvenanceEvent[] {
  const selected = new Map<string, ProvenanceEvent>();
  for (const event of events) {
    const key = semanticEventKey(event);
    const current = selected.get(key);
    if (!current || event.id.localeCompare(current.id) < 0) selected.set(key, event);
  }
  return [...selected.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
}

function isUntargeted(event: ProvenanceEvent): boolean {
  return !event.target?.path && metadataPaths(event).length === 0;
}

function runAgentKey(event: ProvenanceEvent): string {
  return `${event.runId}\0${event.agentId}`;
}

function runAgentTaskKey(event: ProvenanceEvent): string {
  return `${runAgentKey(event)}\0${event.taskId ?? ""}`;
}

function symbolMatches(symbol: GraphSymbol, event: ProvenanceEvent): boolean {
  if (symbol.filePath !== event.target?.path) return false;
  if (event.target.symbolId) return event.target.symbolId === symbol.id;
  if (!event.target.startLine) return true;
  return (symbol.startLine ?? 0) <= (event.target.endLine ?? event.target.startLine) &&
    (symbol.endLine ?? Number.MAX_SAFE_INTEGER) >= event.target.startLine;
}

export function correlateChanges(
  snapshot: GitSnapshot,
  events: ProvenanceEvent[],
  symbols: GraphSymbol[]
): ChangeCorrelation[] {
  const uniqueEvents = deduplicateCorrelationEvents(events);
  const runBounds = new Map<string, { start: string; end: string }>();
  for (const event of uniqueEvents) {
    const current = runBounds.get(event.runId);
    runBounds.set(event.runId, {
      start: !current || event.timestamp < current.start ? event.timestamp : current.start,
      end: !current || event.timestamp > current.end ? event.timestamp : current.end
    });
  }
  const symbolsByPath = new Map<string, GraphSymbol[]>();
  for (const symbol of symbols) {
    const entries = symbolsByPath.get(symbol.filePath) ?? [];
    entries.push(symbol);
    symbolsByPath.set(symbol.filePath, entries);
  }
  const eventsByPath = new Map<string, ProvenanceEvent[]>();
  const runEvidenceByAgent = new Map<string, ProvenanceEvent[]>();
  const runEvidenceByTask = new Map<string, ProvenanceEvent[]>();
  for (const event of uniqueEvents) {
    const paths = new Set([event.target?.path, ...metadataPaths(event)].filter((path): path is string => Boolean(path)));
    for (const path of paths) {
      const entries = eventsByPath.get(path) ?? [];
      entries.push(event);
      eventsByPath.set(path, entries);
    }
    if (RUN_EVIDENCE_KINDS.has(event.kind) && isUntargeted(event)) {
      const index = event.taskId === null ? runEvidenceByAgent : runEvidenceByTask;
      const key = event.taskId === null ? runAgentKey(event) : runAgentTaskKey(event);
      const entries = index.get(key) ?? [];
      entries.push(event);
      index.set(key, entries);
    }
  }

  const commitsByPath = new Map<string, string[]>();
  for (const commit of snapshot.recentCommits) {
    for (const change of commit.changes) {
      const shas = commitsByPath.get(change.path) ?? [];
      shas.push(commit.sha);
      commitsByPath.set(change.path, shas);
    }
  }
  const paths = [...new Set([...snapshot.changes.map((change) => change.path), ...commitsByPath.keys()])].sort();
  const workingPaths = new Set(snapshot.changes.map((change) => change.path));

  return paths.map((path) => {
    const targeted = (eventsByPath.get(path) ?? []).filter((event) => appliesToPath(event, path));
    const authoring = targeted.filter((event) => AUTHORING_KINDS.has(event.kind));
    const runEvidence = authoring.flatMap((authored) => [
      ...(runEvidenceByAgent.get(runAgentKey(authored)) ?? []),
      ...(authored.taskId ? runEvidenceByTask.get(runAgentTaskKey(authored)) ?? [] : [])
    ]);
    const related = [...new Map([...targeted, ...runEvidence].map((event) => [provenanceEventKey(event), event])).values()];
    const agentIds = [...new Set(authoring.map((event) => event.agentId))].sort();
    const multipleContributors = agentIds.length > 1;
    const concurrentConflict = authoring.some((left, index) => authoring.slice(index + 1).some((right) => {
      if (left.agentId === right.agentId) return false;
      if (left.runId === right.runId) return true;
      const leftRun = runBounds.get(left.runId);
      const rightRun = runBounds.get(right.runId);
      return Boolean(leftRun && rightRun &&
        left.timestamp >= rightRun.start && left.timestamp <= rightRun.end &&
        right.timestamp >= leftRun.start && right.timestamp <= leftRun.end);
    }));
    const attributions = agentIds.map((agentId) => {
      const authored = authoring.filter((event) => event.agentId === agentId);
      return {
        agentId,
        eventIds: authored.map(provenanceEventKey).sort(),
        reasons: [...new Set(authored.map((event) => event.kind === "file_edited"
          ? "explicit_file_edit" as const
          : "explicit_edit_proposal" as const))].sort()
      };
    });
    const fileSymbols = symbolsByPath.get(path) ?? [];
    const symbolIds = [...new Set(related.flatMap((event) => fileSymbols.filter((symbol) => symbolMatches(symbol, event)).map((symbol) => symbol.id)))].sort();
    const kinds = new Set(related.map((event) => event.kind));
    return {
      path,
      commitShas: commitsByPath.get(path) ?? [],
      eventIds: related.map(provenanceEventKey).sort(),
      agentIds,
      attributions,
      attributionStatus: concurrentConflict ? "concurrent_conflict" : multipleContributors ? "multiple_contributors" : agentIds.length === 1 ? "attributed" : "unattributed",
      symbolIds,
      evidence: [
        ...(related.length ? ["explicit_event_target" as const] : []),
        ...(commitsByPath.has(path) ? ["commit_membership" as const] : [])
      ],
      states: {
        inspected: kinds.has("file_read") || kinds.has("symbol_inspected"),
        proposed: kinds.has("edit_proposed"),
        modified: kinds.has("file_edited"),
        tested: kinds.has("test_run"),
        committed: !workingPaths.has(path) && (kinds.has("commit_created") || commitsByPath.has(path)),
        reviewed: kinds.has("review_received"),
        prOpened: kinds.has("pr_opened")
      },
      overlappingAgents: concurrentConflict,
      multipleContributors,
      concurrentConflict
    };
  });
}
