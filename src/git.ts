import { execFileSync } from "node:child_process";

import type { GitChange, GitCommit, GitSnapshot } from "./types.ts";

function git(cwd: string, args: string[], allowFailure = false, trimStart = true): string {
  try {
    const output = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return trimStart ? output.trim() : output.trimEnd();
  } catch (error) {
    if (allowFailure) return "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to inspect Git repository at ${cwd}: ${message}`, { cause: error });
  }
}

function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const result = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    result.set(path, {
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted)
    });
  }
  return result;
}

function parseChanges(status: string, numstat: Map<string, { additions: number | null; deletions: number | null }>): GitChange[] {
  return status.split("\n").filter(Boolean).map((line) => {
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    const rawPath = line.slice(3);
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    const counts = numstat.get(path);
    return {
      path,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: worktreeStatus !== " " || indexStatus === "?",
      additions: counts?.additions ?? null,
      deletions: counts?.deletions ?? null
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function parseCommits(output: string): GitCommit[] {
  return output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha = "", author = "", timestamp = "", subject = ""] = record.split("\0");
    return { sha, author, timestamp, subject };
  });
}

export function inspectGit(projectPath: string, commitLimit = 20): GitSnapshot {
  const root = git(projectPath, ["rev-parse", "--show-toplevel"]);
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true) || null;
  const head = git(root, ["rev-parse", "--verify", "HEAD"], true) || null;
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], false, false);
  const numstat = git(root, ["diff", "--numstat", "HEAD"], true);
  const log = git(root, ["log", `-${commitLimit}`, "--format=%H%x00%an%x00%aI%x00%s%x1e"], true);
  return { root, branch, head, changes: parseChanges(status, parseNumstat(numstat)), recentCommits: parseCommits(log) };
}
