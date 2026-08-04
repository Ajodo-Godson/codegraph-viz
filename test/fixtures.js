import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function createCodeGraphProject({
  schemaVersion = 8,
  indexState = "complete",
  populate
} = {}) {
  const projectPath = await mkdtemp(join(tmpdir(), "codegraph-viz-"));
  const indexPath = join(projectPath, ".codegraph");
  const databasePath = join(indexPath, "codegraph.db");
  await mkdir(indexPath);

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
      file_path TEXT, language TEXT, start_line INTEGER, end_line INTEGER,
      start_column INTEGER, end_column INTEGER, docstring TEXT, signature TEXT,
      visibility TEXT, is_exported INTEGER, is_async INTEGER, is_static INTEGER,
      is_abstract INTEGER, decorators TEXT, type_parameters TEXT,
      return_type TEXT, updated_at TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT,
      metadata TEXT, line INTEGER, col INTEGER, provenance TEXT
    );
    CREATE TABLE files (
      path TEXT PRIMARY KEY, content_hash TEXT, language TEXT, size INTEGER,
      modified_at TEXT, indexed_at TEXT, node_count INTEGER, errors TEXT
    );
    CREATE TABLE project_metadata (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT
    );
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY, applied_at TEXT, description TEXT
    );
  `);
  database.prepare("INSERT INTO schema_versions(version) VALUES (?)").run(schemaVersion);
  database.prepare(
    "INSERT INTO project_metadata(key, value) VALUES ('index_state', ?)"
  ).run(indexState);

  if (populate) populate(database);
  database.close();

  return { projectPath, databasePath };
}

export function insertFile(database, {
  path,
  language = "JavaScript",
  size = 100,
  indexedAt = "2026-08-04T12:00:00Z",
  nodeCount = 0,
  errors = null
}) {
  database.prepare(`
    INSERT INTO files(path, language, size, indexed_at, node_count, errors)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(path, language, size, indexedAt, nodeCount, errors);
}

export function insertNode(database, {
  id,
  kind,
  name,
  qualifiedName = null,
  filePath,
  language = "JavaScript",
  startLine = null,
  endLine = null,
  signature = null
}) {
  database.prepare(`
    INSERT INTO nodes(
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, kind, name, qualifiedName, filePath, language,
    startLine, endLine, signature
  );
}

export function insertEdge(database, source, target, kind) {
  database.prepare(
    "INSERT INTO edges(source, target, kind) VALUES (?, ?, ?)"
  ).run(source, target, kind);
}
