import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type CodeGraphInitRunner = (command: string, args: string[]) => Promise<void>;

interface EnsureIndexOptions {
  timeoutMs?: number;
  pollMs?: number;
}

function databasePath(projectPath: string): string {
  return join(resolve(projectPath), ".codegraph", "codegraph.db");
}

export function hasCodeGraphIndex(projectPath: string): boolean {
  const path = databasePath(projectPath);
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats?.isFile() ?? false;
}

const runCodeGraphInit: CodeGraphInitRunner = (command, args) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", (error) => reject(new Error(`Unable to initialize CodeGraph: ${error.message}`, { cause: error })));
  child.on("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`Unable to initialize CodeGraph: process exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`));
  });
});

export async function ensureCodeGraphIndex(
  projectPath: string,
  runner: CodeGraphInitRunner = runCodeGraphInit,
  options: EnsureIndexOptions = {}
): Promise<"existing" | "initialized"> {
  const resolvedProjectPath = resolve(projectPath);
  if (hasCodeGraphIndex(resolvedProjectPath)) return "existing";

  await runner("codegraph", ["init", resolvedProjectPath]);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (!hasCodeGraphIndex(resolvedProjectPath) && Date.now() < deadline) {
    await delay(pollMs);
  }
  if (!hasCodeGraphIndex(resolvedProjectPath)) {
    throw new Error(`CodeGraph initialization did not create an index at ${databasePath(resolvedProjectPath)}.`);
  }
  return "initialized";
}
