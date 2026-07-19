import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, postSettings } from "../api";

/**
 * Advanced settings modal: display options only. Completion, FC counts and
 * everything else are driven by the built-in "any full combo" rule and by the
 * custom metrics you create in the Metrics tab.
 */
export function AdvancedSettings({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  const [wither, setWither] = useState<boolean | null>(null);

  const save = useMutation({
    mutationFn: postSettings,
    onSuccess: () => {
      void qc.invalidateQueries();
      onClose();
    },
  });

  if (!data) return null;
  const curWither = wither ?? data.display.wither;

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

        <div className="adv-actions">
          <button
            className="primary"
            disabled={save.isPending}
            onClick={() => save.mutate({ display: { wither: curWither } })}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  );
}
