import { execFile } from "node:child_process";
import type { GitHubEvidenceResult, GitHubPullRequestEvidence } from "./types.ts";

export type GitHubCommandRunner = (command: string, args: string[], cwd: string) => Promise<string>;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJson(output: string): unknown {
  return JSON.parse(output) as unknown;
}

function defaultRunner(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function parsePullRequestEvidence(value: unknown): GitHubPullRequestEvidence | null {
  const item = record(value);
  const number = typeof item.number === "number" && Number.isInteger(item.number) ? item.number : null;
  const url = text(item.url);
  const state = text(item.state);
  if (number === null || number < 1 || !url || !state) return null;
  const checks = (Array.isArray(item.statusCheckRollup) ? item.statusCheckRollup : []).flatMap((raw) => {
    const check = record(raw);
    const name = text(check.name) ?? text(check.context);
    const status = text(check.status) ?? text(check.state);
    if (!name || !status) return [];
    return [{
      name,
      status,
      conclusion: text(check.conclusion),
      url: text(check.detailsUrl) ?? text(check.targetUrl)
    }];
  });
  const reviews = (Array.isArray(item.reviews) ? item.reviews : []).flatMap((raw) => {
    const review = record(raw);
    const state = text(review.state);
    if (!state) return [];
    return [{ author: text(record(review.author).login), state, submittedAt: text(review.submittedAt) }];
  });
  return {
    number,
    url,
    state,
    isDraft: item.isDraft === true,
    mergeState: text(item.mergeStateStatus),
    reviewDecision: text(item.reviewDecision),
    checks,
    reviews,
    unresolvedReviewThreads: null
  };
}

export function parseUnresolvedReviewThreads(value: unknown): number | null {
  const data = record(record(value).data);
  const repository = record(data.repository);
  const pullRequest = record(repository.pullRequest);
  const threads = record(pullRequest.reviewThreads);
  if (record(threads.pageInfo).hasNextPage === true) return null;
  if (!Array.isArray(threads.nodes)) return null;
  return threads.nodes.reduce((count, raw) => count + (record(raw).isResolved === false ? 1 : 0), 0);
}

function repositoryFromUrl(url: string): { owner: string; name: string } | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length >= 4 && parts[2] === "pull" ? { owner: parts[0]!, name: parts[1]! } : null;
  } catch {
    return null;
  }
}

interface ReviewThreadPage {
  unresolved: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

function parseReviewThreadPage(value: unknown): ReviewThreadPage | null {
  const threads = record(record(record(record(record(value).data).repository).pullRequest).reviewThreads);
  if (!Array.isArray(threads.nodes)) return null;
  const pageInfo = record(threads.pageInfo);
  return {
    unresolved: threads.nodes.reduce((count, raw) => count + (record(raw).isResolved === false ? 1 : 0), 0),
    hasNextPage: pageInfo.hasNextPage === true,
    endCursor: text(pageInfo.endCursor)
  };
}

const THREAD_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{isResolved}}}}}`;

export async function inspectGitHub(
  projectPath: string,
  runner: GitHubCommandRunner = defaultRunner
): Promise<GitHubEvidenceResult> {
  const diagnostics: string[] = [];
  let pullRequest: GitHubPullRequestEvidence | null;
  try {
    const output = await runner("gh", ["pr", "view", "--json", "number,url,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,reviews"], projectPath);
    pullRequest = parsePullRequestEvidence(parseJson(output));
    if (!pullRequest) return { pullRequest: null, diagnostics: ["GitHub returned an unsupported pull request response."] };
  } catch {
    return { pullRequest: null, diagnostics: ["GitHub pull request evidence is unavailable for the current branch."] };
  }

  const repository = repositoryFromUrl(pullRequest.url);
  if (!repository) {
    diagnostics.push("Could not determine the GitHub repository for review threads.");
    return { pullRequest, diagnostics };
  }
  try {
    let cursor: string | null = null;
    let unresolved = 0;
    do {
      const args = ["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-F", `owner=${repository.owner}`, "-F", `name=${repository.name}`, "-F", `number=${pullRequest.number}`];
      if (cursor) args.push("-F", `cursor=${cursor}`);
      const page = parseReviewThreadPage(parseJson(await runner("gh", args, projectPath)));
      if (!page || (page.hasNextPage && !page.endCursor)) throw new Error("Incomplete review thread page");
      unresolved += page.unresolved;
      cursor = page.hasNextPage ? page.endCursor : null;
    } while (cursor);
    pullRequest.unresolvedReviewThreads = unresolved;
  } catch {
    diagnostics.push("GitHub review thread details were unavailable.");
  }
  return { pullRequest, diagnostics };
}
