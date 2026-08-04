import { execFileSync } from "node:child_process";

import type { GitChange, GitCommit, GitCommitChange, GitSnapshot } from "./types.ts";

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
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const [added = "-", deleted = "-", ...pathParts] = entry.split("\t");
    let path = pathParts.join("\t");
    if (!path) {
      index += 2;
      path = entries[index] ?? "";
    }
    if (!path) continue;
    result.set(path, {
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted)
    });
  }
  return result;
}

function parseChanges(status: string, numstat: Map<string, { additions: number | null; deletions: number | null }>): GitChange[] {
  const changes: GitChange[] = [];
  const entries = status.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const indexStatus = entry[0] ?? " ";
    const worktreeStatus = entry[1] ?? " ";
    const path = entry.slice(3);
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      index += 1;
    }
    const counts = numstat.get(path);
    changes.push({
      path,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: worktreeStatus !== " " || indexStatus === "?",
      additions: counts?.additions ?? null,
      deletions: counts?.deletions ?? null
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function parseCommits(output: string): Omit<GitCommit, "changes">[] {
  return output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha = "", author = "", timestamp = "", subject = ""] = record.split("\0");
    return { sha, author, timestamp, subject };
  });
}

function commitChanges(root: string, sha: string): GitCommitChange[] {
  const output = git(root, ["show", "--format=", "--numstat", "-z", "--find-renames", sha], true, false);
  return [...parseNumstat(output)].map(([path, counts]) => ({ path, ...counts }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function inspectGit(projectPath: string, commitLimit = 20): GitSnapshot {
  const root = git(projectPath, ["rev-parse", "--show-toplevel"]);
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true) || null;
  const head = git(root, ["rev-parse", "--verify", "HEAD"], true) || null;
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false, false);
  const numstat = git(root, ["diff", "--numstat", "-z", "HEAD"], true, false);
  const log = git(root, ["log", `-${commitLimit}`, "--format=%H%x00%an%x00%aI%x00%s%x1e"], true);
  const recentCommits = parseCommits(log).map((commit) => ({
    ...commit,
    changes: commitChanges(root, commit.sha)
  }));
  return { root, branch, head, changes: parseChanges(status, parseNumstat(numstat)), recentCommits };
}
