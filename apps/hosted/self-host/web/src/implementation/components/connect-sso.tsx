import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { accountSettingClass } from "@executor-js/hosted-web/account";
import { configurationAtom, connectSsoAtom, ssoConnectedAtom } from "../../contracts/auth.ts";
import { ssoLinkRefusalExplanation } from "../../contracts/sso.ts";

/**
 * Connect the operator's SSO to an account that signs in with a password. SSO never links itself
 * to a password account, so its owner does it here while signed in. Shown only when the operator
 * enabled SSO; `refused` is the code the instance returned the provider's sign-in with.
 */
export function ConnectSso({ refused }: { readonly refused: string | undefined }) {
  const configuration = useAtomValue(configurationAtom);
  const connected = useAtomValue(ssoConnectedAtom);
  const connect = useAtomSet(connectSsoAtom, { mode: "promiseExit" });
  const state = useAtomValue(connectSsoAtom);
  const [error, setError] = useState<string>();
  if (!AsyncResult.isSuccess(configuration) || !configuration.value.sso) return null;
  const linked = AsyncResult.isSuccess(connected) && connected.value;
  const message =
    error ??
    (AsyncResult.isFailure(connected)
      ? "Unable to read your sign-in methods. Reload to try again."
      : refused === undefined || linked
        ? undefined
        : ssoLinkRefusalExplanation(refused));
  return (
    <Card className={accountSettingClass}>
      <CardHeader>
        <CardTitle>
          <h2>Single sign-on</h2>
        </CardTitle>
        <CardDescription>
          {linked
            ? "Connected. You can sign in with SSO or with your password."
            : "Connect your identity provider account to sign in with SSO as well as your password."}
        </CardDescription>
      </CardHeader>
      {message && (
        <CardContent>
          <p role="alert" className="auth-error text-destructive text-[13px]">
            {message}
          </p>
        </CardContent>
      )}
      {!linked && (
        <CardFooter>
          <div className="flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10">
            <Button
              variant="outline"
              loading={state.waiting}
              disabled={!AsyncResult.isSuccess(connected)}
              onClick={async () => {
                setError(undefined);
                // On success the browser leaves for the identity provider.
                if (Exit.isFailure(await connect()))
                  setError("SSO could not be started. Try again.");
              }}
            >
              Connect SSO
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
