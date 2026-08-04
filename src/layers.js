const PALETTE = [
  "#2563eb", "#7c3aed", "#db2777", "#ea580c",
  "#059669", "#0891b2", "#4f46e5", "#65a30d", "#64748b"
];

function rawLayer(path) {
  const separator = path.indexOf("/");
  return separator === -1 ? "root" : path.slice(0, separator);
}

function validateRecord(value, name) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Layer configuration ${name} must be an object.`);
  }
  return value;
}

export function deriveLayers(files, configuration = {}) {
  const rename = validateRecord(configuration.rename, "rename");
  const merge = validateRecord(configuration.merge, "merge");
  const colors = validateRecord(configuration.colors, "colors");

  for (const [layer, color] of Object.entries(colors)) {
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error(`Layer ${JSON.stringify(layer)} must use a valid hex color.`);
    }
  }

  const rawCounts = new Map();
  for (const file of files) {
    const layer = rawLayer(file.path);
    rawCounts.set(layer, (rawCounts.get(layer) ?? 0) + 1);
  }

  const rankedDirectories = [...rawCounts]
    .filter(([name]) => name !== "root")
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const retained = new Set(rankedDirectories.slice(0, 8).map(([name]) => name));
  const byPath = {};
  const finalCounts = new Map();

  for (const file of files) {
    const raw = rawLayer(file.path);
    const bucketed = raw === "root" || retained.has(raw) ? raw : "other";
    const finalName = merge[raw] ?? rename[bucketed] ?? bucketed;
    byPath[file.path] = finalName;
    finalCounts.set(finalName, (finalCounts.get(finalName) ?? 0) + 1);
  }

  const ordered = [...finalCounts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const largestName = ordered[0]?.[0];
  const layers = ordered.map(([id, fileCount], index) => {
    const largestIsTests = id === largestName && /(^|[\/_-])(tests?|specs?)([\/_-]|$)/i.test(id);
    return {
      id,
      label: id,
      fileCount,
      color: colors[id] ?? (largestIsTests ? "#7d8590" : PALETTE[index % PALETTE.length])
    };
  });

  return { byPath, layers };
}
