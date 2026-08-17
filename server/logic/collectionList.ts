/**
 * Parsing of LazerCollectionImporter's `--list` output. Lives here rather than
 * in the route so it can be tested without opening a database.
 */

export interface LazerCollection {
  name: string;
  count: number;
  /** YYYY-MM-DD */
  lastModified: string;
}

/**
 * The importer's listing is meant for humans:
 *
 *   3 collection(s) in lazer:
 *     Farm                                        128 map(s)   last modified 2026-08-01
 *
 * We read that rather than adding a --json flag to the importer, so this keeps
 * working with the executable people already have installed. "map(s)" is the
 * anchor: the name is free text and may contain runs of spaces.
 */
export function parseCollectionList(out: string): LazerCollection[] {
  const re = / {2}(.*?) +(\d+) map\(s\) {3}last modified (\d{4}-\d{2}-\d{2})\s*$/;
  const rows: LazerCollection[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) rows.push({ name: m[1], count: Number(m[2]), lastModified: m[3] });
  }
  return rows;
}
