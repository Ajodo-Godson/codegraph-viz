import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { openCodeGraph } from "../src/open.ts";

async function createProject({ schemaVersion = 8, indexState = "complete" } = {}) {
  const projectPath = await mkdtemp(join(tmpdir(), "codegraph-viz-"));
  const indexPath = join(projectPath, ".codegraph");
  const databasePath = join(indexPath, "codegraph.db");
  await mkdir(indexPath);

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT,
      description TEXT
    );
    CREATE TABLE project_metadata (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      indexed_at TEXT
    );
  `);
  database.prepare("INSERT INTO schema_versions(version) VALUES (?)").run(schemaVersion);
  database.prepare(
    "INSERT INTO project_metadata(key, value) VALUES ('index_state', ?)"
  ).run(indexState);
  database.prepare(
    "INSERT INTO files(path, indexed_at) VALUES ('src/index.ts', '2026-08-04T12:00:00Z')"
  ).run();
  database.close();

  return { projectPath, databasePath };
}

test("opens a schema 8 CodeGraph database read-only", async () => {
  const fixture = await createProject();
  const opened = openCodeGraph(fixture.projectPath);

  assert.equal(opened.path, fixture.databasePath);
  assert.equal(opened.schemaVersion, 8);
  assert.equal(opened.metadata.index_state, "complete");
  assert.equal(opened.newestIndexedAt, "2026-08-04T12:00:00Z");
  assert.deepEqual(opened.warnings, []);
  assert.throws(
    () => opened.database.exec("CREATE TABLE forbidden(value TEXT)"),
    /read[ -]?only/i
  );

  opened.close();
});

test("rejects an unknown schema version", async () => {
  const fixture = await createProject({ schemaVersion: 9 });

  assert.throws(
    () => openCodeGraph(fixture.projectPath),
    /Unsupported CodeGraph schema version 9.*expected 8/
  );
});

test("names the missing database path", async () => {
  const projectPath = await mkdtemp(join(tmpdir(), "codegraph-viz-missing-"));
  const expectedPath = join(projectPath, ".codegraph", "codegraph.db");

  assert.throws(() => openCodeGraph(projectPath), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /CodeGraph database not found/);
    assert.match(error.message, new RegExp(expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(error.message, /codegraph install/);
    assert.match(error.message, /codegraph init/);
    return true;
  });
});

test("warns when the index is incomplete", async () => {
  const fixture = await createProject({ indexState: "indexing" });
  const opened = openCodeGraph(fixture.projectPath);

  assert.deepEqual(opened.warnings, [
    'CodeGraph index_state is "indexing", not "complete".'
  ]);
  opened.close();
});
