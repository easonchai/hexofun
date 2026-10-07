import { bannerOf, goToAction, playbookHref, type OpsAction } from "./opsMap.js";
import { useOps } from "./useOps.js";

const ACTION_LABEL: Record<OpsAction, string> = {
  deploy: "Deploy to venue",
  recall: "Recall",
  harvest: "Harvest",
  withdraw: "Process withdraw",
  cover: "Cover deficit",
  void: "Void round",
  rollover: "Roll over epoch",
  venueSwitch: "Venue switch",
  fundJackpot: "Fund jackpot",
  setVenueParams: "Set venue params",
  "pause-deploy": "Deployment switch",
};

/**
 * The page's first answer: is anything wrong, and what do I press. Green when
 * nothing needs a person; else one line per alert and per todo the bot cannot
 * be trusted with, each with its button and playbook.
 */
export function AlertsBanner() {
  const { alerts, summary } = useOps();
  const banner = bannerOf(alerts, summary?.todo ?? [], summary?.stuck !== null);
  return (
    <section className="ops-banner" data-state={banner.state} data-testid="ops-alerts" role="status">
      {banner.lines.length === 0 ? (
        <p className="ops-banner-ok">{summary ? "Nothing needs you" : "Loading"}</p>
      ) : (
        <ul>
          {banner.lines.map((l) => (
            <li key={l.code} data-severity={l.severity}>
              <span className="ops-banner-text">{l.message}</span>
              {l.action && (
                <button type="button" onClick={() => l.action && goToAction(l.action)}>
                  {ACTION_LABEL[l.action]}
                </button>
              )}
              <a href={playbookHref(l.playbook ?? l.code)} target="_blank" rel="noopener noreferrer">
                Playbook
              </a>
            </li>
          ))}
        </ul>
      )}
      {banner.bot.length > 0 && (
        <ul className="ops-banner-bot">
          {banner.bot.map((t) => (
            <li key={t.code}>{t.message}, the bot will handle it on its next tick.</li>
          ))}
        </ul>
      )}
    </section>
  );
}
