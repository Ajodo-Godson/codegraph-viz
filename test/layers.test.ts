import assert from "node:assert/strict";
import test from "node:test";

import { deriveLayers } from "../src/layers.ts";

test("derives ranked top-level layers and a root layer", () => {
  const files = [
    { path: "README.md" },
    { path: "src/a.ts" },
    { path: "src/b.ts" },
    { path: "test/a.ts" }
  ];
  const result = deriveLayers(files);

  assert.equal(result.byPath["README.md"], "root");
  assert.equal(result.byPath["src/a.ts"], "src");
  assert.deepEqual(result.layers.map(({ id, fileCount }) => ({ id, fileCount })), [
    { id: "src", fileCount: 2 },
    { id: "root", fileCount: 1 },
    { id: "test", fileCount: 1 }
  ]);
});

test("renames, merges, and pins layer colors", () => {
  const result = deriveLayers(
    [{ path: "src/a.ts" }, { path: "lib/b.ts" }, { path: "test/a.ts" }],
    {
      rename: { src: "application" },
      merge: { lib: "application" },
      colors: { application: "#123abc" }
    }
  );

  assert.equal(result.byPath["src/a.ts"], "application");
  assert.equal(result.byPath["lib/b.ts"], "application");
  assert.equal(result.layers.find(({ id }) => id === "application")?.color, "#123abc");
});

test("rejects malformed layer configuration", () => {
  assert.throws(
    () => deriveLayers([{ path: "src/a.ts" }], { colors: { src: "red" } }),
    /valid hex color/
  );
});
