import { readFileSync } from "node:fs";

const templatePath = new URL("./template.html", import.meta.url);
const template = readFileSync(templatePath, "utf8");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializePayload(payload) {
  return JSON.stringify(payload)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function displayTimestamp(value) {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "number" || /^\d{10,}$/.test(String(value))) {
    const date = new Date(Number(value));
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return String(value);
}

export function renderGraph(graph, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const indexedAt = displayTimestamp(graph.sourceStats.newestIndexedAt);
  const nodeName = graph.level === "directory" ? "directory" : graph.level;
  const completeness = graph.report.pruned
    ? `Showing ${graph.report.shownNodes} of ${graph.report.totalNodes} ${nodeName} nodes`
    : `Showing all ${graph.report.totalNodes} ${nodeName} nodes`;

  return template
    .replace("__GRAPH_PAYLOAD__", serializePayload(graph))
    .replace("__GENERATED_AT__", escapeHtml(generatedAt))
    .replace("__INDEXED_AT__", escapeHtml(indexedAt))
    .replace("__COMPLETENESS__", escapeHtml(completeness));
}
