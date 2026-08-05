import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { GenerateOptions } from "./app.ts";
import { defaultTraceRoot, findTraceFiles } from "./discovery.ts";
import type { TraceProvider } from "./types.ts";

const execute = promisify(execFile);

async function fileIdentity(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${path}\0${info.size}\0${info.mtimeNs}`;
  } catch {
    return `${path}\0missing`;
  }
}

async function gitIdentity(projectPath: string): Promise<string> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execute("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectPath, encoding: "utf8" }),
      execute("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: projectPath, encoding: "utf8" })
    ]);
    return `${head.trim()}\0${status}`;
  } catch {
    return "git-unavailable";
  }
}

export async function inputFingerprint(options: GenerateOptions): Promise<string> {
  const projectPath = resolve(options.projectPath ?? process.cwd());
  const paths = [
    join(projectPath, ".codegraph", "codegraph.db"),
    join(projectPath, "codegraph-viz.json"),
    ...(options.tracePaths ?? []).map((path) => resolve(path))
  ];
  if (options.autoTraces !== false) {
    const providers = options.providers?.length
      ? [...new Set(options.providers)]
      : ["codex", "claude"] as TraceProvider[];
    for (const provider of providers) {
      const root = options.traceRoots?.[provider] ?? defaultTraceRoot(provider);
      paths.push(...await findTraceFiles(root));
    }
  }
  const identities = await Promise.all([...new Set(paths)].sort().map(fileIdentity));
  identities.push(await gitIdentity(projectPath));
  return createHash("sha256").update(identities.join("\n")).digest("hex");
}
