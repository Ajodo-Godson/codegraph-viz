import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { generateVisualization } from "./app.ts";
import { extractGraph } from "./extract.ts";
import type { PrepareGraphOptions } from "./granularity.ts";
import { openCodeGraph } from "./open.ts";
import { ensureCodeGraphIndex, hasCodeGraphIndex } from "./setup.ts";
import type { TraceProvider } from "./types.ts";
import { startLiveVisualization } from "./watch.ts";

export interface CliOptions extends PrepareGraphOptions {
  projectPath: string;
  outputPath?: string;
  json: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
  initialize: boolean;
  watch: boolean;
  port: number;
  tracePaths: string[];
  autoTraces: boolean;
  providers: TraceProvider[];
}

export const HELP = `Usage: codegraph-viz [path] [options]

Options:
  -o, --output <file>       Output HTML path (default: codegraph-map.html)
  --level <level>           auto, directory, file, or symbol
  --max-nodes <number>      Maximum visible nodes (default: 400)
  --filter <path>           Include path for symbol level; repeatable
  --trace <file>            Import provenance JSON or JSONL; repeatable
  --provider <provider>     Discover codex or claude traces; repeatable
  --no-agent-traces         Disable automatic local trace discovery
  --init                    Initialize CodeGraph when its index is missing
  --watch                   Serve and refresh a local live visualization
  --port <number>           Live server port (default: 4173; 0 selects any port)
  --json                    Write extracted JSON to stdout instead of HTML
  --force                   Replace an existing output file
  -h, --help                Show help
  -v, --version             Show version`;

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseArguments(args: string[], cwd = process.cwd()): CliOptions {
  const result: CliOptions = { projectPath: cwd, json: false, force: false, help: false, version: false, initialize: false, watch: false, port: 4173, filterPaths: [], tracePaths: [], autoTraces: true, providers: [] };
  let positional = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--json":
        result.json = true;
        break;
      case "--no-agent-traces":
        result.autoTraces = false;
        break;
      case "--force":
        result.force = true;
        break;
      case "--init":
        result.initialize = true;
        break;
      case "--watch":
        result.watch = true;
        break;
      case "-h":
      case "--help":
        result.help = true;
        break;
      case "-v":
      case "--version":
        result.version = true;
        break;
      case "-o":
      case "--output":
        result.outputPath = valueAfter(args, index, argument);
        index += 1;
        break;
      case "--level": {
        const level = valueAfter(args, index, argument);
        index += 1;
        if (!["auto", "directory", "file", "symbol"].includes(level)) throw new Error(`Invalid level ${JSON.stringify(level)}.`);
        result.level = level as CliOptions["level"];
        break;
      }
      case "--max-nodes": {
        const value = Number(valueAfter(args, index, argument));
        index += 1;
        if (!Number.isInteger(value) || value < 1) throw new Error("--max-nodes must be a positive integer.");
        result.maxNodes = value;
        break;
      }
      case "--port": {
        const value = Number(valueAfter(args, index, argument));
        index += 1;
        if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("--port must be an integer from 0 to 65535.");
        result.port = value;
        break;
      }
      case "--filter":
        result.filterPaths?.push(valueAfter(args, index, argument));
        index += 1;
        break;
      case "--trace":
        result.tracePaths.push(valueAfter(args, index, argument));
        index += 1;
        break;
      case "--provider": {
        const provider = valueAfter(args, index, argument);
        index += 1;
        if (!(["codex", "claude"] as string[]).includes(provider)) throw new Error(`Invalid provider ${JSON.stringify(provider)}.`);
        result.providers.push(provider as TraceProvider);
        break;
      }
      default:
        if (argument?.startsWith("-")) throw new Error(`Unknown option ${argument}.`);
        if (positional) throw new Error("Only one project path may be provided.");
        result.projectPath = argument ?? cwd;
        positional = true;
    }
  }
  return result;
}

async function confirmCodeGraphInitialization(projectPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`No CodeGraph index found in ${projectPath}. Initialize it now? [Y/n] `);
    return answer.trim() === "" || /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArguments(args);
    if (options.help) { console.log(HELP); return 0; }
    if (options.version) {
      const sourcePackagePath = new URL("../package.json", import.meta.url);
      const packagePath = existsSync(sourcePackagePath) ? sourcePackagePath : new URL("../../package.json", import.meta.url);
      console.log(JSON.parse(readFileSync(packagePath, "utf8")).version);
      return 0;
    }
    if (!hasCodeGraphIndex(options.projectPath)) {
      const initialize = options.initialize || await confirmCodeGraphInitialization(options.projectPath);
      if (!initialize) {
        throw new Error("CodeGraph index is missing. Run `codegraph init` or rerun with `codegraph-viz --init`.");
      }
      console.error("Initializing CodeGraph...");
      await ensureCodeGraphIndex(options.projectPath, undefined, {
        stdout: options.json ? "stderr" : "inherit"
      });
      console.error("CodeGraph index ready.");
    }
    if (options.watch && options.json) throw new Error("--watch cannot be combined with --json.");
    if (options.watch) {
      const live = await startLiveVisualization({
        ...options,
        onUpdate: (result) => {
          for (const warning of result.warnings) console.error(`Warning: ${warning}`);
          console.log(`Updated: ${result.graph.provenance?.length ?? 0} provenance events`);
        },
        onError: (error) => console.error(`Live update failed: ${error.message}`)
      });
      for (const warning of live.warnings) console.error(`Warning: ${warning}`);
      console.log(`Live visualization: ${live.url}`);
      console.log(`Offline snapshot: ${live.outputPath}`);
      console.log("Watching for CodeGraph, Git, and agent trace changes. Press Ctrl+C to stop.");
      await new Promise<void>((resolvePromise) => {
        const stop = () => resolvePromise();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      await live.close();
      return 0;
    }
    if (options.json) {
      const opened = openCodeGraph(options.projectPath);
      try {
        for (const warning of opened.warnings) console.error(`Warning: ${warning}`);
        console.log(JSON.stringify(extractGraph(opened), null, 2));
      } finally { opened.close(); }
      return 0;
    }
    const result = await generateVisualization(options);
    for (const warning of result.warnings) console.error(`Warning: ${warning}`);
    for (const line of result.summary) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
