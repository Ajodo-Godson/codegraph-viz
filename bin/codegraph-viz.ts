#!/usr/bin/env node

import { openCodeGraph } from "../src/open.ts";
import { extractGraph } from "../src/extract.ts";

const argumentsList = process.argv.slice(2);
const json = argumentsList.includes("--json");
const positional = argumentsList.filter((argument) => argument !== "--json");
const projectPath = positional[0] ?? process.cwd();

if (positional.length > 1) {
  console.error("Usage: codegraph-viz [path] [--json]");
  process.exitCode = 1;
} else {
  let opened;

  try {
    opened = openCodeGraph(projectPath);
    const payload = extractGraph(opened);

    for (const warning of opened.warnings) {
      console.error(`Warning: ${warning}`);
    }

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`CodeGraph schema: ${opened.schemaVersion}`);
      console.log(`Database: ${opened.path}`);
      console.log(`Files: ${payload.stats.fileCount}`);
      console.log(`Symbols: ${payload.stats.symbolCount}`);
      console.log(`Cross-file links: ${payload.stats.linkCount}`);
      console.log(`Newest indexed file: ${opened.newestIndexedAt ?? "unknown"}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    opened?.close();
  }
}
