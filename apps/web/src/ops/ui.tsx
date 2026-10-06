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

/** One label and figure. `value` null or the word "unavailable" is styled as missing. */
export function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string | null;
  note?: string;
}) {
  const missing = value === null || value === UNAVAILABLE;
  return (
    <div className="ops-row">
      <dt>{label}</dt>
      <dd data-figure data-unavailable={missing || undefined}>
        {value ?? UNAVAILABLE}
        {note ? <span className="ops-note">{note}</span> : null}
      </dd>
    </div>
  );
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

/** The line that sits under every on-chain figure: age of the pool's last Sync. */
export function SyncLine({ lastSyncAt }: { lastSyncAt: string }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="ops-sync" data-testid="sync-line">
      {syncLine(lastSyncAt, now)}
    </p>
  );
}

export function Loading() {
  return <p className="ops-sync">Loading</p>;
}
