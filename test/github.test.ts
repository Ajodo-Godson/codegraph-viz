import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectGitHub, parsePullRequestEvidence, parseUnresolvedReviewThreads,
  type GitHubCommandRunner
} from "../src/github.ts";

test("parses pull request, checks, and reviews without retaining bodies", () => {
  const evidence = parsePullRequestEvidence({
    number: 42, url: "https://github.com/example/project/pull/42", state: "OPEN", isDraft: false,
    mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.test/check" },
      { context: "lint", state: "SUCCESS", targetUrl: "https://example.test/lint" }
    ],
    reviews: [{ author: { login: "reviewer" }, state: "APPROVED", submittedAt: "2026-08-04T00:00:00Z", body: "private review body" }]
  });
  assert.deepEqual(evidence, {
    number: 42, url: "https://github.com/example/project/pull/42", state: "OPEN", isDraft: false,
    mergeState: "CLEAN", reviewDecision: "APPROVED",
    checks: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS", url: "https://example.test/check" },
      { name: "lint", status: "SUCCESS", conclusion: null, url: "https://example.test/lint" }
    ],
    reviews: [{ author: "reviewer", state: "APPROVED", submittedAt: "2026-08-04T00:00:00Z" }],
    unresolvedReviewThreads: null
  });
  assert.ok(!JSON.stringify(evidence).includes("private review body"));
});

test("parses only explicitly unresolved review threads", () => {
  assert.equal(parseUnresolvedReviewThreads({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { isResolved: false }, { isResolved: true }, { isResolved: false }
  ] } } } } }), 2);
  assert.equal(parseUnresolvedReviewThreads({}), null);
});

test("inspects the current branch with an injectable read-only gh runner", async () => {
  const calls: string[][] = [];
  const runner: GitHubCommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "pr") return JSON.stringify({ number: 7, url: "https://github.com/acme/widget/pull/7", state: "OPEN", isDraft: true });
    return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }] } } } } });
  };
  const result = await inspectGitHub("/project", runner);
  assert.equal(result.pullRequest?.unresolvedReviewThreads, 1);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [["gh", "pr", "view"], ["gh", "api", "graphql"]]);
});

test("returns safe diagnostics when gh or a branch pull request is unavailable", async () => {
  const runner: GitHubCommandRunner = async () => { throw new Error("secret authentication output"); };
  const result = await inspectGitHub("/project", runner);
  assert.deepEqual(result, {
    pullRequest: null,
    diagnostics: ["GitHub pull request evidence is unavailable for the current branch."]
  });
  assert.ok(!JSON.stringify(result).includes("secret"));
});
