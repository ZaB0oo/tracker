import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDiscordSample,
  postSettings,
  type DiscordTemplate,
} from "../api";
import {
  parseBody,
  parseLine,
  serializeBody,
  serializeLine,
  PALETTE_GROUPS,
  PLACEHOLDERS,
  type Chip,
  type Segment,
} from "../discordTemplate";
import { firstPlaceLabel, useCountryCode } from "../country";
import { useEscape } from "../useEscape";
import { DiscordPreview, relTime } from "./DiscordPreview";

/** where a drag started: the palette, or a chip already in the layout */
type DragSrc =
  | { from: "palette"; key: string }
  | { from: "palette-text" }
  | { from: "body"; li: number; si: number; ci: number };

/** where a drop lands: inside a segment (at a chip index), the end of a
 * segment, a new segment slot of a line, or a brand new line at the bottom.
 * Line 0 is the title, 1.. are the body lines. */
type DropDst =
  | { at: "chip"; li: number; si: number; ci: number }
  | { at: "seg-end"; li: number; si: number }
  | { at: "new-seg"; li: number; si: number }
  | { at: "new-line" };

const phLabel = (key: string) =>
  PLACEHOLDERS.find((p) => p.key === key)?.label ?? key;

/** example values shown dimmed when the sampled score has none — so every
 * chip stays visible and recognizable (global top, country #1, mods…) */
const DEMO: Record<string, string> = {
  mods: "HDDT",
  rate: "1.2x",
  fc: "FC",
  pp: "123.45pp",
  maxcombo: "/739x",
  sr: "6.73★",
  srb: "[6.73★]",
  bpm: "180 BPM",
  len: "3:42",
  cs: "CS 4.00",
  ar: "AR 9.30",
  od: "OD 8.50",
  hp: "HP 5.00",
  mapstats: "3:42 · 180 BPM · CS 4.00 · AR 9.30 · OD 8.50 · HP 5.00",
  globaltop: "🌍 **Global Top #42**",
  hits: "{683/12/3/1}",
  h300: "683",
  h100: "12",
  h50: "3",
  hmiss: "1",
  scorestd: "998,472",
  artist: "artist",
  title: "title",
  diff: "diff",
  mapper: "mapper",
};

/**
 * The notification designer: title + embed body as drag & drop chips on the
 * left, the pixel-faithful Discord preview on the right, live against a
 * random REAL best sampled from the database. Chips show the sampled score's
 * actual values (dimmed example when the score has none). Click a chip to
 * toggle bold (body only — Discord titles ignore markdown), × removes it,
 * chips joined by « · » vanish together when their values are empty —
 * exactly like the live notification.
 */
export function DiscordEditor({
  ruleset = 0,
  template,
  templateDefault,
  onClose,
}: {
  ruleset?: number;
  template: DiscordTemplate;
  templateDefault: DiscordTemplate;
  onClose: () => void;
}) {
  useEscape(onClose);
  const qc = useQueryClient();
  // lines[0] = title, lines[1..] = body
  const [lines, setLines] = useState<Segment[][]>(() => [
    parseLine(template.title),
    ...parseBody(template.body),
  ]);
  const [cover, setCover] = useState(template.cover);
  const [footer, setFooter] = useState(template.footer);
  const [author, setAuthor] = useState(template.author);
  const [pick, setPick] = useState({ seed: 0, honors: false });
  const [drag, setDrag] = useState<DragSrc | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const country = useCountryCode();
  const { data: sample, isFetching } = useQuery({
    queryKey: ["discord-sample", ruleset, pick.seed, pick.honors],
    queryFn: () => fetchDiscordSample(ruleset, pick.honors),
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });

  const current: DiscordTemplate = useMemo(
    () => ({
      title: serializeLine(lines[0] ?? []),
      body: serializeBody(lines.slice(1)),
      cover,
      footer,
      author,
    }),
    [lines, cover, footer, author]
  );

  const save = useMutation({
    mutationFn: () => postSettings({ discord: { template: current } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      onClose();
    },
    onError: (e: Error) => setMsg(e.message),
  });

  /** deep-clone the lines (small structure, edits stay immutable-ish) */
  const clone = (): Segment[][] =>
    lines.map((l) => l.map((s) => s.map((c) => ({ ...c }))));
  /** drop empty segments, drop empty body lines (the title line may stay empty) */
  const sweep = (next: Segment[][]): Segment[][] =>
    next
      .map((l) => l.filter((s) => s.length > 0))
      .filter((l, i) => i === 0 || l.length > 0);

  const dropChip = (dst: DropDst) => {
    if (!drag) return;
    const next = clone();
    // the chip being moved (palette chips are created on the spot)
    let chip: Chip;
    if (drag.from === "palette") chip = { kind: "ph", key: drag.key, bold: false };
    else if (drag.from === "palette-text") chip = { kind: "text", text: "text" };
    else {
      chip = next[drag.li][drag.si][drag.ci];
      next[drag.li][drag.si].splice(drag.ci, 1);
    }
    // Discord renders no markdown in embed titles — landing there drops bold
    if (dst.at !== "new-line" && dst.li === 0 && chip.kind === "ph")
      chip = { ...chip, bold: false };
    const insert = (li: number, si: number, ci: number | null) => {
      // account for the removal shifting indices in the same segment/line
      if (drag.from === "body") {
        if (ci != null && drag.li === li && drag.si === si && drag.ci < ci) ci--;
      }
      if (ci == null) next[li][si].push(chip);
      else next[li][si].splice(ci, 0, chip);
    };
    if (dst.at === "chip") insert(dst.li, dst.si, dst.ci);
    else if (dst.at === "seg-end") insert(dst.li, dst.si, null);
    else if (dst.at === "new-seg") next[dst.li].splice(dst.si, 0, [chip]);
    else next.push([[chip]]);
    setLines(sweep(next));
    setDrag(null);
    setOver(null);
  };

  const removeChip = (li: number, si: number, ci: number) => {
    const next = clone();
    next[li][si].splice(ci, 1);
    setLines(sweep(next));
  };

  const updateChip = (li: number, si: number, ci: number, patch: Partial<Chip>) => {
    const next = clone();
    next[li][si][ci] = { ...next[li][si][ci], ...patch } as Chip;
    setLines(next);
  };

  const dragProps = (src: DragSrc) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "chip"); // required by some engines
      setDrag(src);
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
  });
  const dropProps = (dst: DropDst) => {
    const key = JSON.stringify(dst);
    return {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
      },
      onDragEnter: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(key);
      },
      onDragLeave: () => setOver((cur) => (cur === key ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dropChip(dst);
      },
    };
  };
  const overClass = (dst: DropDst) =>
    over === JSON.stringify(dst) ? " dc-over" : "";

  /** what a placeholder chip displays: the sampled score's real value,
   * or a dimmed example when this score has none. selfBold marks values that
   * carry their own ** (honors): bolding them again would print stars, so
   * their chips are always bold and the toggle is disabled. */
  const chipView = (
    key: string,
    br?: boolean
  ): { text: string; demo: boolean; selfBold: boolean } => {
    const v = sample?.vars[key] ?? "";
    const demo = v === "";
    // country-aware examples, matching the live "#1 FR" label
    const c1 = `🥇 **${country ? firstPlaceLabel(country) : "country #1"}**`;
    const dyn: Record<string, string> = {
      country1: c1,
      honors: `${DEMO.globaltop} · ${c1}`,
    };
    let text = demo ? dyn[key] ?? DEMO[key] ?? phLabel(key) : v;
    const selfBold = text.includes("**");
    text = text
      .replace(/\*\*/g, "")
      .replace(/<t:(\d+):R>/g, (_, s: string) => relTime(Number(s)));
    if (br && key !== "srb") text = `[${text}]`;
    return { text, demo, selfBold };
  };

  /** drop target for a whole line row: append to its last segment */
  const rowDrop = (li: number): DropDst =>
    lines[li].length === 0
      ? { at: "new-seg", li, si: 0 }
      : { at: "seg-end", li, si: lines[li].length - 1 };

  const renderLine = (line: Segment[], li: number) => (
    <>
      {line.map((seg, si) => (
        <span key={si} className="dc-seg-wrap">
          {si > 0 && (
            <span
              className={`dc-newseg${overClass({ at: "new-seg", li, si })}`}
              {...dropProps({ at: "new-seg", li, si })}
            >
              ·
            </span>
          )}
          <span
            className={`dc-seg${overClass({ at: "seg-end", li, si })}`}
            {...dropProps({ at: "seg-end", li, si })}
          >
            {seg.map((chip, ci) => {
              const view = chip.kind === "ph" ? chipView(chip.key, chip.br) : null;
              // honors are bold by themselves, timestamps cannot be bolded
              const noBold =
                chip.kind === "ph" && (view!.selfBold || chip.key === "when");
              return (
                <span
                  key={ci}
                  className={`dc-chip${chip.kind === "ph" && (chip.bold || view!.selfBold) ? " bold" : ""}${chip.kind === "text" ? " dc-chip-text" : ""}${view?.demo ? " dc-chip-demo" : ""}${overClass({ at: "chip", li, si, ci })}`}
                  {...dragProps({ from: "body", li, si, ci })}
                  {...dropProps({ at: "chip", li, si, ci })}
                  onClick={() => {
                    if (chip.kind === "ph" && li > 0 && !noBold)
                      updateChip(li, si, ci, { bold: !chip.bold });
                  }}
                  title={
                    chip.kind === "ph"
                      ? `${phLabel(chip.key)}${view?.demo ? " (no value for this score: example shown, its « · » group is hidden)" : ""}${view?.selfBold ? " · always bold" : chip.key === "when" ? " · bold not supported" : li > 0 ? " · click: toggle bold" : ""}`
                      : "Free text"
                  }
                >
                  {chip.kind === "ph" ? (
                    <span className="dc-chip-val">{view!.text}</span>
                  ) : (
                    <input
                      value={chip.text}
                      style={{ width: `calc(${Math.max(1, chip.text.length)}ch + 4px)` }}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        updateChip(li, si, ci, { text: e.target.value })
                      }
                      spellCheck={false}
                    />
                  )}
                  <button
                    className="dc-chip-x"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeChip(li, si, ci);
                    }}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </span>
        </span>
      ))}
      <span
        className={`dc-newseg dc-newseg-end${overClass({ at: "new-seg", li, si: line.length })}`}
        {...dropProps({ at: "new-seg", li, si: line.length })}
      >
        + ·
      </span>
    </>
  );

  // portal: the settings modal has a CSS transform, which would trap this
  // fixed-position window (and its overlay) inside the modal's box
  return createPortal(
    <>
      <div className="menu-overlay modal-overlay dc-editor-overlay" onClick={onClose} />
      <div className={`adv-modal dc-editor${drag ? " dc-dragging" : ""}`}>
        <div className="adv-head">
          <h2>Discord notification designer</h2>
          <button className="mm-close" onClick={onClose}>✕</button>
        </div>
        <div className="dc-editor-cols">
          <div className="dc-editor-left">
            <p className="set-note">
              Drag chips into the title or the body: they show the sampled
              score's real values (dimmed = this score has none). Click a body
              chip to toggle <b>bold</b>, × removes it. Chips joined by « · »
              in a row vanish together when the score has no value for them.
            </p>
            <div className="dc-palette">
              {PALETTE_GROUPS.map((g) => (
                <div key={g.label} className="dc-pal-group">
                  <span className="dc-pal-label">{g.label}</span>
                  <span className="dc-pal-chips">
                  {g.items.map((p) => {
                    const view = chipView(p.key);
                    return (
                      <span
                        key={p.key}
                        className={`dc-chip dc-chip-src${view.demo ? " dc-chip-demo" : ""}`}
                        {...dragProps({ from: "palette", key: p.key })}
                        title={p.label}
                      >
                        <span className="dc-chip-val">{view.text}</span>
                      </span>
                    );
                  })}
                  {g.label === "Other" && (
                    <span
                      className="dc-chip dc-chip-src dc-chip-text"
                      {...dragProps({ from: "palette-text" })}
                      title="Free text"
                    >
                      text…
                    </span>
                  )}
                  </span>
                </div>
              ))}
            </div>
            <div className="dc-field">
              <span>Title</span>
              <div
                className={`dc-line dc-title-line${overClass(rowDrop(0))}`}
                {...dropProps(rowDrop(0))}
              >
                {renderLine(lines[0] ?? [], 0)}
              </div>
            </div>
            <div className="dc-field">
              <span>Body</span>
              <div className="dc-lines" {...dropProps({ at: "new-line" })}>
                {lines.slice(1).map((line, i) => (
                  <div
                    key={i}
                    className={`dc-line${overClass(rowDrop(i + 1))}`}
                    {...dropProps(rowDrop(i + 1))}
                  >
                    {renderLine(line, i + 1)}
                  </div>
                ))}
                <div
                  className={`dc-newline${overClass({ at: "new-line" })}`}
                  {...dropProps({ at: "new-line" })}
                >
                  + new line (drop a chip here)
                </div>
              </div>
            </div>
            <div className="dc-editor-checks">
              <label><input type="checkbox" checked={cover} onChange={(e) => setCover(e.target.checked)} /> cover</label>
              <label><input type="checkbox" checked={footer} onChange={(e) => setFooter(e.target.checked)} /> footer</label>
              <label><input type="checkbox" checked={author} onChange={(e) => setAuthor(e.target.checked)} /> author line</label>
            </div>
            <div className="dc-editor-actions">
              <button
                onClick={() => setPick((p) => ({ seed: p.seed + 1, honors: false }))}
                disabled={isFetching}
              >
                {isFetching ? "Sampling…" : "Sample another score"}
              </button>
              <button
                onClick={() => setPick((p) => ({ seed: p.seed + 1, honors: true }))}
                disabled={isFetching}
                title="Sample a best that is global top 100 or country #1, to see the honors live (or any best if there is none)"
              >
                With honors
              </button>
              <button
                onClick={() => {
                  setLines([
                    parseLine(templateDefault.title),
                    ...parseBody(templateDefault.body),
                  ]);
                  setCover(templateDefault.cover);
                  setFooter(templateDefault.footer);
                  setAuthor(templateDefault.author);
                }}
              >
                Reset layout
              </button>
              <span className="dc-editor-spacer" />
              <button onClick={onClose}>Cancel</button>
              <button
                className="dc-save"
                disabled={save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
            {msg && <p className="set-note">{msg}</p>}
          </div>
          <div className="dc-editor-right">
            {sample ? (
              <DiscordPreview template={current} sample={sample} />
            ) : (
              <p className="set-note">Sampling a score…</p>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
