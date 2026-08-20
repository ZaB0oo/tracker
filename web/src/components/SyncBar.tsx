import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAuthStatus,
  fetchSyncStatus,
  postClearErrors,
  postLogout,
  postSync,
} from "../api";
import { AdvancedSettings } from "./AdvancedSettings";
import { OverlayConfig } from "./OverlayConfig";
import { ShareCard } from "./ShareCard";
import { firstPlaceLabel, useCountryCode } from "../country";
import { fmtNum, fmtTime } from "../format";
import type { PoolMode } from "../types";


/** Labels + toasts per action (start / result). `lbl` = "#1 FR", "#1 US"… */
const actionLabels = (
  lbl: string
): Record<string, { start: string; done: (r: Record<string, unknown>) => string }> => ({
  start: { start: "Initial sync started…", done: () => "Initial sync running (tracked in the bar)" },
  pause: { start: "Pausing the score import…", done: () => "Score import paused" },
  resume: { start: "Resuming the score import…", done: () => "Score import resumed" },
  "poll-now": {
    start: "Polling recent scores…",
    done: (r) => `Poll done: +${Number(r.newScores ?? 0)} new score(s)`,
  },
  "delta-now": {
    start: "Looking for new maps… (may take a few minutes)",
    done: (r) => `Delta done: +${Number(r.newMaps ?? 0)} map(s) added`,
  },
  "country-sweep": { start: `${lbl} sweep…`, done: () => `${lbl} sweep started (tracked in the bar)` },
  "country-pause": { start: "Pausing sweep…", done: () => `${lbl} sweep paused` },
  "global-sweep": {
    start: "Global tops sweep…",
    done: () => "Global tops sweep started (tracked in the bar)",
  },
  "global-pause": { start: "Pausing sweep…", done: () => "Global tops sweep paused" },
  "global-recheck-all": {
    start: "Re-queuing all global positions…",
    done: (r) => `${fmtNum(Number(r.requeued ?? 0))} maps re-queued (tracked in the bar)`,
  },
  recompute: {
    start: "Recomputing…",
    done: (r) => `Recompute done: ${fmtNum(Number(r.recomputed ?? 0))} maps`,
  },
  rebackfill: {
    start: "Re-importing every score…",
    done: () => `Score re-import + ${lbl} re-sweep started (tracked in the bar)`,
  },
  "catalog-full?force=1": {
    start: "Re-scanning catalog…",
    done: () => "Catalog re-scan started (tracked in the bar)",
  },
  ...Object.fromEntries(
    ["osu!", "taiko", "catch", "mania"].flatMap((n, r) => [
      [`backfill-pause/${r}`, { start: `Pausing the ${n} score import…`, done: () => `${n} score import paused (its passes are skipped)` }],
      [`backfill-resume/${r}`, { start: `Resuming the ${n} score import…`, done: () => `${n} score import resumed` }],
    ])
  ),
  "start-ruleset/1": { start: "Starting taiko sync…", done: () => "taiko sync started (catalog → scores, tracked in the bar)" },
  "start-ruleset/2": { start: "Starting catch sync…", done: () => "catch sync started (catalog → scores, tracked in the bar)" },
  "start-ruleset/3": { start: "Starting mania sync…", done: () => "mania sync started (catalog → scores, tracked in the bar)" },
});

const PHASE_LABELS: Record<string, string> = {
  idle: "idle",
  done: "up to date",
  error: "error",
  backfill: "importing scores",
  catalog: "catalog",
  enrich: "enrichment",
};

export function SyncBar({
  ruleset = 0,
  pool = "all",
  keys = [],
}: {
  ruleset?: number;
  /** current view, used as the overlay URL's defaults */
  pool?: PoolMode;
  keys?: string[];
}) {
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [errOpen, setErrOpen] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const toast = (text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  const { data: s } = useQuery({
    queryKey: ["sync"],
    queryFn: fetchSyncStatus,
    refetchInterval: 5000,
  });
  const { data: auth } = useQuery({
    queryKey: ["auth"],
    queryFn: () => fetchAuthStatus(),
    refetchInterval: 60_000,
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const country = useCountryCode();
  const lbl = firstPlaceLabel(country); // "#1 FR", "#1 US"… or "Country #1"

  if (!s) return null;

  // the progress bar follows the VIEWED ruleset (specific maps + converts)
  const rsEntry = s.rulesets?.find((r) => r.ruleset === ruleset);
  const bf =
    ruleset === 0 || !rsEntry
      ? { fetched: s.backfill.fetched, total: s.backfill.total }
      : {
          fetched: rsEntry.specificFetched + rsEntry.convertsFetched,
          total: rsEntry.specificTotal + rsEntry.convertsTotal,
        };
  const pct = bf.total > 0 ? (bf.fetched / bf.total) * 100 : 0;
  // pending work in ANY started mode: the backfill process is shared, so the
  // resume button must not depend on the currently viewed ruleset
  const anyPending =
    s.backfill.fetched < s.backfill.total ||
    (s.rulesets ?? []).some(
      (r) =>
        r.started &&
        r.specificFetched + r.convertsFetched <
          r.specificTotal + r.convertsTotal
    );
  // also after a failed attempt (phase "error"): the sync must be retryable
  const needsInit =
    (s.phase === "idle" || s.phase === "error") && s.backfill.fetched === 0;
  const connected = auth?.connected ?? false;
  const ACTION_LABELS = actionLabels(lbl);

  const act = async (a: Parameters<typeof postSync>[0]) => {
    setMenuOpen(false);
    const labels = ACTION_LABELS[a];
    if (labels) toast(labels.start);
    try {
      const r = await postSync(a);
      if ((r as { ok?: boolean }).ok === false)
        toast(`Failed: ${String((r as { error?: string }).error ?? "unknown error")}`);
      else if (labels) toast(labels.done(r));
    } catch (e) {
      toast(`Failed: ${String(e)}`);
    }
    void qc.invalidateQueries({ queryKey: ["sync"] });
  };

  // message freshness: hidden if stale and nothing is running
  const msgFresh =
    s.messageAt != null && Date.now() - Date.parse(s.messageAt) < 5 * 60_000;

  return (
    <div className={`syncbar phase-${s.phase}`}>
      <div className="sync-left">
        <span className={`sync-phase ${s.busy?.length ? "sync-phase-busy" : ""}`}>
          {s.busy?.length
            ? s.busy.join(" + ")
            : PHASE_LABELS[s.phase] ?? s.phase}
        </span>
        <div className="sync-feed">
          {s.activity?.length ? (
            s.activity
              .slice(-3)
              .reverse()
              .map((a, i) => (
                <div key={`${a.at}-${i}`} className="feed-row">
                  <span className="feed-time">
                    {fmtTime(a.at)}
                  </span>
                  <span className="feed-src">{a.source}</span>
                  <span className="feed-text" title={a.text}>
                    {a.text}
                  </span>
                </div>
              ))
          ) : (
            <div className="feed-row feed-empty">
              {s.busy?.length || msgFresh
                ? s.message || "Waiting…"
                : "no background task — automatic polling"}
            </div>
          )}
        </div>
        <button
          className="feed-pop"
          title="Open the activity feed in a separate window"
          onClick={() =>
            window.open(
              "/?activity=1",
              "osu-activity",
              "width=1000,height=700,resizable=yes"
            )
          }
        >
          ⧉
        </button>
        {s.errors.length > 0 && (
          <span className="err-wrap">
            <button className="sync-err" onClick={() => setErrOpen((o) => !o)}>
              ⚠ {s.errors.length} error(s)
            </button>
            {errOpen && (
              <>
                <div className="menu-overlay" onClick={() => setErrOpen(false)} />
                <div className="actions-menu err-panel">
                <div className="err-list">
                  {s.errors
                    .slice()
                    .reverse()
                    .map((e, i) => (
                      <div key={i} className="err-item">
                        {e}
                      </div>
                    ))}
                </div>
                <button
                  onClick={async () => {
                    await postClearErrors();
                    setErrOpen(false);
                    toast("Errors cleared");
                    void qc.invalidateQueries({ queryKey: ["sync"] });
                  }}
                >
                  Clear all
                </button>
                </div>
              </>
            )}
          </span>
        )}
      </div>
      <div className="sync-mid">
        <div
          className="sync-progress"
          title={
            ruleset === 0 || !rsEntry
              ? `Scores fetched for ${fmtNum(bf.fetched)} maps out of ${fmtNum(bf.total)} in the catalog`
              : `${rsEntry.name}: specific ${fmtNum(rsEntry.specificFetched)}/${fmtNum(rsEntry.specificTotal)} + converts ${fmtNum(rsEntry.convertsFetched)}/${fmtNum(rsEntry.convertsTotal)}`
          }
        >
          <div className="sync-progress-fill" style={{ width: `${pct}%` }} />
          <span>
            maps scanned {fmtNum(bf.fetched)}/{fmtNum(bf.total)} ({pct.toFixed(1)}%)
          </span>
        </div>
        <span className="sync-poll">
          last poll: {s.lastPollAt ? fmtTime(s.lastPollAt) : "—"}
          {s.lastPollNewScores > 0 && ` (+${s.lastPollNewScores})`}
        </span>
      </div>
      <div className="sync-actions">
        {(() => {
          // per-mode start, osu!std included: nothing runs for a mode before it
          const rs = s.rulesets?.find((r) => r.ruleset === ruleset);
          if (!rs) return null;
          const action =
            rs.ruleset === 0 ? ("start" as const) : (`start-ruleset/${rs.ruleset}` as const);
          if (!rs.active)
            return (
              <button
                className="primary"
                disabled
                title={`Enable ${rs.name} in Settings first`}
              >
                Start initial {rs.name} sync
              </button>
            );
          if (!rs.started) {
            // Starting another mode already imports the osu! CATALOG (its maps
            // are that mode's converts), but not your osu! scores: this button
            // stays the way to actually track osu! itself.
            const stdIsConvertSource =
              rs.ruleset === 0 &&
              (s.rulesets ?? []).some((r) => r.ruleset !== 0 && r.started);
            return (
              <button
                className="primary"
                title={
                  stdIsConvertSource
                    ? "Adds your osu! scores. The catalog is already there for the converts."
                    : `Import the ${rs.name} catalog, then your scores. Takes days, resumable.`
                }
                onClick={() => act(action)}
              >
                Start initial {rs.name} sync
              </button>
            );
          }
          // started but nothing fetched yet (or a failed attempt): retryable
          return needsInit ? (
            <button
              className="primary"
              title={`No ${rs.name} score imported yet. Run it again.`}
              onClick={() => act(action)}
            >
              Retry initial {rs.name} sync
            </button>
          ) : null;
        })()}
        {(() => {
          const pausedModes = s.backfillPausedModes ?? [];
          const viewedPaused = pausedModes.includes(ruleset);
          const name = ruleset === 0 ? "osu!" : rsEntry?.name ?? "";
          if (viewedPaused)
            return (
              <button
                onClick={() => act(`backfill-resume/${ruleset}`)}
                title={`Resume the ${name} import only`}
              >
                Resume {name} score import
              </button>
            );
          // pause only where it means something: the pass currently running
          // belongs to the viewed mode (other tabs would just be confusing)
          if (s.backfill.running && s.backfillPassRuleset === ruleset)
            return (
              <button
                onClick={() => act(`backfill-pause/${ruleset}`)}
                title={`Pause the ${name} import only`}
              >
                Pause {name} score import
              </button>
            );
          // mode-scoped like the pause above: the bar always talks about the
          // viewed tab, "all modes" lives in the menu
          const viewedPending = rsEntry
            ? rsEntry.specificFetched + rsEntry.convertsFetched <
              rsEntry.specificTotal + rsEntry.convertsTotal
            : anyPending;
          return (
            !needsInit &&
            viewedPending && (
              <button
                onClick={() => act(`backfill-resume/${ruleset}`)}
                title={`Resume the ${name} score import (the other modes are unaffected)`}
              >
                Resume {name} score import
              </button>
            )
          );
        })()}
        {auth && !connected && (
          <button
            className="primary"
            title="Connect your osu! account (required for country leaderboards, supporter needed)"
            onClick={() => window.open("/api/auth/login", "_blank")}
          >
            Connect
          </button>
        )}
        <div className="avatar-wrap">
          <button
            className="avatar-btn"
            title={
              connected
                ? `Connected: ${auth?.profile?.username ?? "osu! account"} — actions & settings`
                : "osu! account not connected — actions & settings"
            }
            onClick={() => setMenuOpen((o) => !o)}
          >
            {connected && auth?.profile ? (
              <img className="avatar-img" src={auth.profile.avatar_url} alt="" />
            ) : (
              "⚙"
            )}
          </button>
          {menuOpen && (
            <>
              <div className="menu-overlay" onClick={() => setMenuOpen(false)} />
              <div className="actions-menu avatar-menu">
              <div className="avatar-head">
                <div className="avatar-name">
                  {connected ? (
                    <>
                      {auth?.profile?.username ?? "osu! account"}{" "}
                      <span className="avatar-ok">connected ✔</span>
                    </>
                  ) : (
                    <span className="avatar-ko">osu! account not connected</span>
                  )}
                </div>
                <button
                  className="gear-btn"
                  onClick={() => {
                    setMenuOpen(false);
                    setAdvancedOpen(true);
                  }}
                  title="Settings: sync intervals, osu! OAuth, Discord, integrations, maintenance"
                >
                  ⚙
                </button>
              </div>
              {!connected && (
                <button
                  className="primary"
                  onClick={() => {
                    setMenuOpen(false);
                    window.open("/api/auth/login", "_blank");
                  }}
                >
                  Connect my osu! account
                </button>
              )}

              <button
                onClick={() => {
                  setMenuOpen(false);
                  setOverlayOpen(true);
                }}
                title="Overlay for OBS: pick the content and grab the browser source URL."
              >
                Stream overlay (OBS)
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setShareOpen(true);
                }}
                title="Snapshot of your stats as a PNG image"
              >
                Share card (PNG)
              </button>

              <details className="menu-group" open>
              <summary className="menu-section">Synchronization</summary>
              {s.backfill.running && (
                <button onClick={() => act("pause")} title="Pause every mode">
                  Pause all score imports
                </button>
              )}
              {((s.backfillPausedModes?.length ?? 0) > 0 || !s.backfill.running) && (
                <button
                  onClick={() => act("resume")}
                  title="Resume every mode and clear the pauses"
                >
                  Resume all score imports
                </button>
              )}
              <button onClick={() => act("poll-now")} title="Fetch your recent scores (24h)">
                Poll new scores
              </button>
              <button
                onClick={() => act("delta-now")}
                title="Catch up on newly ranked/loved maps"
              >
                Catch up on new maps
              </button>
              {s.sweeps.country ? (
                <button onClick={() => act("country-pause")} disabled={!connected}>
                  Pause {lbl} sweep
                  {` (${fmtNum(s.sweeps.countryChecked)}/${fmtNum(
                    s.sweeps.countryChecked + s.sweeps.countryPending
                  )})`}
                </button>
              ) : (
                <button
                  onClick={() => act("country-sweep")}
                  disabled={!connected}
                  title={
                    connected
                      ? "Start/resume checking country leaderboards (resumable)"
                      : "Country leaderboards need a connected osu! account with supporter — use “Connect my osu! account” above"
                  }
                >
                  Start/resume {lbl} sweep
                  {!connected && " (account not connected)"}
                  {connected && s.sweeps.countryPending === 0 && " (all checked)"}
                </button>
              )}
              {s.sweeps.globalTracking || s.sweeps.global ? (
                // Tracking stays on once the sweep is over: new bests are still
                // checked on the spot and held top 100s are re-checked. Saying
                // "pause the sweep" then reads as if it were still running.
                <button
                  onClick={() => act("global-pause")}
                  title={
                    s.sweeps.global || s.sweeps.globalPending > 0
                      ? "Stop the sweep. What is already checked is kept."
                      : "Every played map is checked. Stopping also drops the check on each new best and the periodic re-check of your top 100s."
                  }
                >
                  {s.sweeps.global || s.sweeps.globalPending > 0
                    ? `Pause global tops sweep (${fmtNum(s.sweeps.globalChecked)}/${fmtNum(
                        s.sweeps.globalChecked + s.sweeps.globalPending
                      )})`
                    : `Stop tracking global tops (${fmtNum(s.sweeps.globalChecked)} maps checked)`}
                </button>
              ) : (
                <button
                  onClick={() => act("global-sweep")}
                  title="Track your global top 100 positions. Slow, resumable."
                >
                  Start/resume global tops sweep
                  {s.sweeps.globalPending === 0 &&
                    s.sweeps.globalChecked > 0 &&
                    " (all checked)"}
                </button>
              )}

              </details>
              {connected && (
                <button
                  onClick={async () => {
                    setMenuOpen(false);
                    await postLogout();
                    toast("osu! account disconnected");
                    void qc.invalidateQueries({ queryKey: ["auth"] });
                  }}
                >
                  Log out
                </button>
              )}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
      {advancedOpen && (
        <AdvancedSettings ruleset={ruleset} onClose={() => setAdvancedOpen(false)} notify={toast} />
      )}
      {overlayOpen && (
        <OverlayConfig
          onClose={() => setOverlayOpen(false)}
          ruleset={ruleset}
          pool={pool}
          keys={keys}
        />
      )}
      {shareOpen && (
        <ShareCard
          onClose={() => setShareOpen(false)}
          ruleset={ruleset}
          pool={pool}
          keys={keys}
        />
      )}
    </div>
  );
}
