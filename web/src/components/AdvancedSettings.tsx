import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, postDiscordTest, postSettings } from "../api";

/**
 * Advanced settings modal: display options only. Completion, FC counts and
 * everything else are driven by the built-in "any full combo" rule and by the
 * custom metrics you create in the Metrics tab.
 */
export function AdvancedSettings({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  const [wither, setWither] = useState<boolean | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null); // null = unchanged
  const [dBests, setDBests] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: postSettings,
    onSuccess: () => {
      void qc.invalidateQueries();
      onClose();
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      // save the URL first so the test uses what's in the input
      if (webhookUrl != null) await postSettings({ discord: { webhookUrl } });
      await postDiscordTest();
    },
    onSuccess: () => setTestMsg("Test message sent ✓"),
    onError: (e: Error) => setTestMsg(e.message),
  });

  if (!data) return null;
  const curWither = wither ?? data.display.wither;
  const curBests = dBests ?? data.discord.bests;

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal">
        <div className="adv-head">
          <h2>Advanced settings</h2>
          <button className="mm-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <h3>Display</h3>
        <label className="adv-toggle">
          <input
            type="checkbox"
            checked={curWither}
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

        <h3>Discord notifications</h3>
        <label className="adv-toggle">
          <input
            type="password"
            className="adv-input"
            placeholder={
              data.discord.webhookSet
                ? "webhook configured ✓ (paste to replace, empty to keep)"
                : "https://discord.com/api/webhooks/…"
            }
            value={webhookUrl ?? ""}
            onChange={(e) => setWebhookUrl(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="adv-toggle">
          <input
            type="checkbox"
            checked={curBests}
            onChange={(e) => setDBests(e.target.checked)}
          />
          <span>New bests (first clears and improvements, batched per poll)</span>
        </label>
        <div className="adv-toggle">
          <button disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Sending…" : "Send a test message"}
          </button>
          {testMsg && <span> {testMsg}</span>}
        </div>

        <div className="adv-actions">
          <button
            className="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                display: { wither: curWither },
                discord: {
                  ...(webhookUrl != null && webhookUrl !== ""
                    ? { webhookUrl }
                    : {}),
                  bests: curBests,
                },
              })
            }
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  );
}
