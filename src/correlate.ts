import type {
  ChangeCorrelation, GitSnapshot, GraphSymbol, ProvenanceEvent
} from "./types.ts";

const AUTHORING_KINDS = new Set(["edit_proposed", "file_edited"]);

function metadataPaths(event: ProvenanceEvent): string[] {
  const paths = event.metadata.paths;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}

function appliesToPath(event: ProvenanceEvent, path: string): boolean {
  return event.target?.path === path || metadataPaths(event).includes(path);
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
  const symbolsByPath = new Map<string, GraphSymbol[]>();
  for (const symbol of symbols) {
    const entries = symbolsByPath.get(symbol.filePath) ?? [];
    entries.push(symbol);
    symbolsByPath.set(symbol.filePath, entries);
  }
  const eventsByPath = new Map<string, ProvenanceEvent[]>();
  for (const event of events) {
    const paths = new Set([event.target?.path, ...metadataPaths(event)].filter((path): path is string => Boolean(path)));
    for (const path of paths) {
      const entries = eventsByPath.get(path) ?? [];
      entries.push(event);
      eventsByPath.set(path, entries);
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

  return paths.map((path) => {
    const related = (eventsByPath.get(path) ?? []).filter((event) => appliesToPath(event, path));
    const authoring = related.filter((event) => AUTHORING_KINDS.has(event.kind));
    const agentIds = [...new Set(authoring.map((event) => event.agentId))].sort();
    const fileSymbols = symbolsByPath.get(path) ?? [];
    const symbolIds = [...new Set(related.flatMap((event) => fileSymbols.filter((symbol) => symbolMatches(symbol, event)).map((symbol) => symbol.id)))].sort();
    const kinds = new Set(related.map((event) => event.kind));
    return {
      path,
      commitShas: commitsByPath.get(path) ?? [],
      eventIds: related.map((event) => event.id).sort(),
      agentIds,
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
        committed: kinds.has("commit_created") || commitsByPath.has(path),
        reviewed: kinds.has("review_received"),
        prOpened: kinds.has("pr_opened")
      },
      overlappingAgents: agentIds.length > 1
    };
  });
}
