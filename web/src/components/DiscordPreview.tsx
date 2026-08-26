import type { DiscordSample, DiscordTemplate } from "../api";
import { renderTemplate } from "../discordTemplate";

/**
 * A pixel-faithful mock of the Discord message the webhook posts: dark-theme
 * chat background, webhook author row with APP badge, the embed card with its
 * pink accent border, markdown bold, relative-timestamp pills, cover image
 * and footer. Colors and metrics follow Discord's current dark theme; the
 * proprietary "gg sans" font is approximated by the closest system stack.
 */

/** markdown-lite: **bold** and <t:..:R> timestamp pills, everything else raw */
function mdLite(line: string, key: number): React.ReactNode {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|<t:(\d+):R>/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(line); m != null; m = re.exec(line)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1] != null) out.push(<strong key={`b${i++}`}>{m[1]}</strong>);
    else out.push(
      <span key={`t${i++}`} className="dc-timestamp">
        {relTime(Number(m[2]))}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return <div key={key}>{out}</div>;
}

/** "il y a 3 ans" style relative time, like the Discord client renders <t:..:R> */
export function relTime(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  const abs = Math.abs(diff);
  const fmt = (n: number, unit: string) =>
    diff >= 0 ? `il y a ${n} ${unit}` : `dans ${n} ${unit}`;
  if (abs < 60) return fmt(Math.round(abs), "s");
  if (abs < 3600) return fmt(Math.round(abs / 60), "min");
  if (abs < 86_400) return fmt(Math.round(abs / 3600), "h");
  if (abs < 2_629_800) return fmt(Math.round(abs / 86_400), "jours");
  if (abs < 31_557_600) return fmt(Math.round(abs / 2_629_800), "mois");
  const y = Math.round(abs / 31_557_600);
  return fmt(y, y > 1 ? "ans" : "an");
}

export function DiscordPreview({
  template,
  sample,
  content,
}: {
  template: DiscordTemplate;
  sample: DiscordSample;
  /** the plain message above the embed (test posts carry one) */
  content?: string;
}) {
  const title = renderTemplate(template.title, sample.vars);
  const body = renderTemplate(template.body, sample.vars);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <div className="dc-chat">
      <div className="dc-msg">
        <div className="dc-avatar" />
        <div className="dc-msg-main">
          <div className="dc-head">
            <span className="dc-username">osu!completionist</span>
            <span className="dc-badge">APP</span>
            <span className="dc-time">
              aujourd’hui à {pad(now.getHours())}:{pad(now.getMinutes())}
            </span>
          </div>
          {content && <div className="dc-content">{mdLite(content, -1)}</div>}
          <div className="dc-embed">
            <div className="dc-embed-inner">
              {template.author && sample.author && (
                <div className="dc-author">
                  {sample.author.icon_url && (
                    <img src={sample.author.icon_url} alt="" />
                  )}
                  <span>{sample.author.name}</span>
                </div>
              )}
              {title && <div className="dc-title">{title}</div>}
              {body && (
                <div className="dc-desc">
                  {body.split("\n").map((l, i) => mdLite(l, i))}
                </div>
              )}
              {template.cover && sample.cover && (
                <img className="dc-image" src={sample.cover} alt="" />
              )}
              {template.footer && sample.footer && (
                <div className="dc-footer">{sample.footer}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
