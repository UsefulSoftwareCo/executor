import { Link } from "@tanstack/react-router";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import { AccountFailed, renameUserAtom } from "../../contracts/account.ts";
import { sessionAtom } from "../../contracts/auth.ts";
import { organizationsAtom } from "../../contracts/organization.ts";
import {
  AccountSettingPending,
  accountSettingClass,
  readOnlyInputClass,
  profileDescription,
  profileTitle,
} from "../components/account-pending.tsx";
import { OrganizationAvatar } from "../components/organization.tsx";

const errorMessage = (cause: Cause.Cause<AccountFailed>) => {
  const error = Cause.squash(cause);
  return error instanceof AccountFailed ? error.message : "Unable to save your profile. Try again.";
};
const actionClass =
  "flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10";
const inputClass =
  "w-[min(100%,_520px)] h-9 rounded-[6px] bg-transparent shadow-none max-[640px]:h-10 max-[640px]:text-[16px]";

/** Email-code sign-ups have no name; the address's local part is the likeliest one. */
const suggestedName = (email: string) => email.split("@")[0] ?? "";

/**
 * The signed-in person's identity; it belongs to them, not to any organization. A host that can
 * verify a new address renders its own email setting; otherwise the email is read-only.
 */
export function ProfilePage({ email }: { readonly email?: (current: string) => ReactNode }) {
  useDocumentTitle(productTitle(profileTitle));
  const session = Option.getOrUndefined(AsyncResult.value(useAtomValue(sessionAtom)));
  return (
    <PageFrame>
      <PageHeader title={profileTitle} description={profileDescription} />
      <div className="flex flex-col gap-3">
        {session == null ? (
          <>
            <AccountSettingPending
              title="Name"
              description="Shown to members of your organizations."
              hint="Up to 120 characters"
              action="Save"
            />
            <AccountSettingPending title="Email" description="Used for sign-in and invitations." />
          </>
        ) : (
          <>
            <DisplayName
              key={session.user.id}
              current={session.user.name}
              email={session.user.email}
            />
            {email === undefined ? (
              <Card className={accountSettingClass}>
                <CardHeader>
                  <CardTitle>
                    <h2>Email</h2>
                  </CardTitle>
                  <CardDescription>Used for sign-in and invitations.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Input
                    aria-label="Email"
                    className={readOnlyInputClass}
                    value={session.user.email}
                    readOnly
                  />
                </CardContent>
              </Card>
            ) : (
              email(session.user.email)
            )}
          </>
        )}
        <Memberships />
      </div>
    </PageFrame>
  );
}

function DisplayName({ current, email }: { readonly current: string; readonly email: string }) {
  const rename = useAtomSet(renameUserAtom, { mode: "promiseExit" });
  const state = useAtomValue(renameUserAtom);
  // A blank name starts as an unsaved suggestion, so the empty field never looks broken.
  const [draft, setDraft] = useState(current.trim() ? undefined : suggestedName(email));
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const name = draft ?? current;
  return (
    <Card asChild className={accountSettingClass}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(undefined);
          setSaved(false);
          const result = await rename(name.trim());
          if (Exit.isFailure(result)) setError(errorMessage(result.cause));
          else {
            setDraft(undefined);
            setSaved(true);
          }
        }}
      >
        <CardHeader>
          <CardTitle>
            <h2>Name</h2>
          </CardTitle>
          <CardDescription>Shown to members of your organizations.</CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            aria-label="Name"
            aria-describedby="profile-name-hint"
            className={inputClass}
            value={name}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setError(undefined);
            }}
            required
            pattern=".*\S.*"
            maxLength={120}
            autoComplete="name"
          />
          {error && (
            <p role="alert" className="auth-error mt-3 text-destructive text-[13px]">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <p id="profile-name-hint">
            {current.trim() ? "Up to 120 characters" : "Suggested from your email. Save to use it."}
          </p>
          <div className={actionClass}>
            {saved && <span role="status">Saved</span>}
            <Button
              variant="outline"
              loading={state.waiting}
              disabled={!name.trim() || name.trim() === current}
            >
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Every organization this person belongs to; each one owns its own apps, accounts and groups. */
function Memberships() {
  const organizations = useAtomValue(organizationsAtom);
  const retry = useAtomRefresh(organizationsAtom);
  return (
    <Card className={accountSettingClass}>
      <CardHeader>
        <CardTitle>
          <h2>Organizations</h2>
        </CardTitle>
        <CardDescription>
          Where you are a member. Everything else in Executor lives inside one of these.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-4!">
        {AsyncResult.isSuccess(organizations) ? (
          organizations.value.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              You do not belong to an organization yet.{" "}
              <Link to="/" className="underline underline-offset-2">
                Create one
              </Link>
              .
            </p>
          ) : (
            <ul className="divide-y rounded-[6px] border" aria-label="Your organizations">
              {organizations.value.map((organization) => (
                <li key={organization.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                  <OrganizationAvatar name={organization.name} logo={organization.logo} />
                  <span className="min-w-0 flex-1 truncate font-medium">{organization.name}</span>
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      to="/org/$organizationSlug/apps"
                      params={{ organizationSlug: organization.slug }}
                    >
                      Open
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : AsyncResult.isFailure(organizations) ? (
          <div className="flex items-center justify-between gap-2 text-[13px] text-destructive">
            <span role="alert">Could not load your organizations.</span>
            <Button variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : (
          <Skeleton className="h-9 w-full" aria-label="Loading organizations" />
        )}
      </CardContent>
    </Card>
  );
}
