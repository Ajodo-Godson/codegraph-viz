import type { ExtractedGraph, GraphLink, OpenedCodeGraph } from "./types.ts";

export const RELATED_SYMBOL_LIMIT = 10;

function compareRelated(left, right) {
  return (
    left.name.localeCompare(right.name) ||
    left.filePath.localeCompare(right.filePath) ||
    left.id.localeCompare(right.id)
  );
}

function addRelated(map, ownerId, related) {
  let relatedById = map.get(ownerId);

  if (!relatedById) {
    relatedById = new Map();
    map.set(ownerId, relatedById);
  }

  relatedById.set(related.id, related);
}

function readCallRelations(database) {
  const rows = database.prepare(`
    SELECT
      source.id AS source_id,
      source.name AS source_name,
      source.file_path AS source_file_path,
      target.id AS target_id,
      target.name AS target_name,
      target.file_path AS target_file_path
    FROM edges
    JOIN nodes AS source ON source.id = edges.source
    JOIN nodes AS target ON target.id = edges.target
    JOIN files AS source_file ON source_file.path = source.file_path
    JOIN files AS target_file ON target_file.path = target.file_path
    WHERE edges.kind = 'calls'
      AND source.kind NOT IN ('file', 'import')
      AND target.kind NOT IN ('file', 'import')
  `).all();
  const callers = new Map();
  const callees = new Map();

  for (const row of rows) {
    addRelated(callees, row.source_id, {
      id: row.target_id,
      name: row.target_name,
      filePath: row.target_file_path
    });
    addRelated(callers, row.target_id, {
      id: row.source_id,
      name: row.source_name,
      filePath: row.source_file_path
    });
  }

  return { callers, callees };
}

function relatedFor(map, symbolId) {
  const all = [...(map.get(symbolId)?.values() ?? [])].sort(compareRelated);

  return {
    count: all.length,
    items: all.slice(0, RELATED_SYMBOL_LIMIT)
  };
}

function extractFiles(database) {
  return database.prepare(`
    SELECT
      files.path,
      files.language,
      files.size,
      files.errors,
      COUNT(nodes.id) AS symbol_count
    FROM files
    LEFT JOIN nodes
      ON nodes.file_path = files.path
      AND nodes.kind NOT IN ('file', 'import')
    GROUP BY files.path, files.language, files.size, files.errors
    ORDER BY files.path
  `).all().map((row) => ({
    path: row.path,
    language: row.language,
    size: row.size,
    symbolCount: Number(row.symbol_count),
    errors: row.errors
  }));
}

function extractSymbols(database) {
  const { callers, callees } = readCallRelations(database);
  const rows = database.prepare(`
    SELECT
      id, kind, name, qualified_name, file_path,
      start_line, end_line, signature
    FROM nodes
    JOIN files ON files.path = nodes.file_path
    WHERE kind NOT IN ('file', 'import')
      AND file_path IS NOT NULL
    ORDER BY
      file_path,
      start_line IS NULL,
      start_line,
      name,
      id
  `).all();

  return rows.map((row) => {
    const symbolCallers = relatedFor(callers, row.id);
    const symbolCallees = relatedFor(callees, row.id);

    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      signature: row.signature,
      degree: symbolCallers.count + symbolCallees.count,
      callers: symbolCallers.items,
      callees: symbolCallees.items,
      callerCount: symbolCallers.count,
      calleeCount: symbolCallees.count
    };
  });
}

function extractLinks(database): GraphLink[] {
  const rows = database.prepare(`
    SELECT
      source.file_path AS source,
      target.file_path AS target,
      edges.kind,
      COUNT(*) AS kind_weight
    FROM edges
    JOIN nodes AS source ON source.id = edges.source
    JOIN nodes AS target ON target.id = edges.target
    JOIN files AS source_file ON source_file.path = source.file_path
    JOIN files AS target_file ON target_file.path = target.file_path
    WHERE edges.kind != 'contains'
      AND source.file_path IS NOT NULL
      AND target.file_path IS NOT NULL
      AND source.file_path != target.file_path
    GROUP BY source.file_path, target.file_path, edges.kind
    ORDER BY source.file_path, target.file_path, edges.kind
  `).all();
  const links: Array<Omit<GraphLink, "dominantKind"> & { dominantKind: string | null }> = [];

  for (const row of rows) {
    let link = links.at(-1);

    if (!link || link.source !== row.source || link.target !== row.target) {
      link = {
        source: row.source,
        target: row.target,
        weight: 0,
        dominantKind: null,
        kinds: {}
      };
      links.push(link);
    }

    const weight = Number(row.kind_weight);
    link.kinds[row.kind] = weight;
    link.weight += weight;

    const dominantWeight = link.dominantKind === null
      ? -1
      : link.kinds[link.dominantKind];

    if (weight > dominantWeight) {
      link.dominantKind = row.kind;
    }
  }

  return links.map((link) => ({
    ...link,
    dominantKind: link.dominantKind ?? "unknown"
  }));
}

function extractSymbolLinks(database) {
  return database.prepare(`
    SELECT edges.source, edges.target, COUNT(*) AS weight
    FROM edges
    JOIN nodes AS source ON source.id = edges.source
    JOIN nodes AS target ON target.id = edges.target
    JOIN files AS source_file ON source_file.path = source.file_path
    JOIN files AS target_file ON target_file.path = target.file_path
    WHERE edges.kind = 'calls'
      AND source.kind NOT IN ('file', 'import')
      AND target.kind NOT IN ('file', 'import')
    GROUP BY edges.source, edges.target
    ORDER BY edges.source, edges.target
  `).all().map((row) => ({
    source: row.source,
    target: row.target,
    weight: Number(row.weight)
  }));
}

export function extractGraph(openedCodeGraph: OpenedCodeGraph): ExtractedGraph {
  const { database, newestIndexedAt } = openedCodeGraph;
  const files = extractFiles(database);
  const symbols = extractSymbols(database);
  const links = extractLinks(database);
  const symbolLinks = extractSymbolLinks(database);
  const edgeKindCounts: Record<string, number> = {};

  for (const link of links) {
    for (const [kind, count] of Object.entries(link.kinds)) {
      edgeKindCounts[kind] = (edgeKindCounts[kind] ?? 0) + count;
    }
  }

  return {
    files,
    links,
    symbols,
    symbolLinks,
    stats: {
      fileCount: files.length,
      symbolCount: symbols.length,
      linkCount: links.length,
      crossFileEdgeCount: links.reduce((total, link) => total + link.weight, 0),
      edgeKindCounts,
      newestIndexedAt
    }
  };
}
