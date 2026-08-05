import type { DatabaseSync } from "node:sqlite";

export interface RelatedSymbol {
  id: string;
  name: string;
  filePath: string;
}

export interface GraphFile {
  path: string;
  language: string | null;
  size: number | null;
  symbolCount: number;
  errors: string | null;
}

export interface GraphSymbol {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  signature: string | null;
  degree: number;
  callers: RelatedSymbol[];
  callees: RelatedSymbol[];
  callerCount: number;
  calleeCount: number;
}

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
  dominantKind: string;
  kinds: Record<string, number>;
}

export interface SymbolLink {
  source: string;
  target: string;
  weight: number;
}

export interface ExtractedGraph {
  files: GraphFile[];
  links: GraphLink[];
  symbols: GraphSymbol[];
  symbolLinks: SymbolLink[];
  stats: {
    fileCount: number;
    symbolCount: number;
    linkCount: number;
    crossFileEdgeCount: number;
    edgeKindCounts: Record<string, number>;
    newestIndexedAt: string | number | null;
  };
}

export interface OpenedCodeGraph {
  database: DatabaseSync;
  path: string;
  schemaVersion: number;
  metadata: Record<string, string>;
  newestIndexedAt: string | number | null;
  warnings: string[];
  close(): void;
}

export interface ProvenanceTarget {
  type: "file" | "symbol" | "command" | "commit" | "pull_request" | "task" | "other";
  path?: string;
  symbolId?: string;
  value?: string;
  startLine?: number;
  endLine?: number;
}

export interface ProvenanceEvent {
  id: string;
  timestamp: string;
  provider: string;
  runId: string;
  agentId: string;
  parentAgentId: string | null;
  taskId: string | null;
  kind: string;
  knownKind: boolean;
  target: ProvenanceTarget | null;
  summary: string | null;
  sourceRef: string;
  metadata: Record<string, unknown>;
}

export type TraceProvider = "codex" | "claude";

export interface TraceDiscoveryDiagnostic {
  provider: TraceProvider;
  filesScanned: number;
  sessionsMatched: number;
  eventsImported: number;
  skippedFiles: number;
  malformedRecords: number;
  unsupportedRecords: number;
  incompleteRecords: number;
  warnings: string[];
}

export interface GitChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommit {
  sha: string;
  author: string;
  timestamp: string;
  subject: string;
  changes: GitCommitChange[];
}

export interface GitCommitChange {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitSnapshot {
  root: string;
  branch: string | null;
  head: string | null;
  changes: GitChange[];
  recentCommits: GitCommit[];
}

export interface GitHubCheckEvidence {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface GitHubReviewEvidence {
  author: string | null;
  state: string;
  submittedAt: string | null;
}

export interface GitHubPullRequestEvidence {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  mergeState: string | null;
  reviewDecision: string | null;
  checks: GitHubCheckEvidence[];
  reviews: GitHubReviewEvidence[];
  unresolvedReviewThreads: number | null;
}

export interface GitHubEvidenceResult {
  pullRequest: GitHubPullRequestEvidence | null;
  diagnostics: string[];
}

export interface ChangeCorrelation {
  path: string;
  commitShas: string[];
  eventIds: string[];
  agentIds: string[];
  attributions: Array<{
    agentId: string;
    eventIds: string[];
    reasons: ("explicit_file_edit" | "explicit_edit_proposal")[];
  }>;
  attributionStatus: "attributed" | "unattributed" | "overlapping";
  symbolIds: string[];
  evidence: ("explicit_event_target" | "commit_membership")[];
  states: {
    inspected: boolean;
    proposed: boolean;
    modified: boolean;
    tested: boolean;
    committed: boolean;
    reviewed: boolean;
    prOpened: boolean;
  };
  overlappingAgents: boolean;
}
