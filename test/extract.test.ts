import assert from "node:assert/strict";
import test from "node:test";

import { extractGraph } from "../src/extract.ts";
import { openCodeGraph } from "../src/open.ts";
import {
  createCodeGraphProject,
  insertEdge,
  insertFile,
  insertNode
} from "./fixtures.ts";

async function createExtractionFixture() {
  return createCodeGraphProject({
    populate(database) {
      insertFile(database, { path: "src/a.ts", nodeCount: 4, size: 120 });
      insertFile(database, {
        path: "src/b.ts",
        language: "TypeScript",
        nodeCount: 3,
        size: 240,
        indexedAt: "2026-08-04T13:00:00Z"
      });
      insertFile(database, { path: "src/empty.ts", nodeCount: 0, size: 0 });

      insertNode(database, { id: "file-a", kind: "file", name: "a.ts", filePath: "src/a.ts" });
      insertNode(database, { id: "import-a", kind: "import", name: "./b.ts", filePath: "src/a.ts" });
      insertNode(database, {
        id: "alpha", kind: "function", name: "alpha", qualifiedName: "alpha",
        filePath: "src/a.ts", startLine: 10, endLine: 14, signature: "alpha()"
      });
      insertNode(database, {
        id: "helper", kind: "function", name: "helper", qualifiedName: "helper",
        filePath: "src/a.ts", startLine: 20, endLine: 22
      });
      insertNode(database, { id: "file-b", kind: "file", name: "b.ts", filePath: "src/b.ts" });
      insertNode(database, {
        id: "beta", kind: "function", name: "beta", qualifiedName: "beta",
        filePath: "src/b.ts", startLine: 5, endLine: 8, signature: "beta(value)"
      });
      insertNode(database, {
        id: "Widget", kind: "class", name: "Widget", qualifiedName: "Widget",
        filePath: "src/b.ts", startLine: 12, endLine: 30
      });
      insertNode(database, {
        id: "ghost", kind: "function", name: "ghost", filePath: "src/ghost.ts"
      });

      insertEdge(database, "file-a", "alpha", "contains");
      insertEdge(database, "alpha", "helper", "calls");
      insertEdge(database, "alpha", "beta", "calls");
      insertEdge(database, "alpha", "beta", "calls");
      insertEdge(database, "helper", "beta", "references");
      insertEdge(database, "helper", "Widget", "instantiates");
      insertEdge(database, "alpha", "Widget", "extends");
      insertEdge(database, "alpha", "Widget", "extends");
      insertEdge(database, "beta", "alpha", "references");
      insertEdge(database, "alpha", "ghost", "calls");
      insertEdge(database, "missing", "beta", "calls");
    }
  });
}

test("extracts deterministic normalized files and symbols", async () => {
  const fixture = await createExtractionFixture();
  const opened = openCodeGraph(fixture.projectPath);
  const payload = extractGraph(opened);

  assert.deepEqual(payload.files, [
    { path: "src/a.ts", language: "TypeScript", size: 120, symbolCount: 2, errors: null },
    { path: "src/b.ts", language: "TypeScript", size: 240, symbolCount: 2, errors: null },
    { path: "src/empty.ts", language: "TypeScript", size: 0, symbolCount: 0, errors: null }
  ]);
  assert.deepEqual(payload.symbols, [
    {
      id: "alpha", kind: "function", name: "alpha", qualifiedName: "alpha",
      filePath: "src/a.ts", startLine: 10, endLine: 14, signature: "alpha()",
      degree: 2, callers: [], callees: [
        { id: "beta", name: "beta", filePath: "src/b.ts" },
        { id: "helper", name: "helper", filePath: "src/a.ts" }
      ], callerCount: 0, calleeCount: 2
    },
    {
      id: "helper", kind: "function", name: "helper", qualifiedName: "helper",
      filePath: "src/a.ts", startLine: 20, endLine: 22, signature: null,
      degree: 1, callers: [{ id: "alpha", name: "alpha", filePath: "src/a.ts" }],
      callees: [], callerCount: 1, calleeCount: 0
    },
    {
      id: "beta", kind: "function", name: "beta", qualifiedName: "beta",
      filePath: "src/b.ts", startLine: 5, endLine: 8, signature: "beta(value)",
      degree: 1, callers: [{ id: "alpha", name: "alpha", filePath: "src/a.ts" }],
      callees: [], callerCount: 1, calleeCount: 0
    },
    {
      id: "Widget", kind: "class", name: "Widget", qualifiedName: "Widget",
      filePath: "src/b.ts", startLine: 12, endLine: 30, signature: null,
      degree: 0, callers: [], callees: [], callerCount: 0, calleeCount: 0
    }
  ]);

  opened.close();
});

test("aggregates directed cross-file links and reports stats", async () => {
  const fixture = await createExtractionFixture();
  const opened = openCodeGraph(fixture.projectPath);
  const payload = extractGraph(opened);

  assert.deepEqual(payload.links, [
    { source: "src/a.ts", target: "src/b.ts", weight: 6, dominantKind: "calls", kinds: {
      calls: 2, extends: 2, instantiates: 1, references: 1
    } },
    { source: "src/b.ts", target: "src/a.ts", weight: 1, dominantKind: "references", kinds: {
      references: 1
    } }
  ]);
  assert.deepEqual(payload.stats, {
    fileCount: 3,
    symbolCount: 4,
    linkCount: 2,
    crossFileEdgeCount: 7,
    edgeKindCounts: { calls: 2, extends: 2, instantiates: 1, references: 2 },
    newestIndexedAt: "2026-08-04T13:00:00Z"
  });

  opened.close();
});

test("truncates related symbols while retaining unique counts", async () => {
  const fixture = await createCodeGraphProject({
    populate(database) {
      insertFile(database, { path: "src/many.ts", nodeCount: 13 });
      insertNode(database, {
        id: "root", kind: "function", name: "root", filePath: "src/many.ts"
      });

      for (let index = 0; index < 12; index += 1) {
        const suffix = String(index).padStart(2, "0");
        insertNode(database, {
          id: `target-${suffix}`,
          kind: "function",
          name: `target${suffix}`,
          filePath: "src/many.ts"
        });
        insertEdge(database, "root", `target-${suffix}`, "calls");
      }
    }
  });
  const opened = openCodeGraph(fixture.projectPath);
  const first = extractGraph(opened);
  const second = extractGraph(opened);
  const root = first.symbols.find((symbol) => symbol.id === "root");
  assert.ok(root);

  assert.equal(root.calleeCount, 12);
  assert.equal(root.degree, 12);
  assert.equal(root.callees.length, 10);
  assert.deepEqual(
    root.callees.map(({ name }) => name),
    Array.from({ length: 10 }, (_, index) => `target${String(index).padStart(2, "0")}`)
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  opened.close();
});
