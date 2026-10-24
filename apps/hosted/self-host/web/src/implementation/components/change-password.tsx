import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Label } from "@executor-js/ui/components/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { AccountSettingPending, accountSettingClass } from "@executor-js/hosted-web/account";
import { changePasswordAtom } from "@executor-js/hosted-web/contracts/account";
import { securityErrorMessage } from "@executor-js/hosted-web/pages/security";

const title = "Password";
const description = "Used with your email to sign in to this instance.";
const hint = "At least 8 characters";
const minLength = 8;
const inputClass =
  "w-[min(100%,_520px)] h-9 rounded-[6px] bg-transparent shadow-none max-[640px]:h-10 max-[640px]:text-[16px]";

/** The security card while the self-host bundle loads. */
export function ChangePasswordPending() {
  return (
    <AccountSettingPending
      title={title}
      description={description}
      hint={hint}
      action="Change password"
    />
  );
}

/** Self-host accounts sign in with a password; the server checks the current one. */
export function ChangePassword() {
  const change = useAtomSet(changePasswordAtom, { mode: "promiseExit" });
  const state = useAtomValue(changePasswordAtom);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const ready = currentPassword.length > 0 && newPassword.length >= minLength;
  return (
    <Card asChild className={accountSettingClass}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!ready) return;
          setError(undefined);
          setSaved(false);
          const result = await change({ currentPassword, newPassword });
          if (Exit.isFailure(result)) setError(securityErrorMessage(result.cause));
          else {
            setCurrentPassword("");
            setNewPassword("");
            setSaved(true);
          }
        }}
      >
        <CardHeader>
          <CardTitle>
            <h2>{title}</h2>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password" className="text-[12px]">
              Current password
            </Label>
            <Input
              id="current-password"
              type="password"
              className={inputClass}
              value={currentPassword}
              autoComplete="current-password"
              required
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                setSaved(false);
                setError(undefined);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password" className="text-[12px]">
              New password
            </Label>
            <Input
              id="new-password"
              type="password"
              className={inputClass}
              value={newPassword}
              autoComplete="new-password"
              minLength={minLength}
              required
              aria-describedby="new-password-hint"
              onChange={(event) => {
                setNewPassword(event.target.value);
                setSaved(false);
                setError(undefined);
              }}
            />
          </div>
          {error && (
            <p role="alert" className="auth-error text-destructive text-[13px]">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <p id="new-password-hint">{hint}</p>
          <div className="flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10">
            {saved && <span role="status">Password changed</span>}
            <Button variant="outline" loading={state.waiting} disabled={!ready}>
              Change password
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Starts the existing authenticated SSO linking flow. */
export function ConnectSso() {
  const [error, setError] = useState<string>();
  return (
    <Card className={accountSettingClass}>
      <CardHeader>
        <CardTitle>
          <h2>Single sign-on</h2>
        </CardTitle>
        <CardDescription>
          Connect a Google or other OIDC account so you can sign in without your password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p role="alert" className="auth-error text-destructive text-[13px]">
            {error}
          </p>
        )}
      </CardContent>
      <CardFooter>
        <div className="flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10">
          <Button
            variant="outline"
            onClick={async () => {
              setError(undefined);
              const response = await fetch("/api/auth/link-social", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  provider: "sso",
                  callbackURL: `${location.origin}/account/security`,
                }),
              });
              const result = await response.json().catch(() => ({}));
              if (!response.ok || !result.url) {
                setError("Could not start SSO linking. Try again.");
                return;
              }
              location.assign(result.url);
            }}
          >
            Connect SSO
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
