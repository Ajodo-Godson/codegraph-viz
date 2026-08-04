import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SUPPORTED_SCHEMA_VERSION = 8;

function resolveDatabasePath(projectOrDatabasePath) {
  const inputPath = resolve(projectOrDatabasePath);

  if (inputPath.endsWith(".db")) {
    return inputPath;
  }

  return join(inputPath, ".codegraph", "codegraph.db");
}

function readMetadata(database) {
  const rows = database
    .prepare("SELECT key, value FROM project_metadata ORDER BY key")
    .all();

  return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
}

export function openCodeGraph(projectOrDatabasePath = process.cwd()) {
  const databasePath = resolveDatabasePath(projectOrDatabasePath);

  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`CodeGraph database not found at ${databasePath}`);
  }

  let database;

  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("BEGIN");

    const row = database
      .prepare("SELECT MAX(version) AS version FROM schema_versions")
      .get();
    const schemaVersion = row?.version;

    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported CodeGraph schema version ${String(schemaVersion)} at ${databasePath}; ` +
          `expected ${SUPPORTED_SCHEMA_VERSION}`
      );
    }

    const metadata = readMetadata(database);
    const newestIndexedAt = database
      .prepare("SELECT MAX(indexed_at) AS indexed_at FROM files")
      .get()?.indexed_at ?? null;
    const warnings = [];

    if (metadata.index_state !== "complete") {
      warnings.push(
        `CodeGraph index_state is ${JSON.stringify(metadata.index_state ?? null)}, ` +
          'not "complete".'
      );
    }

    let closed = false;

    return {
      database,
      path: databasePath,
      schemaVersion,
      metadata,
      newestIndexedAt,
      warnings,
      close() {
        if (closed) return;
        database.exec("ROLLBACK");
        database.close();
        closed = true;
      }
    };
  } catch (error) {
    if (database) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may not have started.
      }
      database.close();
    }

    if (error instanceof Error && error.message.includes(databasePath)) {
      throw error;
    }

    throw new Error(`Unable to open CodeGraph database at ${databasePath}: ${error.message}`, {
      cause: error
    });
  }
}
