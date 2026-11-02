import type { AccountStatus } from "apps";

const tones = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "bg-destructive/10 text-destructive",
};

const meterState = (remaining: number | null) =>
  remaining === null
    ? "unknown"
    : remaining === 0
      ? "exhausted"
      : remaining < 0.3
        ? "warning"
        : "neutral";

const meterFill = {
  neutral: "bg-foreground/60",
  warning: "bg-amber-500",
  exhausted: "bg-destructive",
  unknown: "",
};

const resetLabel = (value: string | undefined) => {
  if (value === undefined) return "Reset unknown";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return "Reset unknown";
  const units = [
    [31_536_000, "year"],
    [2_592_000, "month"],
    [604_800, "week"],
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ] as const;
  const unit = units.find(([size]) => Math.abs(seconds) >= size);
  if (unit === undefined) return seconds >= 0 ? "in less than a minute" : "less than a minute ago";
  const amount = Math.max(1, Math.ceil(Math.abs(seconds) / unit[0]));
  const count = `${amount} ${unit[1]}${amount === 1 ? "" : "s"}`;
  return seconds >= 0 ? `in ${count}` : `${count} ago`;
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
      className="flex w-full min-w-0 flex-col gap-2 text-[11px] text-foreground/80"
    >
      {status.badges.length > 0 && (
        <span className="flex flex-wrap gap-1">
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
      {status.meters.length > 0 && (
        <span className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-2 min-[740px]:grid-cols-2">
          {status.meters.map((meter, index) => {
            const state = meterState(meter.remaining);
            const percent =
              meter.remaining === null ? undefined : Math.round(meter.remaining * 100);
            const reset = resetLabel(meter.resetsAt);
            const stateLabel =
              state === "warning" ? " · Low" : state === "exhausted" ? " · Exhausted" : "";
            return (
              <span key={index} className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-foreground">{meter.label}</span>
                  <span className="shrink-0 tabular-nums" data-meter-remaining>
                    {percent === undefined ? "Rem unknown" : `Rem ${percent}%${stateLabel}`}
                  </span>
                </span>
                <span
                  role="meter"
                  aria-label={meter.label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  {...(percent === undefined ? {} : { "aria-valuenow": percent })}
                  aria-valuetext={`${percent === undefined ? "Remaining amount unknown" : `Rem ${percent}%${stateLabel}`}, ${reset}`}
                  data-meter-state={state}
                  className={`account-meter-track h-1.5 overflow-hidden rounded-full bg-muted meter-${state} ${state === "unknown" ? "bg-[repeating-linear-gradient(135deg,var(--color-muted)_0_3px,var(--color-muted-foreground)_3px_4px)]" : ""}`}
                >
                  {percent !== undefined && (
                    <span
                      className={`account-meter-fill meter-fill-${state} ${meterFill[state]} block h-full rounded-full`}
                      style={{ width: `${percent}%` }}
                    />
                  )}
                </span>
                <span className="flex min-w-0 flex-wrap justify-between gap-x-2 gap-y-0.5">
                  <span>{reset}</span>
                  {meter.detail !== undefined && (
                    <span className="wrap-anywhere">{meter.detail}</span>
                  )}
                </span>
              </span>
            );
          })}
        </span>
      )}
      {status.stats.length > 0 && (
        <span className="flex flex-wrap gap-x-3 gap-y-0.5">
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
