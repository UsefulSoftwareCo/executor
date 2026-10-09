import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Redacted } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { Button } from "@executor-js/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { LocalTime, shortMoment } from "@executor-js/ui/components/local-time";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import {
  AccountFailed,
  revokeOtherSessionsAtom,
  revokeSessionAtom,
  sessionsAtom,
  type SessionSummary,
} from "../../contracts/account.ts";
import {
  SessionsPending,
  accountSettingClass,
  securityDescription,
  securityTitle,
} from "../components/account-pending.tsx";

export const securityErrorMessage = (cause: Cause.Cause<AccountFailed>) => {
  const error = Cause.squash(cause);
  return error instanceof AccountFailed ? error.message : "Unable to update sign-in. Try again.";
};
const actionClass =
  "flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10";

/** A readable device label from the user agent; API clients rarely send a browser one. */
export const describeClient = (userAgent: string | null | undefined): string => {
  if (!userAgent) return "API client";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : undefined;
  const system = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /CrOS/.test(userAgent)
            ? "ChromeOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : undefined;
  if (browser === undefined) return system === undefined ? "API client" : `Client on ${system}`;
  return system === undefined ? browser : `${browser} on ${system}`;
};

/**
 * How this person signs in. Hosts add their own sign-in sections (passkeys, password); every
 * host shows the signed-in sessions.
 */
export function SecurityPage({ children }: { readonly children?: ReactNode }) {
  useDocumentTitle(productTitle(securityTitle));
  return (
    <PageFrame>
      <PageHeader title={securityTitle} description={securityDescription} />
      <div className="flex flex-col gap-3">
        {children}
        <Sessions />
      </div>
    </PageFrame>
  );
}

function Sessions() {
  const sessions = useAtomValue(sessionsAtom);
  const retry = useAtomRefresh(sessionsAtom);
  const revokeOthers = useAtomSet(revokeOtherSessionsAtom, { mode: "promiseExit" });
  const revoking = useAtomValue(revokeOtherSessionsAtom);
  const [error, setError] = useState<string>();
  if (AsyncResult.isInitial(sessions)) return <SessionsPending />;
  const others = AsyncResult.isSuccess(sessions)
    ? sessions.value.sessions.filter((session) => session.id !== sessions.value.current)
    : [];
  return (
    <Card className={accountSettingClass}>
      <CardHeader>
        <CardTitle>
          <h2>Active sessions</h2>
        </CardTitle>
        <CardDescription>Browsers and clients signed in as you.</CardDescription>
      </CardHeader>
      <CardContent>
        {AsyncResult.isFailure(sessions) ? (
          <div className="flex items-center justify-between gap-2 text-[13px] text-destructive">
            <span role="alert">Could not load your sessions.</span>
            <Button variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : (
          <ul className="divide-y rounded-[6px] border" aria-label="Active sessions">
            {sessions.value.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                current={session.id === sessions.value.current}
              />
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="auth-error mt-3 text-destructive text-[13px]">
            {error}
          </p>
        )}
      </CardContent>
      <CardFooter>
        <p>Signing out a session does not revoke personal access tokens.</p>
        <div className={actionClass}>
          <Button
            variant="outline"
            loading={revoking.waiting}
            disabled={others.length === 0}
            disabledReason={others.length === 0 ? "No other sessions are signed in." : undefined}
            onClick={async () => {
              setError(undefined);
              const result = await revokeOthers();
              if (Exit.isFailure(result)) setError(securityErrorMessage(result.cause));
            }}
          >
            Sign out other sessions
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function SessionRow({
  session,
  current,
}: {
  readonly session: SessionSummary;
  readonly current: boolean;
}) {
  const revoke = useAtomSet(revokeSessionAtom(session.id), { mode: "promiseExit" });
  const state = useAtomValue(revokeSessionAtom(session.id));
  const [error, setError] = useState<string>();
  const client = describeClient(session.userAgent);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{client}</span>
          {current && (
            <span className="rounded-full border px-1.5 py-px text-[11px] text-muted-foreground">
              This browser
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted-foreground">
          {session.ipAddress ? `${session.ipAddress} · ` : ""}
          Last active <LocalTime value={session.updatedAt} options={shortMoment} /> · Signed in{" "}
          <LocalTime value={session.createdAt} options={shortMoment} />
        </div>
        {error && (
          <p role="alert" className="auth-error mt-1 text-destructive text-[12px]">
            {error}
          </p>
        )}
      </div>
      {!current && (
        <Button
          variant="outline"
          size="sm"
          loading={state.waiting}
          aria-label={`Sign out ${client}`}
          onClick={async () => {
            setError(undefined);
            const result = await revoke(Redacted.value(session.token));
            if (Exit.isFailure(result)) setError(securityErrorMessage(result.cause));
          }}
        >
          Sign out
        </Button>
      )}
    </li>
  );
}
