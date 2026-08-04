import assert from "node:assert/strict";
import test from "node:test";

import { renderGraph } from "../src/render.js";

function graphFixture() {
  return {
    level: "file",
    nodes: [{
      id: "src/</script><img src=x>.js",
      label: "</script><img src=x>",
      path: "src/</script><img src=x>.js",
      type: "file",
      layer: "src",
      language: "JavaScript",
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
      qualifiedName: "<danger>", filePath: "src/</script><img src=x>.js",
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
    }
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
