import { stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { generateVisualization } from "./app.ts";
import type { TraceProvider } from "./types.ts";

type Level = "auto" | "directory" | "file" | "symbol";

export interface VisualizeToolInput {
  projectPath?: string;
  outputPath?: string;
  level?: Level;
  maxNodes?: number;
  filterPaths?: string[];
  tracePaths?: string[];
  autoAgentTraces?: boolean;
  providers?: TraceProvider[];
  force?: boolean;
}

export const toolDefinition = {
  name: "visualize_codegraph",
  description: "Generate a self-contained CodeGraph HTML visualization with agent provenance and Git changes.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      projectPath: { type: "string", description: "Repository containing .codegraph/codegraph.db. Defaults to the server working directory." },
      outputPath: { type: "string", description: "Destination HTML file. Defaults to codegraph-map.html in the project." },
      level: { type: "string", enum: ["auto", "directory", "file", "symbol"] },
      maxNodes: { type: "integer", minimum: 1 },
      filterPaths: { type: "array", items: { type: "string" } },
      tracePaths: { type: "array", items: { type: "string" } },
      autoAgentTraces: { type: "boolean", description: "Discover local Codex and Claude traces. Defaults to true." },
      providers: { type: "array", items: { type: "string", enum: ["codex", "claude"] } },
      force: { type: "boolean", description: "Replace an existing output file." }
    }
  }
};

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be an array of strings.`);
  return value;
}

function parseInput(value: unknown): VisualizeToolInput {
  const raw = inputRecord(value);
  const allowed = new Set(Object.keys(toolDefinition.inputSchema.properties));
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown tool arguments: ${unknown.join(", ")}.`);
  if (raw.projectPath !== undefined && typeof raw.projectPath !== "string") throw new Error("projectPath must be a string.");
  if (raw.outputPath !== undefined && typeof raw.outputPath !== "string") throw new Error("outputPath must be a string.");
  if (raw.level !== undefined && !["auto", "directory", "file", "symbol"].includes(String(raw.level))) throw new Error("level is invalid.");
  if (raw.maxNodes !== undefined && (!Number.isInteger(raw.maxNodes) || Number(raw.maxNodes) < 1)) throw new Error("maxNodes must be a positive integer.");
  if (raw.autoAgentTraces !== undefined && typeof raw.autoAgentTraces !== "boolean") throw new Error("autoAgentTraces must be a boolean.");
  if (raw.force !== undefined && typeof raw.force !== "boolean") throw new Error("force must be a boolean.");
  const providers = stringArray(raw.providers, "providers");
  if (providers?.some((provider) => !["codex", "claude"].includes(provider))) throw new Error("providers may contain only codex or claude.");
  return {
    projectPath: raw.projectPath as string | undefined,
    outputPath: raw.outputPath as string | undefined,
    level: raw.level as Level | undefined,
    maxNodes: raw.maxNodes as number | undefined,
    filterPaths: stringArray(raw.filterPaths, "filterPaths"),
    tracePaths: stringArray(raw.tracePaths, "tracePaths"),
    autoAgentTraces: raw.autoAgentTraces as boolean | undefined,
    providers: providers as TraceProvider[] | undefined,
    force: raw.force as boolean | undefined
  };
}

export async function runVisualizeTool(value: unknown): Promise<CallToolResult & { structuredContent: Record<string, unknown> }> {
  const input = parseInput(value);
  const projectPath = resolve(input.projectPath ?? process.cwd());
  const projectInfo = await stat(projectPath).catch(() => null);
  if (!projectInfo?.isDirectory()) throw new Error(`Project path is not a directory: ${projectPath}`);
  const outputPath = resolve(input.outputPath ?? join(projectPath, "codegraph-map.html"));
  if (extname(outputPath).toLowerCase() !== ".html") throw new Error("outputPath must end in .html.");
  const codeGraphPath = join(projectPath, ".codegraph");
  const relativeOutput = relative(codeGraphPath, outputPath);
  if (!relativeOutput.startsWith("..") && relativeOutput !== "") throw new Error("outputPath must not be inside .codegraph.");

  const result = await generateVisualization({
    projectPath,
    outputPath,
    level: input.level,
    maxNodes: input.maxNodes,
    filterPaths: input.filterPaths,
    tracePaths: input.tracePaths,
    autoTraces: input.autoAgentTraces,
    providers: input.providers,
    force: input.force
  });
  const summary = result.summary.slice(0, 12);
  const structuredContent = {
    outputPath: result.outputPath,
    level: result.graph.level,
    counts: result.graph.sourceStats,
    pruning: result.graph.report,
    provenanceEvents: result.graph.provenance?.length ?? 0,
    traceDiagnostics: result.graph.traceDiagnostics ?? [],
    warnings: result.warnings,
    summary
  };
  return { content: [{ type: "text", text: summary.join("\n") }], structuredContent };
}

export function createMcpServer(): Server {
  const server = new Server({ name: "codegraph-viz", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [toolDefinition] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== toolDefinition.name) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    try { return await runVisualizeTool(request.params.arguments ?? {}); }
    catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  return server;
}

export async function runMcpServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
