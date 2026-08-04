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
