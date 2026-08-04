import { constants } from "node:fs";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { extractGraph } from "./extract.ts";
import { correlateChanges } from "./correlate.ts";
import { discoverAgentTraces } from "./discovery.ts";
import { inspectGit } from "./git.ts";
import { prepareGraph, type PrepareGraphOptions, type PreparedGraph } from "./granularity.ts";
import type { LayerConfiguration } from "./layers.ts";
import { openCodeGraph } from "./open.ts";
import { readProvenanceFile } from "./provenance.ts";
import { renderGraph } from "./render.ts";
import type { ExtractedGraph, TraceProvider } from "./types.ts";

export interface GenerateOptions extends PrepareGraphOptions {
  projectPath?: string;
  outputPath?: string;
  force?: boolean;
  generatedAt?: string;
  tracePaths?: string[];
  autoTraces?: boolean;
  providers?: TraceProvider[];
  traceRoots?: Partial<Record<TraceProvider, string>>;
}

export interface GenerationResult {
  outputPath: string;
  graph: PreparedGraph;
  payload: ExtractedGraph;
  warnings: string[];
  summary: string[];
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

export async function loadLayerConfiguration(projectPath: string): Promise<LayerConfiguration> {
  const path = join(projectPath, "codegraph-viz.json");
  if (!(await exists(path))) return {};
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`Invalid configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid configuration at ${path}: expected a JSON object.`);
  }
  const allowed = new Set(["rename", "merge", "colors"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Invalid configuration at ${path}: unknown keys ${unknown.join(", ")}.`);
  return value as LayerConfiguration;
}

async function writeAtomic(path: string, content: string, force: boolean): Promise<void> {
  if (!force && await exists(path)) throw new Error(`Output already exists at ${path}; use --force to replace it.`);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function generateVisualization(options: GenerateOptions = {}): Promise<GenerationResult> {
  const projectPath = resolve(options.projectPath ?? process.cwd());
  const outputPath = resolve(options.outputPath ?? "codegraph-map.html");
  const opened = openCodeGraph(projectPath);
  try {
    const payload = extractGraph(opened);
    const layerConfig = options.layerConfig ?? await loadLayerConfiguration(projectPath);
    const graph = prepareGraph(payload, { ...options, layerConfig });
    const discovered = options.autoTraces === false
      ? { events: [], diagnostics: [] }
      : await discoverAgentTraces({ projectPath, providers: options.providers, roots: options.traceRoots });
    const explicit = options.tracePaths?.length
      ? (await Promise.all(options.tracePaths.map((path) => readProvenanceFile(resolve(path))))).flat()
      : [];
    graph.provenance = [...new Map([...discovered.events, ...explicit].map((event) => [`${event.provider}\0${event.id}`, event])).values()]
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    graph.traceDiagnostics = discovered.diagnostics;
    for (const diagnostic of discovered.diagnostics) opened.warnings.push(...diagnostic.warnings);
    try {
      graph.git = inspectGit(projectPath);
      graph.correlations = correlateChanges(graph.git, graph.provenance ?? [], payload.symbols);
    } catch (error) {
      opened.warnings.push(`Git inspection unavailable: ${error instanceof Error ? error.message : String(error)}`);
      graph.correlations = [];
    }
    await writeAtomic(outputPath, renderGraph(graph, { generatedAt: options.generatedAt }), options.force ?? false);
    const hubs = [...graph.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || a.id.localeCompare(b.id)).slice(0, 3);
    return {
      outputPath,
      graph,
      payload,
      warnings: opened.warnings,
      summary: [
        `${payload.stats.fileCount} files, ${payload.stats.symbolCount} symbols, ${payload.stats.linkCount} cross-file links`,
        `Level: ${graph.level}; showing ${graph.report.shownNodes} of ${graph.report.totalNodes} nodes`,
        `Links: showing ${graph.report.shownLinks} of ${graph.report.totalLinks}`,
        `Provenance events: ${graph.provenance?.length ?? 0}`,
        `Agent traces: ${graph.traceDiagnostics?.map((item) => `${item.provider} ${item.sessionsMatched} sessions/${item.eventsImported} events`).join("; ") || "automatic discovery disabled"}`,
        `Git changes: ${graph.git?.changes.length ?? 0}; attributed: ${graph.correlations.filter((item) => item.agentIds.length).length}`,
        `Top hubs: ${hubs.map((node) => `${node.id} (${node.degree ?? 0})`).join(", ") || "none"}`,
        `Output: ${outputPath}`
      ]
    };
  } finally {
    opened.close();
  }
}
