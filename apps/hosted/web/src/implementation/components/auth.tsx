import { McpConsentLoading } from "@executor-js/ui/dashboard/mcp-consent";
import { AsyncResult } from "effect/unstable/reactivity";
import { Avatar, AvatarFallback, AvatarImage } from "@executor-js/ui/components/avatar";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Navigate, useLocation } from "@tanstack/react-router";
import { Cause, Exit, Option, Schema } from "effect";
import { OrganizationResume } from "../../contracts/navigation.ts";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logout01Icon, UserIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState, type ReactNode } from "react";
import { AuthFailed, sessionAtom, signOutAtom } from "../../contracts/auth.ts";
import { Button } from "@executor-js/ui/components/button";

/** Gate page rendering on a live session. The server independently protects API access. */
export function AuthBoundary({ children }: { readonly children: ReactNode }) {
  const session = useAtomValue(sessionAtom);
  const refresh = useAtomRefresh(sessionAtom);
  const location = useLocation();
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
    return pathname === "/mcp/authorize" ? (
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
          redirect: window.location.pathname + window.location.search + window.location.hash,
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

/** Compact identity and logout control, also visible on mobile. */
export function SessionMenu({ signOutLabel }: { readonly signOutLabel?: string } = {}) {
  const session = AsyncResult.value(useAtomValue(sessionAtom));
  const signOut = useAtomSet(signOutAtom, { mode: "promiseExit" });
  const state = useAtomValue(signOutAtom);
  const [error, setError] = useState<string | null>(null);
  if (Option.isNone(session) || session.value === null) return null;
  // Email-code accounts can have no personal display name. Their email still
  // identifies the signed-in account independently of the selected team.
  const name = session.value.user.name.trim();
  const identity = name.length > 0 ? name : session.value.user.email;
  const image = session.value.user.image;
  return (
    <div className="session-menu [&_p]:text-destructive [&_p]:text-[13px] flex flex-wrap items-center gap-2 [padding:10px_4px_0] text-[12px] [&_>_button]:text-muted-foreground [&_>_button:hover]:text-foreground [&_>_p]:basis-[100%] max-[640px]:[&_>_button]:min-w-10 max-[640px]:[&_>_button]:min-h-10">
      <Avatar className="size-7 border" aria-hidden>
        {image && <AvatarImage src={image} alt="" referrerPolicy="no-referrer" />}
        <AvatarFallback>
          <HugeiconsIcon icon={UserIcon} strokeWidth={2} aria-hidden size={14} />
        </AvatarFallback>
      </Avatar>
      <span
        className="session-name flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        title={identity}
      >
        {identity}
      </span>
      <Button
        variant="ghost"
        size={signOutLabel === undefined ? "icon-sm" : "sm"}
        aria-label="Sign out"
        title="Sign out"
        disabled={state.waiting}
        onClick={async () => {
          setError(null);
          const result = await signOut();
          if (Exit.isFailure(result)) {
            const error = Cause.squash(result.cause);
            setError(
              error instanceof AuthFailed ? error.message : "Unable to sign out. Try again.",
            );
          }
        }}
      >
        <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} aria-hidden size={15} />
        {signOutLabel}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
