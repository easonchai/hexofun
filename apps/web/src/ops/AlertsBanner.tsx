import { useOps } from "./useOps.js";

/** Firing alerts from `GET /alerts`. Renders nothing when none fire. */
export function AlertsBanner() {
  const { alerts } = useOps();
  if (alerts.length === 0) return null;
  return (
    <ul className="ops-alerts" role="alert" data-testid="ops-alerts">
      {alerts.map((a) => (
        <li key={a.code}>
          <strong>{a.code}</strong> {a.message}
        </li>
      ))}
    </ul>
  );
}
