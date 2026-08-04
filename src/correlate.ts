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
  return snapshot.changes.map((change) => {
    const related = events.filter((event) => appliesToPath(event, change.path));
    const authoring = related.filter((event) => AUTHORING_KINDS.has(event.kind));
    const agentIds = [...new Set(authoring.map((event) => event.agentId))].sort();
    const symbolIds = [...new Set(related.flatMap((event) => symbols.filter((symbol) => symbolMatches(symbol, event)).map((symbol) => symbol.id)))].sort();
    const kinds = new Set(related.map((event) => event.kind));
    return {
      path: change.path,
      eventIds: related.map((event) => event.id).sort(),
      agentIds,
      symbolIds,
      evidence: related.length ? ["explicit_event_target"] : [],
      states: {
        inspected: kinds.has("file_read") || kinds.has("symbol_inspected"),
        proposed: kinds.has("edit_proposed"),
        modified: kinds.has("file_edited"),
        tested: kinds.has("test_run"),
        committed: kinds.has("commit_created"),
        reviewed: kinds.has("review_received"),
        prOpened: kinds.has("pr_opened")
      },
      overlappingAgents: agentIds.length > 1
    };
  });
}
