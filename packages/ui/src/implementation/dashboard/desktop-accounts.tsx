import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Home01Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState, type MouseEvent, type ReactNode } from "react";
import type { DesktopAccount } from "apps/ui/contracts";
import {
  currentDesktopAccount,
  desktopAccountAtom,
  desktopAccountMenuAtom,
  desktopHostFailure,
  DesktopHostFailed,
} from "../../contracts/desktop.ts";
import { cn } from "../lib/utils.ts";
import { useDesktopHost } from "./desktop-app.tsx";

const markColors = ["#4b5bd6", "#2c8a63", "#8a4bd6", "#c2372f", "#c27a1f", "#1f7ac2"];
const markColor = (name: string) =>
  markColors[[...name].reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 6];
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";

function AccountMark({ account }: { readonly account: DesktopAccount }) {
  return (
    <span
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold text-white",
        account.kind === "local" ? "bg-muted text-foreground" : "",
      )}
      style={account.kind === "local" ? undefined : { background: markColor(account.team) }}
      aria-hidden
    >
      {account.kind === "local" ? (
        <HugeiconsIcon icon={Home01Icon} strokeWidth={2} size={12} />
      ) : (
        initial(account.team)
      )}
      {(account.state === "sign-in-again" || account.state === "unreachable") && (
        <span
          className={cn(
            "absolute -right-[3px] -bottom-[3px] size-[9px] rounded-full border-2 border-popover",
            account.state === "sign-in-again" ? "bg-amber-500" : "bg-muted-foreground",
          )}
        />
      )}
    </span>
  );
}

export function DesktopAccountMenu({
  fallback,
  person,
  avatar,
  onSettings,
}: {
  readonly fallback: ReactNode;
  readonly person?: { readonly name: string; readonly email: string } | undefined;
  readonly avatar?: ReactNode;
  readonly onSettings?: (() => void) | undefined;
}) {
  const host = useDesktopHost();
  if (host === undefined || currentDesktopAccount() === undefined) return fallback;
  return (
    <DesktopAccountButton
      fallback={fallback}
      person={person}
      avatar={avatar}
      onSettings={onSettings}
    />
  );
}

function DesktopAccountButton({
  fallback,
  person,
  avatar,
  onSettings,
}: {
  readonly fallback: ReactNode;
  readonly person: { readonly name: string; readonly email: string } | undefined;
  readonly avatar: ReactNode;
  readonly onSettings: (() => void) | undefined;
}) {
  const result = useAtomValue(desktopAccountAtom);
  const openMenu = useAtomSet(desktopAccountMenuAtom, { mode: "promiseExit" });
  const [failed, setFailed] = useState(false);
  const value = AsyncResult.value(result);
  if (Option.isNone(value)) return AsyncResult.isFailure(result) ? fallback : <PillSkeleton />;
  const current = value.value;
  const title = current.kind === "local" ? "This computer" : current.team;
  const personName = person === undefined ? "" : person.name.trim() || person.email;
  const show = async (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setFailed(false);
    const exit = await openMenu({
      anchor: { x: box.x, y: box.y, width: box.width, height: box.height },
      settings: onSettings !== undefined,
    });
    if (Exit.isFailure(exit)) return setFailed(true);
    if (exit.value === "settings") onSettings?.();
  };
  return (
    <div className="session-menu flex flex-wrap items-center gap-2 [padding:10px_4px_0] text-[12px] [&_>_p]:basis-[100%]">
      <button
        type="button"
        className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-[6px] p-[6px] text-left text-[12px] hover:bg-accent"
        aria-haspopup="menu"
        aria-label={`Account: ${title}`}
        onClick={(event) => void show(event)}
      >
        {avatar !== undefined && current.kind !== "local" ? (
          avatar
        ) : (
          <AccountMark account={current} />
        )}
        <span className="session-name min-w-0 flex-1">
          <span className="block truncate font-medium" title={title}>
            {title}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {current.kind === "local" ? "local" : personName}
          </span>
        </span>
        <span className="session-name flex shrink-0 items-center justify-center text-muted-foreground">
          <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} size={14} aria-hidden />
        </span>
      </button>
      {failed && (
        <p className="text-[13px] text-destructive" role="alert">
          {desktopHostFailure(new DesktopHostFailed({ action: "account" }))}
        </p>
      )}
    </div>
  );
}

function PillSkeleton() {
  return (
    <div className="session-menu [padding:10px_4px_0]" aria-busy aria-label="Loading accounts">
      <div className="flex min-h-10 items-center gap-2 p-[6px]">
        <span className="size-7 shrink-0 rounded-[6px] bg-muted" />
        <span className="session-name grid flex-1 gap-1">
          <span className="h-3 w-20 rounded bg-muted" />
          <span className="h-2.5 w-14 rounded bg-muted" />
        </span>
      </div>
    </div>
  );
}
