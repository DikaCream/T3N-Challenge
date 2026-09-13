/**
 * Aligned text tables.
 *
 * Width is computed from the cells rather than guessed, so long endpoint hosts
 * push the columns out instead of clipping. Every call site passes pre-shortened
 * values — a table is a summary, not a dump.
 */

export type Cell = string | number | boolean | null | undefined;

function asText(cell: Cell): string {
  if (cell === null || cell === undefined) return "-";
  return String(cell);
}

export function renderTable(headers: readonly string[], rows: readonly Cell[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => asText(row[column]).length),
      0,
    ),
  );

  const line = (cells: readonly Cell[]): string =>
    cells
      .map((cell, column) => asText(cell).padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();

  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/** `{ a: 1, b: "x" }` -> `["a  1", "b  x"]`, for stacked key/value detail blocks. */
export function renderPairs(pairs: readonly (readonly [string, Cell])[]): string {
  const width = Math.max(...pairs.map(([key]) => key.length), 0);
  return pairs
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key.padEnd(width)}  ${asText(value)}`)
    .join("\n");
}
