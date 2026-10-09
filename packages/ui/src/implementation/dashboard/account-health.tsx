import type { AccountAppHealth, AccountCheckStatus, AccountHealth } from "@executor-js/sdk";
import { Exit, Match, type Cause } from "effect";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserCircleIcon } from "@hugeicons/core-free-icons";
import type { AccountDetail, FailureProps } from "../../contracts/dashboard.ts";
import { Avatar, AvatarFallback, AvatarImage } from "../components/avatar.tsx";
import { Button } from "../components/button.tsx";
import { LocalTime, shortMoment } from "../components/local-time.tsx";
import { formatMoment, useDisplayFormat } from "../hooks/display-format.ts";

type AccountInfo = NonNullable<AccountHealth["info"]>;

/** What one app's latest check means for the reader; tone matches the other status pills. */
export const describeAccountCheck = (status: AccountCheckStatus) =>
  Match.value(status).pipe(
    Match.when("healthy", () => ({ label: "Working", tone: "good" as const })),
    Match.when("credentials_rejected", () => ({
      label: "Sign-in rejected",
      tone: "bad" as const,
    })),
    Match.when("forbidden", () => ({ label: "Missing permission", tone: "warn" as const })),
    Match.when("upstream_unavailable", () => ({
      label: "Service unavailable",
      tone: "warn" as const,
    })),
    Match.when("check_failed", () => ({ label: "Check failed", tone: "muted" as const })),
    Match.exhaustive,
  );

const tones = {
  good: "bg-emerald-500",
  bad: "bg-destructive",
  warn: "bg-amber-500",
  muted: "bg-muted-foreground/50",
};

/**
 * One app's latest check as a dot on its app reference. A result from before the account's
 * credentials or the app changed is shown as outdated, never as the current state. Apps without a
 * check, or not yet checked, show nothing.
 */
export function AccountCheckDot({ health }: { readonly health: AccountAppHealth | undefined }) {
  const format = useDisplayFormat();
  const check = health?.check;
  if (check === null || check === undefined) return null;
  const { label, tone } = describeAccountCheck(check.status);
  const text = `${check.current ? label : `${label} (outdated)`}${check.message === undefined ? "" : `: ${check.message}`}`;
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${check.current ? tones[tone] : tones.muted}`}
      data-check-status={check.status}
      data-check-current={check.current}
      role="img"
      aria-label={text}
      title={`${text} · ${formatMoment(new Date(check.checkedAt), format, shortMoment)}`}
      suppressHydrationWarning
    />
  );
}

/**
 * The upstream photo a check reported. The image shows only once it loads, so a missing, broken or
 * slow photo leaves the fallback: a person icon by default, or nothing.
 */
export function AccountAvatar({
  info,
  fallback = true,
  className,
}: {
  readonly info: AccountInfo | null | undefined;
  readonly fallback?: boolean;
  readonly className?: string;
}) {
  const url = info?.avatarUrl;
  if (url === undefined && !fallback) return null;
  return (
    <Avatar className={className ?? "size-4"} data-slot="account-avatar">
      {url !== undefined && <AvatarImage src={url} alt="" referrerPolicy="no-referrer" />}
      {fallback && (
        <AvatarFallback className="bg-transparent">
          <HugeiconsIcon
            icon={UserCircleIcon}
            className="size-full text-muted-foreground"
            aria-hidden
          />
        </AvatarFallback>
      )}
    </Avatar>
  );
}

/** The upstream identity a check reported, for the account heading. */
export function AccountIdentity({ info }: { readonly info: AccountInfo }) {
  const name = info.displayName ?? info.username ?? info.email;
  const secondary = [
    info.username !== undefined && info.username !== name ? `@${info.username}` : undefined,
    info.email !== undefined && info.email !== name ? info.email : undefined,
  ].filter((part) => part !== undefined);
  if (name === undefined) return null;
  return (
    <span className="account-identity inline-flex items-center gap-1.5 min-w-0">
      <AccountAvatar info={info} fallback={false} />
      <span className="wrap-anywhere">
        {info.profileUrl === undefined ? (
          name
        ) : (
          <a
            className="hover:text-foreground"
            href={info.profileUrl}
            target="_blank"
            rel="noreferrer"
          >
            {name}
          </a>
        )}
        {secondary.length > 0 && ` · ${secondary.join(" · ")}`}
      </span>
    </span>
  );
}

/**
 * Each selecting app's latest check, with an action to check again. Opening it checks once when a
 * result is missing or outdated, such as after new credentials.
 */
export function AccountHealthPanel<E>({
  data,
  check,
  Failure,
  actions,
}: {
  readonly data: AccountDetail;
  readonly check: () => Promise<Exit.Exit<AccountHealth, E>>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly actions?: ReactNode;
}) {
  const { apps, health } = data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const checkable = health?.apps.some((entry) => entry.checkable) ?? false;
  const stale =
    health?.apps.some(
      (entry) => entry.checkable && (entry.check === null || !entry.check.current),
    ) ?? false;
  const run = async () => {
    setPending(true);
    setError(undefined);
    const exit = await check();
    setPending(false);
    if (Exit.isFailure(exit)) setError(exit.cause);
  };
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !stale) return;
    opened.current = true;
    void run();
  });
  return (
    <div className="flex flex-col gap-4">
      {health?.info && (
        <p className="text-[13px] text-muted-foreground">
          <AccountIdentity info={health.info} />
        </p>
      )}
      {apps.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No apps use this account, so nothing checks it.
        </p>
      ) : (
        <ul className="flex flex-col text-[13px] [&_>_li+li]:border-t [&_>_li+li]:border-t-border">
          {apps.map((app) => {
            const entry = health?.apps.find((item) => item.app === app.id);
            return (
              <li key={app.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0 wrap-anywhere">{app.name}</span>
                <AccountCheckResult health={entry} />
              </li>
            );
          })}
        </ul>
      )}
      {error && <Failure cause={error} />}
      <div className="flex items-center gap-3">
        <Button
          loading={pending}
          disabledReason={checkable ? undefined : "No app that uses this account defines a check."}
          onClick={() => {
            if (!pending) void run();
          }}
        >
          Check now
        </Button>
        {actions}
      </div>
    </div>
  );
}

/** One app's latest check, spelled out with its time and, when it failed, the reason given. */
export function AccountCheckResult({ health }: { readonly health: AccountAppHealth | undefined }) {
  if (health === undefined || (!health.checkable && health.check === null))
    return <span className="text-[12px] text-muted-foreground">No check</span>;
  if (health.check === null)
    return <span className="text-[12px] text-muted-foreground">Not checked</span>;
  const { label, tone } = describeAccountCheck(health.check.status);
  return (
    <span className="inline-flex min-w-0 flex-col items-end gap-1 text-[12px] text-muted-foreground">
      <span className="inline-flex items-center gap-2">
        <span
          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${health.check.current ? pills[tone] : pills.muted}`}
          data-check-status={health.check.status}
          data-check-current={health.check.current}
        >
          {health.check.current ? label : `${label} · outdated`}
        </span>
        <LocalTime value={health.check.checkedAt} options={shortMoment} />
      </span>
      {health.check.message !== undefined && (
        <span className="max-w-[28rem] text-right wrap-anywhere" data-check-message>
          {health.check.message}
        </span>
      )}
    </span>
  );
}

const pills = {
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  bad: "bg-destructive/10 text-destructive",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  muted: "bg-muted text-muted-foreground",
};
