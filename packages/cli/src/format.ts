/** Small, dependency-free table and detail printing. No colour, no spinners. */

export function table(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return '(none)';
  const cell = (v: unknown): string => (v === null || v === undefined ? '-' : String(v));
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).length))
  );
  const line = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [
    line(columns),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(columns.map((c) => cell(r[c])))),
  ].join('\n');
}

export function detail(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${v === null || v === undefined ? '-' : String(v)}`)
    .join('\n');
}

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
