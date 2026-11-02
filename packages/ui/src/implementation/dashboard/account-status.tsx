import type { AccountStatus } from "apps";
import { LocalTime, shortMoment } from "../components/local-time.tsx";

const tones = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "bg-destructive/10 text-destructive",
};

/** Display only. Text never becomes HTML, links, credentials or an authorization decision. */
export function AccountDisplayStatus({
  status,
  current,
}: {
  readonly status: AccountStatus;
  readonly current: boolean;
}) {
  return (
    <span
      role="group"
      aria-label={current ? "Account status" : "Account status, outdated"}
      className="flex max-w-[28rem] min-w-0 flex-col items-end gap-1.5 text-[11px] text-muted-foreground"
    >
      {status.badges.length > 0 && (
        <span className="flex flex-wrap justify-end gap-1">
          {status.badges.map((badge, index) => (
            <span
              key={index}
              className={`rounded-full px-2 py-0.5 font-medium wrap-anywhere ${current ? tones[badge.tone] : tones.neutral}`}
            >
              {badge.label}
            </span>
          ))}
        </span>
      )}
      {status.meters.map((meter, index) => (
        <span
          key={index}
          className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5"
        >
          <span className="wrap-anywhere">{meter.label}</span>
          {meter.remaining === null ? (
            <span>Unknown</span>
          ) : (
            <>
              <span
                role="meter"
                aria-label={meter.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(meter.remaining * 100)}
                aria-valuetext={`${Math.round(meter.remaining * 100)}% remaining`}
                className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
              >
                <span
                  className={`block h-full ${current ? "bg-foreground/60" : "bg-muted-foreground/40"}`}
                  style={{ width: `${meter.remaining * 100}%` }}
                />
              </span>
              <span className="tabular-nums">{Math.round(meter.remaining * 100)}% remaining</span>
            </>
          )}
          {meter.resetsAt !== undefined && (
            <span>
              Resets <LocalTime value={new Date(meter.resetsAt)} options={shortMoment} />
            </span>
          )}
          {meter.detail !== undefined && (
            <span className="basis-full text-right wrap-anywhere">{meter.detail}</span>
          )}
        </span>
      ))}
      {status.stats.length > 0 && (
        <span className="flex flex-wrap justify-end gap-x-3 gap-y-0.5">
          {status.stats.map((stat, index) => (
            <span key={index} className="wrap-anywhere">
              {stat.label}: <span className="tabular-nums">{stat.value}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
