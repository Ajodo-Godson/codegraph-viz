import assert from "node:assert/strict";
import test from "node:test";

import { prepareGraph } from "../src/granularity.js";

function payload(files, links = [], symbols = []) {
  return {
    files,
    links,
    symbols,
    stats: {
      fileCount: files.length,
      symbolCount: symbols.length,
      linkCount: links.length,
      crossFileEdgeCount: links.reduce((sum, link) => sum + link.weight, 0),
      edgeKindCounts: {},
      newestIndexedAt: "2026-08-04T13:00:00Z"
    }
  };
}

const files = [
  { path: "README.md", language: "Markdown", size: 10, symbolCount: 0, errors: null },
  { path: "src/a.js", language: "JavaScript", size: 20, symbolCount: 2, errors: null },
  { path: "src/b.js", language: "JavaScript", size: 30, symbolCount: 1, errors: null },
  { path: "test/a.test.js", language: "JavaScript", size: 40, symbolCount: 1, errors: null }
];

const links = [
  { source: "src/a.js", target: "src/b.js", weight: 3, dominantKind: "calls", kinds: { calls: 3 } },
  { source: "src/b.js", target: "test/a.test.js", weight: 2, dominantKind: "imports", kinds: { imports: 2 } },
  { source: "test/a.test.js", target: "src/a.js", weight: 1, dominantKind: "calls", kinds: { calls: 1 } }
];

test("auto selects file level at 400 files and directory level above it", () => {
  const small = payload(Array.from({ length: 400 }, (_, index) => ({
    path: `src/file-${index}.js`, language: "JavaScript", size: 1,
    symbolCount: 0, errors: null
  })));
  const large = payload(Array.from({ length: 401 }, (_, index) => ({
    path: `group-${index}/file.js`, language: "JavaScript", size: 1,
    symbolCount: 0, errors: null
  })));

  assert.equal(prepareGraph(small).level, "file");
  assert.equal(prepareGraph(large).level, "directory");
});

test("aggregates files and directed links at directory level", () => {
  const graph = prepareGraph(payload(files, links), { level: "directory" });

  assert.deepEqual(graph.nodes.map(({ id, fileCount, symbolCount }) => ({
    id, fileCount, symbolCount
  })), [
    { id: "(root)", fileCount: 1, symbolCount: 0 },
    { id: "src", fileCount: 2, symbolCount: 3 },
    { id: "test", fileCount: 1, symbolCount: 1 }
  ]);
  assert.deepEqual(graph.links, [
    { source: "src", target: "test", weight: 2, dominantKind: "imports", kinds: { imports: 2 } },
    { source: "test", target: "src", weight: 1, dominantKind: "calls", kinds: { calls: 1 } }
  ]);
  assert.deepEqual(graph.report, {
    totalNodes: 3, shownNodes: 3, droppedNodes: 0,
    totalLinks: 2, shownLinks: 2, droppedLinks: 0,
    pruned: false
  });
});

test("prunes by weighted degree with stable ID tie-breaking", () => {
  const graph = prepareGraph(payload(files, links), { level: "file", maxNodes: 2 });

  assert.deepEqual(graph.nodes.map(({ id }) => id), ["src/a.js", "src/b.js"]);
  assert.deepEqual(graph.links, [links[0]]);
  assert.deepEqual(graph.report, {
    totalNodes: 4, shownNodes: 2, droppedNodes: 2,
    totalLinks: 3, shownLinks: 1, droppedLinks: 2,
    pruned: true
  });
});

test("symbol level requires an explicitly filtered subgraph", () => {
  assert.throws(
    () => prepareGraph(payload(files, links), { level: "symbol" }),
    /requires at least one filter path/
  );
});

test("symbol level uses complete call links inside the filtered subgraph", () => {
  const symbols = [
    { id: "a", name: "a", filePath: "src/a.js", kind: "function", startLine: 1, endLine: 2 },
    { id: "b", name: "b", filePath: "src/b.js", kind: "function", startLine: 1, endLine: 2 },
    { id: "test", name: "test", filePath: "test/a.js", kind: "function", startLine: 1, endLine: 2 }
  ];
  const input = payload(files, links, symbols);
  input.symbolLinks = [
    { source: "a", target: "b", weight: 2 },
    { source: "test", target: "a", weight: 1 }
  ];
  const graph = prepareGraph(input, { level: "symbol", filterPaths: ["src"] });

  assert.deepEqual(graph.nodes.map(({ id }) => id), ["a", "b"]);
  assert.deepEqual(graph.links, [
    { source: "a", target: "b", weight: 2, dominantKind: "calls", kinds: { calls: 2 } }
  ]);
});
