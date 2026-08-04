import { basename } from "node:path";

import { deriveLayers } from "./layers.ts";
import type { LayerConfiguration, LayerData } from "./layers.ts";
import type { ExtractedGraph, GraphLink, GraphSymbol } from "./types.ts";

export const DEFAULT_MAX_NODES = 400;
export const FILE_LEVEL_LIMIT = 400;

export interface PrepareGraphOptions {
  level?: "auto" | "file" | "directory" | "symbol";
  maxNodes?: number;
  filterPaths?: string[];
  layerConfig?: LayerConfiguration;
}

export interface PreparedNode {
  id: string;
  label: string;
  path: string;
  type: "file" | "directory" | "symbol";
  layer: string;
  language?: string | null;
  size: number;
  symbolCount: number;
  fileCount: number;
  errors?: string | null;
  degree?: number;
  [key: string]: unknown;
}

export interface PreparedGraph {
  level: "file" | "directory" | "symbol";
  nodes: PreparedNode[];
  links: GraphLink[];
  files: ExtractedGraph["files"];
  symbols: GraphSymbol[];
  layers: LayerData["layers"];
  sourceStats: ExtractedGraph["stats"];
  report: {
    totalNodes: number; shownNodes: number; droppedNodes: number;
    totalLinks: number; shownLinks: number; droppedLinks: number; pruned: boolean;
  };
}

function directoryFor(path: string): string {
  const separator = path.indexOf("/");
  return separator === -1 ? "(root)" : path.slice(0, separator);
}

function dominantKind(kinds: Record<string, number>): string | null {
  return Object.entries(kinds).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  )[0]?.[0] ?? null;
}

function aggregateLinks(
  links: GraphLink[],
  resolveNode: (id: string) => string | null
): GraphLink[] {
  const aggregated = new Map();

  for (const link of links) {
    const source = resolveNode(link.source);
    const target = resolveNode(link.target);
    if (source === null || target === null || source === target) continue;
    const key = `${source}\0${target}`;
    let result = aggregated.get(key);
    if (!result) {
      result = { source, target, weight: 0, dominantKind: null, kinds: {} };
      aggregated.set(key, result);
    }
    result.weight += link.weight;
    for (const [kind, count] of Object.entries(link.kinds)) {
      result.kinds[kind] = (result.kinds[kind] ?? 0) + count;
    }
  }

  return [...aggregated.values()]
    .map((link) => ({ ...link, dominantKind: dominantKind(link.kinds) }))
    .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
}

function fileGraph(payload: ExtractedGraph, layerData: LayerData) {
  const nodes = payload.files.map((file) => ({
    id: file.path,
    label: basename(file.path),
    path: file.path,
    type: "file",
    layer: layerData.byPath[file.path],
    language: file.language,
    size: file.size ?? 0,
    symbolCount: file.symbolCount,
    fileCount: 1,
    errors: file.errors
  }));
  return { nodes, links: payload.links.map((link) => ({ ...link, kinds: { ...link.kinds } })) };
}

function directoryGraph(payload: ExtractedGraph, layerData: LayerData) {
  const byDirectory = new Map();
  for (const file of payload.files) {
    const id = directoryFor(file.path);
    let node = byDirectory.get(id);
    if (!node) {
      node = {
        id, label: id, path: id, type: "directory", layer: layerData.byPath[file.path],
        language: null, size: 0, symbolCount: 0, fileCount: 0, errors: null
      };
      byDirectory.set(id, node);
    }
    node.size += file.size ?? 0;
    node.symbolCount += file.symbolCount;
    node.fileCount += 1;
  }
  const links = aggregateLinks(payload.links, directoryFor);
  return { nodes: [...byDirectory.values()], links };
}

function symbolGraph(payload: ExtractedGraph, filterPaths: string[], layerData: LayerData) {
  const matches = (path) => filterPaths.some((filter) => path === filter || path.startsWith(`${filter}/`));
  const symbols = payload.symbols.filter((symbol) => matches(symbol.filePath));
  const ids = new Set(symbols.map(({ id }) => id));
  const nodes = symbols.map((symbol) => ({
    ...symbol,
    label: symbol.name,
    path: symbol.filePath,
    type: "symbol" as const,
    layer: layerData.byPath[symbol.filePath],
    fileCount: 1,
    symbolCount: 1,
    size: Math.max(1, (symbol.endLine ?? symbol.startLine ?? 0) - (symbol.startLine ?? 0) + 1)
  }));
  const links = (payload.symbolLinks ?? [])
    .filter((link) => ids.has(link.source) && ids.has(link.target))
    .map((link) => ({
      source: link.source,
      target: link.target,
      weight: link.weight,
      dominantKind: "calls",
      kinds: { calls: link.weight }
    }));
  return { nodes, links };
}

function prune(graph: { nodes: PreparedNode[]; links: GraphLink[] }, maxNodes: number) {
  const degree = new Map<string, number>(graph.nodes.map(({ id }) => [id, 0]));
  for (const link of graph.links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + link.weight);
    degree.set(link.target, (degree.get(link.target) ?? 0) + link.weight);
  }
  const selected = new Set(
    [...graph.nodes]
      .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id))
      .slice(0, maxNodes)
      .map(({ id }) => id)
  );
  const nodes = graph.nodes
    .filter(({ id }) => selected.has(id))
    .map((node) => ({ ...node, degree: degree.get(node.id) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const links = graph.links.filter((link) => selected.has(link.source) && selected.has(link.target));

  return { nodes, links };
}

export function prepareGraph(
  payload: ExtractedGraph,
  options: PrepareGraphOptions = {}
): PreparedGraph {
  const level = options.level ?? "auto";
  const selectedLevel = level === "auto"
    ? (payload.files.length <= FILE_LEVEL_LIMIT ? "file" : "directory")
    : level;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const filterPaths = options.filterPaths ?? [];

  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error("maxNodes must be a positive integer.");
  }
  if (!new Set(["file", "directory", "symbol"]).has(selectedLevel)) {
    throw new Error(`Unknown graph level ${JSON.stringify(selectedLevel)}.`);
  }
  if (selectedLevel === "symbol" && filterPaths.length === 0) {
    throw new Error("Symbol level requires at least one filter path.");
  }

  const layerData = deriveLayers(payload.files, options.layerConfig);
  const complete = selectedLevel === "file"
    ? fileGraph(payload, layerData)
    : selectedLevel === "directory"
      ? directoryGraph(payload, layerData)
      : symbolGraph(payload, filterPaths, layerData);
  complete.nodes.sort((left, right) => left.id.localeCompare(right.id));
  const shown = prune(complete, maxNodes);

  return {
    level: selectedLevel,
    nodes: shown.nodes,
    links: shown.links,
    files: payload.files,
    symbols: payload.symbols,
    layers: layerData.layers,
    sourceStats: payload.stats,
    report: {
      totalNodes: complete.nodes.length,
      shownNodes: shown.nodes.length,
      droppedNodes: complete.nodes.length - shown.nodes.length,
      totalLinks: complete.links.length,
      shownLinks: shown.links.length,
      droppedLinks: complete.links.length - shown.links.length,
      pruned: shown.nodes.length < complete.nodes.length
    }
  };
}
