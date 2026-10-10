import { usePageUrl } from "@executor-js/dashboard-start/page";
import { McpConsentLoading } from "@executor-js/ui/dashboard/mcp-consent";
import { AsyncResult } from "effect/reactivity";
import { Avatar, AvatarFallback, AvatarImage } from "@executor-js/ui/components/avatar";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, Navigate, useLocation } from "@tanstack/react-router";
import { Cause, Exit, Option, Schema } from "effect";
import { OrganizationResume } from "../../contracts/navigation.ts";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logout01Icon, Settings05Icon, UnfoldMoreIcon, UserIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState, type ReactNode } from "react";
import { AuthFailed, sessionAtom, signOutAtom } from "../../contracts/auth.ts";
import { Button } from "@executor-js/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@executor-js/ui/components/dropdown-menu";

/** Gate page rendering on a live session. The server independently protects API access. */
export function AuthBoundary({ children }: { readonly children: ReactNode }) {
  const session = useAtomValue(sessionAtom);
  const refresh = useAtomRefresh(sessionAtom);
  const location = useLocation();
  const page = usePageUrl();
  const pathname = location.pathname;
  const current = Option.getOrUndefined(AsyncResult.value(session));
  const [firstUser, setFirstUser] = useState(current?.user.id);
  const changedUser =
    firstUser !== undefined &&
    current !== undefined &&
    current !== null &&
    firstUser !== current.user.id;
  if (firstUser === undefined && current) setFirstUser(current.user.id);
  else if (firstUser !== undefined && current === null) setFirstUser(undefined);
  useEffect(() => {
    if (!changedUser) return;
    if (
      Option.isSome(
        Schema.decodeUnknownOption(OrganizationResume)(location.state.organizationResume),
      )
    )
      window.location.replace("/");
    else window.location.reload();
  }, [changedUser, location.state.organizationResume]);
  if (pathname === "/login") return children;
  if (changedUser) return null;
  if (current === undefined) {
    if (AsyncResult.isFailure(session))
      return (
        <main className="flex min-h-dvh items-center justify-center gap-4" role="alert">
          <p>Unable to check your session.</p>
          <Button variant="outline" onClick={refresh}>
            Try again
          </Button>
        </main>
      );
    return pathname === "/mcp/authorize" || pathname === "/device" ? (
      <McpConsentLoading />
    ) : (
      <div className="min-h-dvh" aria-busy="true" aria-label="Opening Executor" />
    );
  }
  // Keep signed OAuth queries intact instead of using the router's reserialized href.
  if (current === null)
    return (
      <Navigate
        to="/login"
        search={{
          redirect: page.pathname + page.search + page.hash,
        }}
        replace
      />
    );
  return (
    <>
      {children}
      {AsyncResult.isFailure(session) && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-lg border bg-background p-3 text-sm shadow-sm"
        >
          <p>Unable to refresh your session.</p>
          <Button variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * The signed-in identity. In the dashboard sidebar it opens a menu with the personal settings
 * and sign-out; entry pages pass a label and get a plain sign-out control instead.
 */
export function SessionMenu({
  signOutLabel,
  organization,
}: {
  readonly signOutLabel?: string;
  /** The organization the visitor is in, so account pages know where to return. */
  readonly organization?: string | undefined;
} = {}) {
  const session = AsyncResult.value(useAtomValue(sessionAtom));
  const signOut = useAtomSet(signOutAtom, { mode: "promiseExit" });
  const state = useAtomValue(signOutAtom);
  const [error, setError] = useState<string | null>(null);
  if (Option.isNone(session) || session.value === null) return null;
  // Email-code accounts can have no personal display name. Their email still
  // identifies the signed-in account independently of the selected team.
  const name = session.value.user.name.trim();
  const email = session.value.user.email;
  const identity = name.length > 0 ? name : email;
  const image = session.value.user.image;
  const avatar = (
    <Avatar className="size-7 border" aria-hidden>
      {image && <AvatarImage src={image} alt="" referrerPolicy="no-referrer" />}
      <AvatarFallback>
        <HugeiconsIcon icon={UserIcon} strokeWidth={2} aria-hidden size={14} />
      </AvatarFallback>
    </Avatar>
  );
  const leave = async () => {
    setError(null);
    const result = await signOut();
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause);
      setError(failure instanceof AuthFailed ? failure.message : "Unable to sign out. Try again.");
    }
  };
  if (signOutLabel !== undefined)
    return (
      <div className="session-menu [&_p]:text-destructive [&_p]:text-[13px] flex flex-wrap items-center gap-2 [padding:10px_4px_0] text-[12px] [&_>_button]:text-muted-foreground [&_>_button:hover]:text-foreground [&_>_p]:basis-[100%] max-[640px]:[&_>_button]:min-w-10 max-[640px]:[&_>_button]:min-h-10">
        {avatar}
        <span
          className="session-name flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
          title={identity}
        >
          {identity}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Sign out"
          title="Sign out"
          disabled={state.waiting}
          onClick={leave}
        >
          <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} aria-hidden size={15} />
          {signOutLabel}
        </Button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  return (
    <div className="session-menu [&_p]:text-destructive [&_p]:text-[13px] flex flex-wrap items-center gap-2 [padding:10px_4px_0] text-[12px] [&_>_p]:basis-[100%]">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-[6px] p-[6px] text-left text-[12px] hover:bg-accent [&[data-state='open']]:bg-accent disabled:cursor-wait disabled:opacity-60"
          aria-label={`Account: ${identity}`}
          disabled={state.waiting}
        >
          {avatar}
          <span
            className="session-name flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
            title={identity}
          >
            {identity}
          </span>
          <span className="session-name flex shrink-0 items-center justify-center text-muted-foreground">
            <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} size={14} aria-hidden />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-[248px] max-w-[calc(100vw-24px)] rounded-lg p-[5px] shadow-[0_8px_24px_#0003]"
          side="top"
          sideOffset={6}
          align="start"
          collisionPadding={12}
          aria-label="Account menu"
          loop
        >
          <DropdownMenuLabel className="min-w-0 py-2 font-normal">
            {name.length > 0 && <div className="truncate text-[13px] font-medium">{name}</div>}
            <div className="truncate text-xs text-muted-foreground" title={email}>
              {email}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="min-h-9 cursor-pointer p-2 text-[13px]">
            <Link to="/account/profile" search={{ organization }}>
              <HugeiconsIcon icon={Settings05Icon} strokeWidth={2} size={16} aria-hidden />
              Account settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-9 cursor-pointer p-2 text-[13px]" onSelect={leave}>
            <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} size={16} aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
