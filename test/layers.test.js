import assert from "node:assert/strict";
import test from "node:test";

import { deriveLayers } from "../src/layers.js";

test("derives ranked top-level layers and a root layer", () => {
  const files = [
    { path: "README.md" },
    { path: "src/a.js" },
    { path: "src/b.js" },
    { path: "test/a.js" }
  ];
  const result = deriveLayers(files);

  assert.equal(result.byPath["README.md"], "root");
  assert.equal(result.byPath["src/a.js"], "src");
  assert.deepEqual(result.layers.map(({ id, fileCount }) => ({ id, fileCount })), [
    { id: "src", fileCount: 2 },
    { id: "root", fileCount: 1 },
    { id: "test", fileCount: 1 }
  ]);
});

test("renames, merges, and pins layer colors", () => {
  const result = deriveLayers(
    [{ path: "src/a.js" }, { path: "lib/b.js" }, { path: "test/a.js" }],
    {
      rename: { src: "application" },
      merge: { lib: "application" },
      colors: { application: "#123abc" }
    }
  );

  assert.equal(result.byPath["src/a.js"], "application");
  assert.equal(result.byPath["lib/b.js"], "application");
  assert.equal(result.layers.find(({ id }) => id === "application").color, "#123abc");
});

test("rejects malformed layer configuration", () => {
  assert.throws(
    () => deriveLayers([{ path: "src/a.js" }], { colors: { src: "red" } }),
    /valid hex color/
  );
});
