import type { DiscordTemplate } from "./api";

/**
 * Client-side twin of the server's template engine (server/notify/discord.ts,
 * renderTemplate) — keep the two in sync. The editor renders the template
 * locally against a sampled score so the preview needs no round-trip.
 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  // a bold wrapper around a value that is already bold (honors carry their
  // own **) would nest ** and print literal stars; around a timestamp it
  // breaks the <t:..> rendering. Drop the wrapper in both cases.
  tpl = tpl.replace(/\*\*\{(\w+)\}\*\*/g, (m, k: string) => {
    const v = vars[k] ?? "";
    return v === "" || v.includes("**") || v.startsWith("<t:") ? `{${k}}` : m;
  });
  return tpl
    .split("\n")
    .map((line) => {
      let lineHasPh = false;
      let lineHasVal = false;
      const segs = line
        .split("·")
        .map((seg) => {
          let segHasPh = false;
          let segHasVal = false;
          const out = seg.replace(/\{(\w+)\}/g, (_, k: string) => {
            segHasPh = true;
            lineHasPh = true;
            const v = vars[k] ?? "";
            if (v !== "") {
              segHasVal = true;
              lineHasVal = true;
            }
            return v;
          });
          if (segHasPh && !segHasVal) return null;
          return out.replace(/\s+/g, " ").trim();
        })
        .filter((x): x is string => x != null && x !== "");
      if (segs.length === 0) return null;
      if (lineHasPh && !lineHasVal) return null;
      return segs.join(" · ");
    })
    .filter((l): l is string => l != null)
    .join("\n");
}

// ---------------------------------------------------------------- blocks
// The editor manipulates the template as blocks: lines of segments (joined
// by « · ») made of chips — a placeholder (bold or not) or free text.

export type Chip =
  | { kind: "ph"; key: string; bold: boolean; br?: boolean }
  | { kind: "text"; text: string };
export type Segment = Chip[];
export type BodyLines = Segment[][];

/** every placeholder the server resolves, sorted into palette groups */
export const PALETTE_GROUPS: {
  label: string;
  items: { key: string; label: string }[];
}[] = [
  {
    label: "Score",
    items: [
      { key: "grade", label: "grade" },
      { key: "mods", label: "mods" },
      { key: "rate", label: "rate" },
      { key: "score", label: "score" },
      { key: "scorestd", label: "score (std)" },
      { key: "acc", label: "accuracy" },
      { key: "fc", label: "FC" },
      { key: "combo", label: "combo" },
      { key: "maxcombo", label: "/max combo" },
      { key: "pp", label: "pp" },
      { key: "when", label: "when" },
      { key: "date", label: "date" },
    ],
  },
  {
    label: "Hits",
    items: [
      { key: "hits", label: "hits" },
      { key: "h300", label: "300s" },
      { key: "h100", label: "100s" },
      { key: "h50", label: "50s" },
      { key: "hmiss", label: "misses" },
    ],
  },
  {
    label: "Map",
    items: [
      { key: "artist", label: "artist" },
      { key: "title", label: "title" },
      { key: "diff", label: "diff" },
      { key: "mapper", label: "mapper" },
      { key: "sr", label: "stars" },
      { key: "srb", label: "[stars]" },
    ],
  },
  {
    label: "Map stats",
    items: [
      { key: "len", label: "length" },
      { key: "bpm", label: "BPM" },
      { key: "cs", label: "CS" },
      { key: "ar", label: "AR" },
      { key: "od", label: "OD" },
      { key: "hp", label: "HP" },
      { key: "mapstats", label: "map stats" },
    ],
  },
  {
    label: "Honors",
    items: [
      { key: "globaltop", label: "global top" },
      { key: "country1", label: "country #1" },
      { key: "honors", label: "honors" },
    ],
  },
  {
    label: "Other",
    items: [{ key: "new", label: "🆕/📈" }],
  },
];

/** flat list, for label lookups */
export const PLACEHOLDERS: { key: string; label: string }[] =
  PALETTE_GROUPS.flatMap((g) => g.items);

/** one segment string -> chips ("**[{x}]**", "[{x}]", "**{x}**", "{x}",
 * free text runs) — [{x}] keeps its brackets glued to the value ("[6.73★]") */
function parseSegment(seg: string): Segment {
  const chips: Segment = [];
  const re = /\*\*\[\{(\w+)\}\]\*\*|\[\{(\w+)\}\]|\*\*\{(\w+)\}\*\*|\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(seg); m != null; m = re.exec(seg)) {
    const before = seg.slice(last, m.index).trim();
    if (before) chips.push({ kind: "text", text: before });
    if (m[1] != null) chips.push({ kind: "ph", key: m[1], bold: true, br: true });
    else if (m[2] != null) chips.push({ kind: "ph", key: m[2], bold: false, br: true });
    else if (m[3] != null) chips.push({ kind: "ph", key: m[3], bold: true });
    else chips.push({ kind: "ph", key: m[4], bold: false });
    last = m.index + m[0].length;
  }
  const tail = seg.slice(last).trim();
  if (tail) chips.push({ kind: "text", text: tail });
  return chips;
}

/** one template line -> editable segments (the title is a single line) */
export function parseLine(line: string): Segment[] {
  return line
    .split("·")
    .map(parseSegment)
    .filter((seg) => seg.length > 0);
}

/** template body string -> editable blocks */
export function parseBody(body: string): BodyLines {
  return body
    .split("\n")
    .map(parseLine)
    .filter((line) => line.length > 0);
}

function serializeChip(c: Chip): string {
  if (c.kind === "text") return c.text;
  const inner = c.br ? `[{${c.key}}]` : `{${c.key}}`;
  return c.bold ? `**${inner}**` : inner;
}

/** editable segments -> one template line string (the title).
 * {maxcombo} glues to what precedes it ("3319x/9289x", its value starts
 * with "/"), everything else is space-separated. */
export function serializeLine(line: Segment[]): string {
  return line
    .map((seg) =>
      seg
        .map((c, i) => {
          const sep =
            i === 0 || (c.kind === "ph" && c.key === "maxcombo") ? "" : " ";
          return sep + serializeChip(c);
        })
        .join("")
    )
    .filter((s) => s.trim() !== "")
    .join(" · ");
}

/** editable blocks -> template body string (what the server stores) */
export function serializeBody(lines: BodyLines): string {
  return lines
    .map(serializeLine)
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/** round-trip helper: the template with the body replaced by these blocks */
export function withBody(t: DiscordTemplate, lines: BodyLines): DiscordTemplate {
  return { ...t, body: serializeBody(lines) };
}
