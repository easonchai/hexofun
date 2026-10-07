/** Layout pieces shared by every Ops panel, so a new panel is one file. */
import { useEffect, useState, type ReactNode } from "react";

import { syncLine, UNAVAILABLE } from "./format.js";

export function Panel({
  id,
  title,
  children,
}: {
  /** Becomes `data-testid="panel-<id>"`. */
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="ops-panel" data-testid={`panel-${id}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * One label and figure. `value` null or the word "unavailable" is styled as
 * missing. `raw` (slot, atomic amount, bps, address) shows only while the
 * header's "Show raw" toggle is on.
 */
export function Row({
  label,
  value,
  note,
  raw,
}: {
  label: string;
  value: string | null;
  note?: string;
  raw?: string | number | null | undefined;
}) {
  const missing = value === null || value === UNAVAILABLE;
  return (
    <div className="ops-row">
      <dt>{label}</dt>
      <dd data-figure data-unavailable={missing || undefined}>
        {value ?? UNAVAILABLE}
        {note ? <span className="ops-note">{note}</span> : null}
        {raw != null ? <span className="ops-raw">{raw}</span> : null}
      </dd>
    </div>
  );
}

/**
 * A boolean the viewer sets once and the page remembers (raw toggle, open
 * sections). A blocked store falls back to `initial` and the page still works.
 */
export function useStoredFlag(key: string, initial = false): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Not remembered this time; the toggle itself still works.
    }
  };
  return [value, set];
}

/** "On" or "Off" for a pause switch; red when halted. */
export function Switch({ label, on }: { label: string; on: boolean | null }) {
  return (
    <div className="ops-row">
      <dt>{label}</dt>
      <dd data-figure data-unavailable={on === null || undefined} data-halted={on || undefined}>
        {on === null ? UNAVAILABLE : on ? "Paused" : "Running"}
      </dd>
    </div>
  );
}

/** The viewer's clock in unix seconds, refreshed every second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The line that sits under every on-chain figure: age of the pool's last Sync. */
export function SyncLine({ lastSyncAt }: { lastSyncAt: string }) {
  const now = useNow();
  return (
    <p className="ops-sync" data-testid="sync-line">
      {syncLine(lastSyncAt, now)}
    </p>
  );
}

export function Loading() {
  return <p className="ops-sync">Loading</p>;
}
