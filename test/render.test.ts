import assert from "node:assert/strict";
import test from "node:test";

import { renderGraph } from "../src/render.ts";
import type { PreparedGraph } from "../src/granularity.ts";

function graphFixture(): PreparedGraph {
  return {
    level: "file",
    nodes: [{
      id: "src/</script><img src=x>.ts",
      label: "</script><img src=x>",
      path: "src/</script><img src=x>.ts",
      type: "file",
      layer: "src",
      language: "TypeScript",
      size: 100,
      symbolCount: 1,
      fileCount: 1,
      degree: 2,
      errors: null
    }],
    links: [],
    files: [],
    symbols: [{
      id: "danger", kind: "function", name: "<danger>",
      qualifiedName: "<danger>", filePath: "src/</script><img src=x>.ts",
      startLine: 1, endLine: 2, signature: "danger()", degree: 0,
      callers: [], callees: [], callerCount: 0, calleeCount: 0
    }],
    layers: [{ id: "src", label: "src", fileCount: 1, color: "#2563eb" }],
    sourceStats: {
      fileCount: 1, symbolCount: 1, linkCount: 0, crossFileEdgeCount: 0,
      edgeKindCounts: {}, newestIndexedAt: "2026-08-04T13:00:00Z"
    },
    report: {
      totalNodes: 10, shownNodes: 1, droppedNodes: 9,
      totalLinks: 3, shownLinks: 0, droppedLinks: 3, pruned: true
    },
    provenance: [
      {
        id: "edit", timestamp: "2026-08-04T12:00:30.000Z", provider: "codex",
        runId: "run-1", agentId: "child", parentAgentId: "root", taskId: "task-1",
        kind: "file_edited", knownKind: true,
        target: { type: "file", path: "src/</script><img src=x>.ts" },
        summary: "Edited parser fixture", sourceRef: "fixture", metadata: {}
      },
      {
        id: "spawn", timestamp: "2026-08-04T12:00:00.000Z", provider: "codex",
        runId: "run-1", agentId: "child", parentAgentId: "root", taskId: "task-1",
        kind: "agent_spawned", knownKind: true, target: { type: "task", value: "Inspect parser" },
        summary: "Delegated parser inspection", sourceRef: "fixture", metadata: {}
      },
      {
        id: "knowledge", timestamp: "2026-08-04T12:01:00.000Z", provider: "codex",
        runId: "run-1", agentId: "child", parentAgentId: "root", taskId: "task-1",
        kind: "knowledge_reported", knownKind: true,
        target: { type: "file", path: "src/</script><img src=x>.ts" },
        summary: "Parser uses a read transaction", sourceRef: "fixture", metadata: {}
      }
    ],
    git: {
      root: "/repo", branch: "feature", head: "abc123", recentCommits: [],
      changes: [{ path: "src/</script><img src=x>.ts", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, additions: 2, deletions: 1 }]
    },
    correlations: [{
      path: "src/</script><img src=x>.ts", commitShas: [], eventIds: ["codex\0run-1\0edit"], agentIds: ["child"],
      attributions: [{ agentId: "child", eventIds: ["codex\0run-1\0edit"], reasons: ["explicit_file_edit"] }],
      attributionStatus: "attributed", multipleContributors: false, concurrentConflict: false,
      symbolIds: ["danger"], evidence: ["explicit_event_target"], overlappingAgents: false,
      states: { inspected: true, proposed: false, modified: true, tested: false, committed: false, reviewed: false, prOpened: false }
    }]
  };
}

test("renders a self-contained page with safely embedded payload", () => {
  const html = renderGraph(graphFixture(), { generatedAt: "2026-08-04T14:00:00Z" });
  const payloadMatch = html.match(/<script id="graph-data" type="application\/json">([^]*?)<\/script>/);

  assert.ok(payloadMatch);
  assert.doesNotMatch(payloadMatch[1], /</);
  assert.equal(JSON.parse(payloadMatch[1]).nodes[0].label, "</script><img src=x>");
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<link\b/i);
});

test("includes interaction, completeness, theme, and accessibility controls", () => {
  const html = renderGraph(graphFixture(), { generatedAt: "2026-08-04T14:00:00Z" });

  assert.match(html, /id="graph-canvas"/);
  assert.match(html, /id="search"/);
  assert.match(html, /id="layer-filters"/);
  assert.match(html, /id="edge-filters"/);
  assert.match(html, /id="detail-panel"/);
  assert.match(html, /Showing 1 of 10 file nodes/);
  assert.match(html, /Generated 2026-08-04T14:00:00Z/);
  assert.match(html, /Newest index 2026-08-04T13:00:00Z/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /overflow-x: hidden/);
  assert.match(html, /aria-label="Code graph"/);
});

test("includes multi-agent views and provenance filters", () => {
  const html = renderGraph(graphFixture(), { generatedAt: "2026-08-04T14:00:00Z" });

  for (const view of ["code", "agents", "timeline", "changes", "knowledge", "review"]) {
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
  for (const filter of ["run-filter", "agent-filter", "task-filter", "provider-filter", "status-filter", "time-from", "time-to"]) {
    assert.match(html, new RegExp(`id="${filter}"`));
  }
  assert.match(html, /id="secondary-view"/);
  assert.match(html, /renderAgentView/);
  assert.match(html, /renderTimelineView/);
  assert.match(html, /renderChangesView/);
  assert.match(html, /renderKnowledgeView/);
  assert.match(html, /renderReviewView/);
});

test("explains evidence requirements and accepts committed change history defensively", () => {
  const html = renderGraph(graphFixture(), { generatedAt: "2026-08-04T14:00:00Z" });

  assert.match(html, /commit\.changes \|\| commit\.files/);
  assert.match(html, /No working-tree or recent committed changes are available/);
  assert.match(html, /Knowledge appears only when traces record a knowledge_reported event/);
  assert.match(html, /Review status requires explicit trace evidence or clearly labeled PR-level approval/);
  assert.match(html, /No review evidence or changed files are available/);
});

test("supports clickable agent contributions and consistent filter navigation", () => {
  const html = renderGraph(graphFixture(), { generatedAt: "2026-08-04T14:00:00Z" });

  assert.match(html, /element\("button", undefined, "card agent-card"\)/);
  assert.match(html, /function selectAgent/);
  assert.match(html, /function showAgentDetails/);
  assert.match(html, /function agentContributionPaths/);
  assert.match(html, /URLSearchParams\(location\.hash\.slice\(1\)\)/);
  assert.match(html, /addEventListener\("hashchange"/);
  assert.match(html, /taskAgents/);
  assert.match(html, /const reviewPaths = filtersActive\(\)/);
  assert.match(html, /activityFilters\.agent\.value = ""/);
  assert.match(html, /showDefaultDetails\(\)/);
  assert.match(html, /id="full-graph"/);
  assert.match(html, /function clearActivityFilters/);
  assert.match(html, /selected = null/);
  assert.match(html, /function resetGraphFilters/);
  assert.match(html, /function showUnindexedContribution/);
  assert.match(html, /not present in the current CodeGraph index/);
  assert.match(html, /setView\("code"\)/);
});
