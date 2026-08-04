import { readFileSync } from "node:fs";

import { generateVisualization } from "./app.ts";
import { extractGraph } from "./extract.ts";
import type { PrepareGraphOptions } from "./granularity.ts";
import { openCodeGraph } from "./open.ts";

export interface CliOptions extends PrepareGraphOptions {
  projectPath: string;
  outputPath?: string;
  json: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
}

export const HELP = `Usage: codegraph-viz [path] [options]

Options:
  -o, --output <file>       Output HTML path (default: codegraph-map.html)
  --level <level>           auto, directory, file, or symbol
  --max-nodes <number>      Maximum visible nodes (default: 400)
  --filter <path>           Include path for symbol level; repeatable
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
  const result: CliOptions = { projectPath: cwd, json: false, force: false, help: false, version: false, filterPaths: [] };
  let positional = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") result.json = true;
    else if (argument === "--force") result.force = true;
    else if (argument === "-h" || argument === "--help") result.help = true;
    else if (argument === "-v" || argument === "--version") result.version = true;
    else if (argument === "-o" || argument === "--output") result.outputPath = valueAfter(args, index++, argument);
    else if (argument === "--level") {
      const level = valueAfter(args, index++, argument);
      if (!["auto", "directory", "file", "symbol"].includes(level)) throw new Error(`Invalid level ${JSON.stringify(level)}.`);
      result.level = level as CliOptions["level"];
    } else if (argument === "--max-nodes") {
      const value = Number(valueAfter(args, index++, argument));
      if (!Number.isInteger(value) || value < 1) throw new Error("--max-nodes must be a positive integer.");
      result.maxNodes = value;
    } else if (argument === "--filter") result.filterPaths?.push(valueAfter(args, index++, argument));
    else if (argument?.startsWith("-")) throw new Error(`Unknown option ${argument}.`);
    else if (positional) throw new Error("Only one project path may be provided.");
    else { result.projectPath = argument ?? cwd; positional = true; }
  }
  return result;
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArguments(args);
    if (options.help) { console.log(HELP); return 0; }
    if (options.version) {
      const packagePath = new URL("../package.json", import.meta.url);
      console.log(JSON.parse(readFileSync(packagePath, "utf8")).version);
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
