import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAuthStatus,
  fetchSettings,
  fetchSyncStatus,
  postClearErrors,
  postLogout,
  postSettings,
  postSync,
} from "../api";
import { AdvancedSettings } from "./AdvancedSettings";
import { OverlayConfig } from "./OverlayConfig";
import { ShareCard } from "./ShareCard";
import { firstPlaceLabel, useCountryCode } from "../country";
import { fmtNum, fmtTime } from "../format";


/** Labels + toasts per action (start / result). `lbl` = "#1 FR", "#1 US"… */
const actionLabels = (
  lbl: string
): Record<string, { start: string; done: (r: Record<string, unknown>) => string }> => ({
  start: { start: "Initial sync started…", done: () => "Initial sync running (tracked in the bar)" },
  pause: { start: "Pausing backfill…", done: () => "Backfill paused" },
  resume: { start: "Resuming backfill…", done: () => "Backfill resumed" },
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
  recompute: {
    start: "Recomputing…",
    done: (r) => `Recompute done: ${fmtNum(Number(r.recomputed ?? 0))} maps`,
  },
  rebackfill: {
    start: "Re-backfill…",
    done: () => `Re-backfill + ${lbl} re-sweep started (tracked in the bar)`,
  },
  "catalog-full?force=1": {
    start: "Re-scanning catalog…",
    done: () => "Catalog re-scan started (tracked in the bar)",
  },
});

const PHASE_LABELS: Record<string, string> = {
  idle: "idle",
  done: "up to date",
  error: "error",
  backfill: "backfill",
  catalog: "catalog",
  enrich: "enrichment",
};

export function SyncBar() {
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
    queryFn: fetchAuthStatus,
    refetchInterval: 60_000,
  });
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });
  const [pollInput, setPollInput] = useState<string | null>(null);
  const [countryRecheckInput, setCountryRecheckInput] = useState<string | null>(null);
  const [globalRecheckInput, setGlobalRecheckInput] = useState<string | null>(null);
  const [clientIdInput, setClientIdInput] = useState<string | null>(null);
  const [secretInput, setSecretInput] = useState<string | null>(null);
  const [userIdInput, setUserIdInput] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const country = useCountryCode();
  const lbl = firstPlaceLabel(country); // "#1 FR", "#1 US"… or "Country #1"

  if (!s) return null;

  const pct =
    s.backfill.total > 0 ? (s.backfill.fetched / s.backfill.total) * 100 : 0;
  const needsInit = s.phase === "idle" && s.backfill.fetched === 0;
  const connected = auth?.connected ?? false;
  const ACTION_LABELS = actionLabels(lbl);

  const act = async (a: Parameters<typeof postSync>[0]) => {
    setMenuOpen(false);
    const labels = ACTION_LABELS[a];
    if (labels) toast(labels.start);
    try {
      const r = await postSync(a);
      if (labels) toast(labels.done(r));
    } catch (e) {
      toast(`Failed: ${String(e)}`);
    }
    void qc.invalidateQueries({ queryKey: ["sync"] });
  };

  const saveSettings = async () => {
    const payload: {
      pollIntervalSeconds?: number;
      countryRecheckHours?: number;
      globalRecheckHours?: number;
      clientId?: string;
      clientSecret?: string;
      userId?: string;
    } = {};
    if (pollInput != null) payload.pollIntervalSeconds = Number(pollInput);
    if (countryRecheckInput != null) payload.countryRecheckHours = Number(countryRecheckInput);
    if (globalRecheckInput != null) payload.globalRecheckHours = Number(globalRecheckInput);
    if (clientIdInput != null && clientIdInput !== "")
      payload.clientId = clientIdInput;
    if (secretInput != null && secretInput !== "")
      payload.clientSecret = secretInput;
    if (userIdInput != null && userIdInput !== "") payload.userId = userIdInput;
    if (Object.keys(payload).length === 0) return;
    const oauthTouched =
      payload.clientId != null ||
      payload.clientSecret != null ||
      payload.userId != null;
    try {
      await postSettings(payload);
      setPollInput(null);
      setCountryRecheckInput(null);
      setGlobalRecheckInput(null);
      setClientIdInput(null);
      setSecretInput(null);
      setUserIdInput(null);
      setMenuOpen(false);
      toast(
        oauthTouched
          ? "Settings saved — OAuth changed: reconnect your osu! account if needed"
          : "Settings saved (applied immediately)"
      );
      void qc.invalidateQueries();
    } catch (e) {
      toast(`Setting rejected: ${String(e)}`);
    }
  };

  // message freshness: hidden if stale and nothing is running
  const msgFresh =
    s.messageAt != null && Date.now() - Date.parse(s.messageAt) < 5 * 60_000;

  return (
    <div className={`syncbar phase-${s.phase}`}>
      <div className="sync-left">
        <span className={`sync-phase ${s.busy?.length ? "sync-phase-busy" : ""}`}>
          {s.busy?.length
            ? `⏳ ${s.busy.join(" + ")}`
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
          title={`Scores fetched for ${fmtNum(s.backfill.fetched)} maps out of ${fmtNum(s.backfill.total)} in the catalog`}
        >
          <div className="sync-progress-fill" style={{ width: `${pct}%` }} />
          <span>
            maps scanned {fmtNum(s.backfill.fetched)}/{fmtNum(s.backfill.total)} ({pct.toFixed(1)}%)
          </span>
        </div>
        <span className="sync-poll">
          last poll: {s.lastPollAt ? fmtTime(s.lastPollAt) : "—"}
          {s.lastPollNewScores > 0 && ` (+${s.lastPollNewScores})`}
        </span>
      </div>
      <div className="sync-actions">
        {needsInit && (
          <button className="primary" onClick={() => act("start")}>
            Start initial sync
          </button>
        )}
        {s.backfill.running ? (
          <button onClick={() => act("pause")}>Pause backfill</button>
        ) : (
          !needsInit &&
          s.backfill.fetched < s.backfill.total && (
            <button onClick={() => act("resume")}>Resume backfill</button>
          )
        )}
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
              <button onClick={() => act("poll-now")} title="Fetch your recent scores (24h)">
                Poll new scores
              </button>
              <button
                onClick={() => act("delta-now")}
                title="Catch up on newly ranked/loved maps"
              >
                Catch up on new maps
              </button>
              {s?.sweeps?.country ? (
                <button onClick={() => act("country-pause")} disabled={!connected}>
                  Pause {lbl} sweep
                </button>
              ) : (
                <button
                  onClick={() => act("country-sweep")}
                  disabled={!connected}
                  title="Start/resume checking country leaderboards (resumable)"
                >
                  Start/resume {lbl} sweep
                </button>
              )}
              {s?.sweeps?.globalTracking || s?.sweeps?.global ? (
                <button
                  onClick={() => act("global-pause")}
                  title="Pause the sweep and disable the periodic re-checks"
                >
                  Pause global tops sweep
                  {s?.sweeps
                    ? ` (${fmtNum(s.sweeps.globalChecked)}/${fmtNum(
                        s.sweeps.globalChecked + s.sweeps.globalPending
                      )})`
                    : ""}
                </button>
              ) : (
                <button
                  onClick={() => act("global-sweep")}
                  title="Track your global top 1/8/15/25/50/100 positions (1 request per played map, resumable; held tops are re-checked periodically)"
                >
                  Start/resume global tops sweep
                </button>
              )}

              </details>
              <details className="menu-group">
              <summary className="menu-section">Settings</summary>
              <div
                className="menu-setting"
                title="How often your new scores are fetched (10 to 3600 s)"
              >
                <span>Score polling (s)</span>
                <input
                  type="number"
                  min={10}
                  max={3600}
                  step={10}
                  value={pollInput ?? String(settings?.pollIntervalSeconds ?? "")}
                  onChange={(e) => setPollInput(e.target.value)}
                />
              </div>
              <div
                className="menu-setting"
                title="Age at which a held country #1 is re-checked (snipe check). It runs on the next background tick (every 6 h max)."
              >
                <span>Re-check {lbl} (h)</span>
                <input
                  type="number"
                  min={1}
                  max={720}
                  step={1}
                  value={countryRecheckInput ?? String(settings?.countryRecheckHours ?? "")}
                  onChange={(e) => setCountryRecheckInput(e.target.value)}
                />
              </div>
              <div
                className="menu-setting"
                title="Age at which a held global top-100 position is re-checked. It runs on the next background tick (every 6 h max), only while global tops tracking is enabled."
              >
                <span>Re-check global tops (h)</span>
                <input
                  type="number"
                  min={1}
                  max={720}
                  step={1}
                  value={globalRecheckInput ?? String(settings?.globalRecheckHours ?? "")}
                  onChange={(e) => setGlobalRecheckInput(e.target.value)}
                />
              </div>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setAdvancedOpen(true);
                }}
                title="Display options"
              >
                Advanced settings…
              </button>
              <button className="primary" onClick={saveSettings}>
                Save settings
              </button>

              </details>
              <details className="menu-group">
              <summary className="menu-section">OAuth osu!</summary>
              <div className="menu-setting" title="Client ID of your osu! application">
                <span>Client ID</span>
                <input
                  type="text"
                  value={clientIdInput ?? String(settings?.oauth?.clientId ?? "")}
                  onChange={(e) => setClientIdInput(e.target.value)}
                />
              </div>
              <div
                className="menu-setting"
                title="Client secret — leave blank to keep it unchanged"
              >
                <span>Client secret</span>
                <input
                  type="password"
                  placeholder={settings?.oauth?.secretSet ? "••••• (unchanged)" : "required"}
                  value={secretInput ?? ""}
                  onChange={(e) => setSecretInput(e.target.value)}
                />
              </div>
              <div
                className="menu-setting"
                title="⚠ Changing the user id on an existing DB mixes up scores: start from a blank DB in that case"
              >
                <span>osu! User ID</span>
                <input
                  type="number"
                  value={userIdInput ?? String(settings?.oauth?.userId ?? "")}
                  onChange={(e) => setUserIdInput(e.target.value)}
                />
              </div>
              <button className="primary" onClick={saveSettings}>
                Save settings
              </button>
              <div className="menu-setting">
                <span className="menu-info">port {settings?.info?.port ?? "…"}</span>
              </div>

              </details>
              <details className="menu-group">
              <summary className="menu-section">Maintenance</summary>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  window.open("/api/export-db");
                }}
                title="Download a consistent copy of the SQLite database (full backup: scores, catalog, settings)"
              >
                Export database (.db)
              </button>
              <button
                onClick={() => act("catalog-full?force=1")}
                title="Full re-enumeration of the catalog via the API: star ratings, statuses up to date (~30-60 min)"
              >
                Full catalog re-scan
              </button>
              <button
                onClick={() => act("recompute")}
                title="Recompute bests for all scores"
              >
                Recompute bests
              </button>
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      "FULL re-backfill: all maps go back to « to check » (~40h, resumable, no score lost). Includes a re-sweep of all country leaderboards. Start?"
                    )
                  )
                    void act("rebackfill");
                }}
                title="Use this if the app stayed off > 24h while you were playing"
              >
                Full re-backfill (~40h)
              </button>
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
              </details>
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
        <AdvancedSettings onClose={() => setAdvancedOpen(false)} />
      )}
      {overlayOpen && <OverlayConfig onClose={() => setOverlayOpen(false)} />}
      {shareOpen && <ShareCard onClose={() => setShareOpen(false)} />}
    </div>
  );
}
