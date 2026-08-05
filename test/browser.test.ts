import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import type { PreparedGraph } from "../src/granularity.ts";
import { renderGraph } from "../src/render.ts";

function browserGraphFixture(): PreparedGraph {
  return {
    level: "file",
    nodes: [
      {
        id: "src/alpha.ts", label: "alpha.ts", path: "src/alpha.ts", type: "file",
        layer: "src", language: "TypeScript", size: 100, symbolCount: 1,
        fileCount: 1, degree: 1, errors: null
      },
      {
        id: "src/beta.ts", label: "beta.ts", path: "src/beta.ts", type: "file",
        layer: "src", language: "TypeScript", size: 80, symbolCount: 1,
        fileCount: 1, degree: 1, errors: null
      }
    ],
    links: [{
      source: "src/alpha.ts", target: "src/beta.ts", weight: 1,
      dominantKind: "calls", kinds: { calls: 1 }
    }],
    files: [
      { path: "src/alpha.ts", language: "TypeScript", size: 100, symbolCount: 1, errors: null },
      { path: "src/beta.ts", language: "TypeScript", size: 80, symbolCount: 1, errors: null }
    ],
    symbols: [
      {
        id: "alpha", kind: "function", name: "alpha", qualifiedName: "alpha",
        filePath: "src/alpha.ts", startLine: 1, endLine: 3, signature: "alpha()",
        degree: 1, callers: [], callees: [{ id: "beta", name: "beta", filePath: "src/beta.ts" }],
        callerCount: 0, calleeCount: 1
      },
      {
        id: "beta", kind: "function", name: "beta", qualifiedName: "beta",
        filePath: "src/beta.ts", startLine: 1, endLine: 3, signature: "beta()",
        degree: 1, callers: [{ id: "alpha", name: "alpha", filePath: "src/alpha.ts" }],
        callees: [], callerCount: 1, calleeCount: 0
      }
    ],
    layers: [{ id: "src", label: "src", fileCount: 2, color: "#2563eb" }],
    sourceStats: {
      fileCount: 2, symbolCount: 2, linkCount: 1, crossFileEdgeCount: 1,
      edgeKindCounts: { calls: 1 }, newestIndexedAt: "2026-08-04T13:00:00Z"
    },
    report: {
      totalNodes: 2, shownNodes: 2, droppedNodes: 0,
      totalLinks: 1, shownLinks: 1, droppedLinks: 0, pruned: false
    },
    provenance: [
      {
        id: "root-start", timestamp: "2026-08-04T12:00:00.000Z", provider: "codex",
        runId: "run-1", agentId: "root", parentAgentId: null, taskId: null,
        kind: "run_started", knownKind: true, target: null, summary: "Root run started",
        sourceRef: "fixture", metadata: {}
      },
      {
        id: "spawn", timestamp: "2026-08-04T12:01:00.000Z", provider: "codex",
        runId: "run-1", agentId: "/root/worker", parentAgentId: "root", taskId: "task-worker",
        kind: "agent_spawned", knownKind: true,
        target: { type: "task", value: "Inspect alpha" }, summary: "Worker delegated",
        sourceRef: "fixture", metadata: {}
      },
      {
        id: "edit", timestamp: "2026-08-04T12:02:00.000Z", provider: "codex",
        runId: "run-1", agentId: "/root/worker", parentAgentId: "root", taskId: null,
        kind: "file_edited", knownKind: true, target: { type: "file", path: "src/alpha.ts" },
        summary: "Updated alpha", sourceRef: "fixture", metadata: {}
      },
      {
        id: "knowledge", timestamp: "2026-08-04T12:03:00.000Z", provider: "codex",
        runId: "run-1", agentId: "/root/worker", parentAgentId: "root", taskId: null,
        kind: "knowledge_reported", knownKind: true, target: { type: "file", path: "src/alpha.ts" },
        summary: "Alpha delegates to beta", sourceRef: "fixture", metadata: {}
      }
    ],
    git: {
      root: "/fixture", branch: "feature/browser-test", head: "abc123",
      changes: [
        {
          path: "src/alpha.ts", indexStatus: " ", worktreeStatus: "M", staged: false,
          unstaged: true, additions: 2, deletions: 1
        },
        {
          path: "src/beta.ts", indexStatus: " ", worktreeStatus: "M", staged: false,
          unstaged: true, additions: 1, deletions: 0
        }
      ],
      recentCommits: []
    },
    github: {
      pullRequest: {
        number: 12, url: "https://github.com/example/codegraph-viz/pull/12", state: "OPEN",
        isDraft: false, mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED",
        checks: [
          { name: "CI", status: "COMPLETED", conclusion: "FAILURE", url: null },
          { name: "legacy", status: "ERROR", conclusion: null, url: null }
        ],
        reviews: [{ author: "reviewer", state: "COMMENTED", submittedAt: "2026-08-04T13:00:00Z" }],
        unresolvedReviewThreads: 2
      },
      diagnostics: ["Some GitHub evidence is unavailable."]
    },
    correlations: [
      {
        path: "src/alpha.ts", commitShas: [], eventIds: ["edit", "knowledge"],
        agentIds: ["/root/worker"], symbolIds: ["alpha"], evidence: ["explicit_event_target"],
        overlappingAgents: false,
        states: {
          inspected: true, proposed: false, modified: true, tested: false,
          committed: false, reviewed: false, prOpened: false
        }
      },
      {
        path: "test/browser.test.ts", commitShas: [], eventIds: [],
        agentIds: ["/root/worker"], symbolIds: [], evidence: ["explicit_event_target"],
        overlappingAgents: false,
        states: {
          inspected: true, proposed: false, modified: false, tested: false,
          committed: false, reviewed: false, prOpened: false
        }
      }
    ]
  };
}

async function selectView(page: Page, name: string): Promise<void> {
  const tab = page.locator(`.view-tab[data-view="${name}"]`);
  await tab.click();
  await assert.doesNotReject(() => tab.getAttribute("aria-selected").then((value) => assert.equal(value, "true")));
}

test("offline visualization supports complete agent drill-down and recovery", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codegraph-browser-"));
  const outputPath = join(directory, "map.html");
  await writeFile(outputPath, renderGraph(browserGraphFixture(), { generatedAt: "2026-08-04T14:00:00Z" }));

  let browser: Browser | undefined;
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().startsWith("file:")) externalRequests.push(request.url());
    });
    await page.goto(`file://${outputPath}`);
    await page.locator("#graph-canvas").waitFor({ state: "visible" });
    assert.equal(await page.locator('.view-tab[data-view="code"]').getAttribute("aria-selected"), "true");

    await selectView(page, "agents");
    const worker = page.locator('.agent-card[data-agent-id="/root/worker"]');
    await worker.click();
    assert.equal(new URL(page.url()).hash, "#agent=%2Froot%2Fworker");
    assert.equal(await worker.getAttribute("aria-pressed"), "true");
    await assert.doesNotReject(() => page.locator("#detail-panel").getByText("Agent contribution").waitFor());
    await assert.doesNotReject(() => page.locator("#detail-panel").getByRole("button", { name: "src/alpha.ts" }).waitFor());
    await page.locator("#detail-panel").getByRole("button", { name: /test\/browser\.test\.ts.*not indexed/ }).click();
    assert.equal(await page.locator('.view-tab[data-view="agents"]').getAttribute("aria-selected"), "true");
    assert.match(await page.locator("#detail-panel").innerText(), /not present in the current CodeGraph index/);
    await page.locator("#detail-panel").getByRole("button", { name: "Back to agent contributions" }).click();
    await assert.doesNotReject(() => page.locator("#detail-panel").getByRole("button", { name: "src/alpha.ts" }).waitFor());

    await selectView(page, "timeline");
    assert.match(await page.locator("#secondary-view").innerText(), /3 events in chronological order/);
    assert.doesNotMatch(await page.locator("#secondary-view").innerText(), /Root run started/);
    assert.equal(await page.locator("#agent-filter").inputValue(), "/root/worker");

    await selectView(page, "knowledge");
    assert.match(await page.locator("#secondary-view").innerText(), /Alpha delegates to beta/);
    assert.equal(await page.locator("#agent-filter").inputValue(), "/root/worker");

    await selectView(page, "changes");
    const filteredChanges = await page.locator("#secondary-view").innerText();
    assert.match(filteredChanges, /1 working-tree and 0 recent committed changes/);
    assert.match(filteredChanges, /src\/alpha\.ts/);
    assert.doesNotMatch(filteredChanges, /src\/beta\.ts/);

    await selectView(page, "review");
    const filteredReview = await page.locator("#secondary-view").innerText();
    assert.match(filteredReview, /1\s+Untested/);
    assert.match(filteredReview, /1\s+Unreviewed/);
    assert.match(filteredReview, /1\s+Uncommitted/);
    assert.match(filteredReview, /src\/alpha\.ts/);
    assert.match(filteredReview, /Pull request #12/);
    assert.match(filteredReview, /2 checks \| 2 failing \| 1 reviews \| 2 unresolved threads/);
    assert.match(filteredReview, /Some GitHub evidence is unavailable/);
    assert.doesNotMatch(filteredReview, /src\/beta\.ts/);

    await page.locator("#detail-panel").getByRole("button", { name: "src/alpha.ts" }).click();
    assert.equal(await page.locator('.view-tab[data-view="code"]').getAttribute("aria-selected"), "true");
    assert.match(await page.locator("#detail-panel").innerText(), /alpha\.ts/);
    assert.equal(new URL(page.url()).hash, "#agent=%2Froot%2Fworker");
    await page.locator("#layer-filters input").first().uncheck();
    await page.locator("#edge-filters input").first().uncheck();

    await page.locator("#full-graph").click();
    assert.equal(await page.locator("#agent-filter").inputValue(), "");
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(await page.locator('.view-tab[data-view="code"]').getAttribute("aria-selected"), "true");
    await assert.doesNotReject(() => page.locator("#graph-canvas").waitFor({ state: "visible" }));
    assert.match(await page.locator("#detail-panel").innerText(), /Select a node or agent/);
    assert.equal(await page.locator("#layer-filters input:not(:checked)").count(), 0);
    assert.equal(await page.locator("#edge-filters input:not(:checked)").count(), 0);

    await selectView(page, "agents");
    assert.match(await page.locator("#secondary-view").innerText(), /2 agents across 1 runs/);
    await page.locator('.agent-card[data-agent-id="/root/worker"]').click();
    await page.locator("#clear-agent-filters").click();
    assert.equal(await page.locator("#agent-filter").inputValue(), "");
    assert.equal(new URL(page.url()).hash, "");

    await page.locator("#task-filter").selectOption("task-worker");
    await selectView(page, "timeline");
    const taskTimeline = await page.locator("#secondary-view").innerText();
    assert.match(taskTimeline, /3 events in chronological order/);
    assert.match(taskTimeline, /Updated alpha/);
    assert.match(taskTimeline, /Alpha delegates to beta/);
    assert.doesNotMatch(taskTimeline, /Root run started/);
    await page.locator("#clear-agent-filters").click();

    await selectView(page, "agents");
    await page.locator("#provider-filter").selectOption("codex");
    assert.match(await page.locator("#activity-status").innerText(), /4 of 4 events/);
    await page.locator("#status-filter").selectOption("knowledge_reported");
    assert.match(await page.locator("#activity-status").innerText(), /1 of 4 events/);
    assert.match(await page.locator("#secondary-view").innerText(), /1 agents across 1 runs/);
    await page.locator("#clear-agent-filters").click();

    await page.evaluate(() => { location.hash = "agent=missing-agent"; });
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#agent-filter")?.value === "");
    assert.match(await page.locator("#detail-panel").innerText(), /Select a node or agent/);
    await page.evaluate(() => { location.hash = ""; });
    await page.waitForFunction(() => location.hash === "");
    assert.equal(await page.locator("#agent-filter").inputValue(), "");

    await page.locator("#theme-toggle").click();
    const firstTheme = await page.locator("html").getAttribute("data-theme");
    await page.locator("#theme-toggle").click();
    const secondTheme = await page.locator("html").getAttribute("data-theme");
    assert.ok(firstTheme === "light" || firstTheme === "dark");
    assert.ok(secondTheme === "light" || secondTheme === "dark");
    assert.notEqual(firstTheme, secondTheme);

    const screenshots = [];
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const screenshotPath = join(directory, `${theme}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const screenshot = await readFile(screenshotPath);
      assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(screenshot.length > 1_000, `${theme} screenshot is unexpectedly small`);
      screenshots.push(screenshot);
    }
    assert.notDeepEqual(screenshots[0], screenshots[1]);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `Page has ${overflow}px of horizontal overflow`);
    await page.setViewportSize({ width: 390, height: 844 });
    const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(narrowOverflow <= 0, `Narrow page has ${narrowOverflow}px of horizontal overflow`);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
