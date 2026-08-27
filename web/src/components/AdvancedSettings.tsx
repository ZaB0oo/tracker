import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSettings,
  postDiscordTest,
  postDiscordTestBest,
  postImportDb,
  postSettings,
  postImportAny,
  postSync,
  postVerifyDump,
} from "../api";
import { RULESET_NAMES } from "../rulesets";
import { firstPlaceLabel, useCountryCode } from "../country";
import { appConfirm } from "../dialogs";
import { DiscordEditor } from "./DiscordEditor";
import { useEscape } from "../useEscape";

// Electron bridge (desktop/preload.cjs): native file picker + dialogs.
// Absent in a plain browser — built-ins are used instead.
declare global {
  interface Window {
    desktop?: {
      pickFile: (opts?: {
        title?: string;
        filters?: { name: string; extensions: string[] }[];
      }) => Promise<string | null>;
      confirm: (message: string) => boolean;
      alert: (message: string) => void;
    };
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="set-field" title={hint}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * Settings modal: sync intervals, osu! OAuth credentials, Discord
 * notifications and display options — one Save button for everything.
 */
export function AdvancedSettings({
  onClose,
  notify,
  ruleset = 0,
}: {
  onClose: () => void;
  notify?: (msg: string) => void;
  /** viewed ruleset: the scopable maintenance actions apply to it */
  ruleset?: number;
}) {
  useEscape(onClose); // Esc closes the top-most modal
  const modeName = RULESET_NAMES[ruleset] ?? "osu!";
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  const country = useCountryCode();
  const lbl = firstPlaceLabel(country);

  // null = untouched (keep current value)
  const [rpm, setRpm] = useState<string | null>(null);
  const [poll, setPoll] = useState<string | null>(null);
  const [countryH, setCountryH] = useState<string | null>(null);
  const [globalH, setGlobalH] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [dBests, setDBests] = useState<boolean | null>(null);
  const [dMetrics, setDMetrics] = useState<boolean | null>(null);
  const [wither, setWither] = useState<boolean | null>(null);
  const [estPerf, setEstPerf] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [designerOpen, setDesignerOpen] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [importerPath, setImporterPath] = useState<string | null>(null);
  const [rulesets, setRulesets] = useState<number[] | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [maintMsg, setMaintMsg] = useState<string | null>(null);
  const [setIdInput, setSetIdInput] = useState("");

  // maintenance actions run immediately (they are not part of "Save")
  const maint = async (
    a: Parameters<typeof postSync>[0],
    startMsg: string,
    confirmMsg?: string
  ) => {
    if (confirmMsg && !appConfirm(confirmMsg)) return;
    setMaintMsg(startMsg);
    try {
      const r = await postSync(a);
      if ((r as { ok?: boolean }).ok === false)
        setMaintMsg(`Failed: ${String((r as { error?: string }).error ?? "unknown")}`);
      else setMaintMsg("Started: tracked in the sync bar.");
    } catch (e) {
      setMaintMsg(`Failed: ${String(e)}`);
    }
    void qc.invalidateQueries({ queryKey: ["sync"] });
  };

  const importDb = async (f: File) => {
    setMaintMsg("Uploading database…");
    try {
      setMaintMsg(await postImportDb(f));
    } catch (e) {
      setMaintMsg(`Import failed: ${String(e instanceof Error ? e.message : e)}`);
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload: Parameters<typeof postSettings>[0] = {
        display: {
          wither: wither ?? data!.display.wither,
          estPerf: estPerf ?? data!.display.estPerf,
        },
        discord: {
          ...(webhookUrl != null && webhookUrl !== "" ? { webhookUrl } : {}),
          bests: dBests ?? data!.discord.bests,
          metrics: dMetrics ?? data!.discord.metrics,
        },
      };
      // clamp instead of erroring: typing 91 saves the 60 ceiling
      if (rpm != null && rpm !== "")
        payload.apiRpm = Math.min(Math.max(Number(rpm) || 1, 1), data!.apiRpmMax);
      if (poll != null) payload.pollIntervalSeconds = Number(poll);
      if (countryH != null) payload.countryRecheckHours = Number(countryH);
      if (globalH != null) payload.globalRecheckHours = Number(globalH);
      if (clientId != null && clientId !== "") payload.clientId = clientId;
      if (secret !== "") payload.clientSecret = secret;
      if (userId != null && userId !== "") payload.userId = userId;
      if (importerPath != null) payload.lazerImporterPath = importerPath;
      if (rulesets != null) payload.activeRulesets = rulesets;
      await postSettings(payload);
      return Boolean(payload.clientId || payload.clientSecret || payload.userId);
    },
    onSuccess: (oauthTouched) => {
      void qc.invalidateQueries();
      notify?.(
        oauthTouched
          ? "Settings saved. OAuth changed: reconnect your osu! account if needed"
          : "Settings saved (applied immediately)"
      );
      onClose();
    },
    onError: (e: Error) => setSaveMsg(e.message),
  });

  const test = useMutation({
    mutationFn: async () => {
      // save the URL first so the test uses what's in the input
      if (webhookUrl != null && webhookUrl !== "")
        await postSettings({ discord: { webhookUrl } });
      await postDiscordTest();
    },
    onSuccess: () => setTestMsg("Test message sent ✓"),
    onError: (e: Error) => setTestMsg(e.message),
  });
  const testBest = useMutation({
    mutationFn: async () => {
      if (webhookUrl != null && webhookUrl !== "")
        await postSettings({ discord: { webhookUrl } });
      await postDiscordTestBest(ruleset);
    },
    onSuccess: () => setTestMsg("Random best sent ✓"),
    onError: (e: Error) => setTestMsg(e.message),
  });

  if (!data) return null;
  const port = data.info?.port ?? 3727;

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal settings-modal">
        <div className="adv-head">
          <h2>Settings</h2>
          <button className="mm-close" onClick={onClose}>✕</button>
        </div>

        <div className="set-cols">
        <div className="set-col">
        <h3>osu! API (OAuth)</h3>
        <p className="set-note">
          Create an OAuth application in{" "}
          <a href="https://osu.ppy.sh/home/account/edit#oauth" target="_blank" rel="noreferrer">
            your osu! account settings
          </a>{" "}
          (OAuth section → New OAuth application) with this callback URL:
          <code>http://localhost:{port}/api/auth/callback</code>
          then paste its Client ID and secret below, plus your{" "}
          <a href="https://osu.ppy.sh/home/account/edit" target="_blank" rel="noreferrer">
            user id
          </a>{" "}
          (the number in your profile URL). Stored in the local database only.
        </p>
        <div className="set-grid">
          <Field label="Client ID">
            <input
              type="text"
              value={clientId ?? String(data.oauth.clientId ?? "")}
              onChange={(e) => setClientId(e.target.value)}
            />
          </Field>
          <Field label="Client secret" hint="Leave blank to keep it unchanged">
            <input
              type="password"
              placeholder={data.oauth.secretSet ? "••••••••  (unchanged)" : "required"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label="osu! user id"
            hint="⚠ Changing the user id on an existing DB mixes up scores: start from a blank DB in that case"
          >
            <input
              type="text"
              value={userId ?? String(data.oauth.userId || "")}
              onChange={(e) => setUserId(e.target.value)}
            />
          </Field>
        </div>

        <h3>Synchronization</h3>
        <div className="set-grid">
          <Field
            label="API rate (req/min)"
            hint="Shared by EVERYTHING (score import, sweeps, packs…). Default 50 leaves headroom for the game's own traffic; 60 (the documented osu! API limit) is the maximum."
          >
            <input
              type="number" min={1} max={data.apiRpmMax} step={1}
              value={rpm ?? String(data.apiRpm)}
              onChange={(e) => setRpm(e.target.value)}
            />
          </Field>
          <Field
            label="Score polling (s)"
            hint="How often your recent scores are fetched (10 to 3600 s)"
          >
            <input
              type="number" min={10} max={3600} step={10}
              value={poll ?? String(data.pollIntervalSeconds)}
              onChange={(e) => setPoll(e.target.value)}
            />
          </Field>
          <Field
            label={`Re-check ${lbl} (h)`}
            hint="Age at which a held country #1 is re-checked (snipe detection). Runs on the next background tick (every 6 h max)."
          >
            <input
              type="number" min={1} max={720} step={1}
              value={countryH ?? String(data.countryRecheckHours)}
              onChange={(e) => setCountryH(e.target.value)}
            />
          </Field>
          <Field
            label="Re-check global tops (h)"
            hint="Age at which a held global top-100 position is re-checked. Runs on the next background tick, only while global tops tracking is enabled."
          >
            <input
              type="number" min={1} max={720} step={1}
              value={globalH ?? String(data.globalRecheckHours)}
              onChange={(e) => setGlobalH(e.target.value)}
            />
          </Field>
        </div>

        <h3>Rulesets</h3>
        <p className="set-note">
          Each extra ruleset enumerates its own catalog and imports your scores on its maps
          AND the converts (std maps played in that mode): days of API budget
          the first time, resumable. Disabling a mode (osu! included) stops its
          polling, score import and sweeps; its views stay readable. At least one
          mode must stay enabled.
        </p>
        <div className="mb-inline">
          {(
            [
              [0, "osu!"],
              [1, "taiko"],
              [2, "catch"],
              [3, "mania"],
            ] as const
          ).map(([id, label]) => {
            const cur = rulesets ?? data.activeRulesets;
            const on = cur.includes(id);
            return (
              <label key={id} className="mb-check">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && cur.length === 1}
                  onChange={() =>
                    setRulesets(
                      on ? cur.filter((r) => r !== id) : [...cur, id].sort()
                    )
                  }
                />
                {label}
              </label>
            );
          })}
        </div>

        <h3>Display</h3>
        <label className="adv-toggle">
          <input
            type="checkbox"
            checked={wither ?? data.display.wither}
            onChange={(e) => setWither(e.target.checked)}
          />
          <span>
            Show witherscore alongside classic score.{" "}
            <a
              href="https://github.com/ppy/osu/discussions/38224"
              target="_blank"
              rel="noreferrer"
            >
              What is this?
            </a>
          </span>
        </label>
        <p className="set-note">
          From the same author, WitherFlower also proposes a level rework:{" "}
          <a
            href="https://github.com/ppy/osu/discussions/17124#discussioncomment-9581970"
            target="_blank"
            rel="noreferrer"
          >
            witherlevel
          </a>
          .
        </p>
        <label className="adv-toggle">
          <input
            type="checkbox"
            checked={estPerf ?? data.display.estPerf}
            onChange={(e) => setEstPerf(e.target.checked)}
          />
          <span title="Off: the Performance tile uses official pp only">
            Count unranked-mod scores in the Performance tile (their pp is
            estimated locally, the API gives none).
          </span>
        </label>
        </div>

        <div className="set-col">
        <h3>Discord notifications</h3>
        <div className="set-grid set-grid-wide">
          <Field
            label="Webhook URL"
            hint="Channel settings → Integrations → Webhooks. Stored in the local database only."
          >
            <input
              type="password"
              placeholder={
                data.discord.webhookSet
                  ? "webhook configured ✓ (paste to replace, empty to keep)"
                  : "https://discord.com/api/webhooks/…"
              }
              value={webhookUrl ?? ""}
              onChange={(e) => setWebhookUrl(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
        <label className="adv-toggle">
          <input
            type="checkbox"
            checked={dBests ?? data.discord.bests}
            onChange={(e) => setDBests(e.target.checked)}
          />
          <span>Notify new bests (first clears and improvements, batched per poll)</span>
        </label>
        <label className="adv-toggle">
          <input
            type="checkbox"
            checked={dMetrics ?? data.discord.metrics}
            onChange={(e) => setDMetrics(e.target.checked)}
          />
          <span>Notify metric milestones (each step a metric crosses)</span>
        </label>
        <div className="adv-toggle">
          <button disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Sending…" : "Send a test message"}
          </button>
          <button
            disabled={testBest.isPending}
            onClick={() => testBest.mutate()}
            title="A random real best, through the exact live notification pipeline"
          >
            {testBest.isPending ? "Sending…" : "Post a random best"}
          </button>
          <button
            onClick={() => setDesignerOpen(true)}
            title="Design the notification layout with a live Discord preview"
          >
            Customize notification…
          </button>
          {testMsg && <span> {testMsg}</span>}
        </div>
        {designerOpen && (
          <DiscordEditor
            ruleset={ruleset}
            template={data.discord.template}
            templateDefault={data.discord.templateDefault}
            onClose={() => setDesignerOpen(false)}
          />
        )}

        <h3>Integrations</h3>
        <p className="set-note">
          <a
            href="https://github.com/ZaB0oo/LazerCollectionImporter"
            target="_blank"
            rel="noreferrer"
          >
            LazerCollectionImporter
          </a>{" "}
          imports collections straight into osu!lazer: download its .exe, then
          point the field below at it.
        </p>
        <div className="set-grid set-grid-wide">
          <Field
            label="LazerCollectionImporter.exe"
            hint="Absolute path to the LazerCollectionImporter executable: enables one-click import of collections straight into osu!lazer (github.com/ZaB0oo/LazerCollectionImporter)"
          >
            <span className="set-path">
              <input
                type="text"
                placeholder="C:\\Tools\\LazerCollectionImporter.exe (empty = disabled)"
                value={importerPath ?? data.lazerImporterPath}
                onChange={(e) => setImporterPath(e.target.value)}
              />
              {window.desktop && (
                <button
                  onClick={async () => {
                    const p = await window.desktop!.pickFile({
                      title: "Select LazerCollectionImporter.exe",
                      filters: [{ name: "Executable", extensions: ["exe"] }],
                    });
                    if (p) setImporterPath(p);
                  }}
                >
                  Browse…
                </button>
              )}
            </span>
          </Field>
        </div>

        <h3>Maintenance · {modeName}</h3>
        <p className="set-note">
          These actions apply to the ruleset you are viewing ({modeName});
          switch tabs to target another mode. Set-level actions (marked “all
          modes”) benefit every mode at once.
        </p>

        <div className="set-maint-group">
          <span className="set-maint-label">Database</span>
          <div className="set-maint">
          <button
            onClick={() => window.open("/api/export-db")}
            title="Full backup: scores, catalog, settings"
          >
            Export database (.db)
          </button>
          <button
            onClick={() => importInput.current?.click()}
            title="Replace the database with another tracker.db. Applied on restart, the old one is kept as .bak."
          >
            Import database…
          </button>
          <input
            ref={importInput}
            type="file"
            accept=".db"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importDb(f);
            }}
          />
          </div>
        </div>

        <div className="set-maint-group">
          <span className="set-maint-label">
            Catalog: if the number of maps looks wrong
          </span>
          <div className="set-maint">
          <button
            onClick={() =>
              void maint("repair-catalog", "Repairing the catalog…")
            }
            title="Looks for the maps the search cannot see and adds them. Runs on its own after each initial sync, so use it only if a map count looks wrong."
          >
            Check &amp; repair catalog <span className="scope-tag">all modes</span>
          </button>
          <button
            onClick={() => void maint(`catalog-full?force=1&ruleset=${ruleset}`, `Re-scanning the ${modeName} catalog…`)}
            title="Re-reads the whole catalog to refresh star ratings and statuses. 30 to 60 min."
          >
            Full catalog re-scan ({modeName})
          </button>
          <button
            onClick={() => {
              void (async () => {
                let path: string | null = null;
                if (window.desktop) {
                  path = await window.desktop.pickFile({
                    title: "Select a data.ppy.sh dump (performance_*.tar.bz2 or osu_beatmaps.sql)",
                    filters: [
                      { name: "data.ppy.sh dump", extensions: ["bz2", "sql", "tbz2", "tbz"] },
                    ],
                  });
                } else {
                  path = window.prompt?.("Full path to the dump file (.tar.bz2 or osu_beatmaps.sql):") ?? null;
                }
                if (!path) return;
                setMaintMsg("Verifying the catalog against the dump…");
                try {
                  const r = await postVerifyDump(path);
                  setMaintMsg(
                    r.ok ? "Started: progress in the sync bar activity." : `Failed: ${r.error ?? "unknown"}`
                  );
                } catch (e) {
                  setMaintMsg(`Failed: ${String(e instanceof Error ? e.message : e)}`);
                }
              })();
            }}
            title="Last resort if maps are still missing. Compares your catalog with an official data.ppy.sh dump: one archive covers all four modes."
          >
            Advanced: verify from data dump… <span className="scope-tag">all modes</span>
          </button>
          <a
            className="set-link"
            href="https://data.ppy.sh"
            target="_blank"
            rel="noreferrer"
            title="Official osu! dumps. Any performance_*_top_1000.tar.bz2 works."
          >
            Get dumps ↗
          </a>
          <span className="set-path set-import-set">
            <input
              type="text"
              placeholder="id or osu.ppy.sh URL"
              value={setIdInput}
              onChange={(e) => setSetIdInput(e.target.value)}
            />
            <button
              disabled={!setIdInput}
              onClick={() => {
                void (async () => {
                  const input = setIdInput.trim();
                  setMaintMsg(`Importing ${input}…`);
                  try {
                    const r = await postImportAny(input);
                    if (!r.ok) {
                      setMaintMsg(`Failed: ${r.error ?? "unknown"}`);
                      return;
                    }
                    const st = r.statuses ?? {};
                    const counted = (st.ranked ?? 0) + (st.loved ?? 0);
                    setMaintMsg(
                      counted === 0
                        ? `Set ${r.setId} imported (${r.kind}, +${r.newDiffs ?? 0} diffs): no ranked/loved diff, it will NOT appear in any pool`
                        : `Set ${r.setId} imported (${r.kind}): +${r.newDiffs ?? 0} new diffs (${st.ranked ?? 0} ranked, ${st.loved ?? 0} loved)`
                    );
                    setSetIdInput("");
                  } catch (e) {
                    setMaintMsg(`Failed: ${String(e instanceof Error ? e.message : e)}`);
                  }
                })();
              }}
              title="Add a map, set or score: paste an id or any osu.ppy.sh link, even a DMCA'd one. Your scores follow."
            >
              Import id / URL <span className="scope-tag">all modes</span>
            </button>
          </span>
          </div>
        </div>

        <div className="set-maint-group">
          <span className="set-maint-label">Scores</span>
          <div className="set-maint">
          <button
            onClick={() => void maint("recompute", "Recomputing…")}
            title="Recompute bests for all scores"
          >
            Recompute bests <span className="scope-tag">all modes</span>
          </button>
          <button
            onClick={() =>
              void maint(`refresh-top-pp?ruleset=${ruleset}`, `Re-fetching your ${modeName} top pp scores…`)
            }
            title="Re-reads your 250 best maps by pp. Use it when the Profile pp metric drifts. 4 min."
          >
            Refresh top pp scores ({modeName})
          </button>
          <button
            onClick={() =>
              void maint(
                `global-recheck-all?ruleset=${ruleset}`,
                "Re-queuing all global positions…",
                "Re-check ALL global positions (any depth, resumable). The periodic rotation only refreshes held top-100s: use this to refresh everything else. Start?"
              )
            }
            title="Re-queue every played map for a global position check"
          >
            Re-check all global tops ({modeName})
          </button>
          <button
            onClick={() =>
              void maint(
                `rebackfill?ruleset=${ruleset}`,
                "Re-importing every score…",
                "FULL re-backfill: all maps go back to « to check » (resumable, no score lost). Includes a re-sweep of all country leaderboards. Start?"
              )
            }
            title="Use this if the app stayed off > 24h while you were playing"
          >
            Re-import all scores
          </button>
          </div>
        </div>
        {maintMsg && <p className="set-note">{maintMsg}</p>}
        </div>
        </div>

        <div className="adv-actions">
          <button
            className="primary"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save settings"}
          </button>
          <button onClick={onClose}>Cancel</button>
          {saveMsg && <span className="save-error">⚠ {saveMsg}</span>}
        </div>
      </div>
    </>
  );
}
