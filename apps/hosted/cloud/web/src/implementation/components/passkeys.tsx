import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
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
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { LocalTime, shortMoment } from "@executor-js/ui/components/local-time";
import { AccountSettingPending, accountSettingClass } from "@executor-js/hosted-web/account";
import {
  addPasskeyAtom,
  deletePasskeyAtom,
  passkeysAtom,
  type PasskeySummary,
} from "../../contracts/auth.ts";

const title = "Passkeys";
const description = "Sign in with your fingerprint, face, or password manager.";
const hint = "A passkey replaces email codes on devices that have one.";

/** The security card while the passkey bundle loads. */
export function PasskeysPending() {
  return (
    <AccountSettingPending title={title} description={description} hint={hint} action="Add passkey">
      <Skeleton className="h-9 w-full" aria-label="Loading passkeys" />
    </AccountSettingPending>
  );
}

/** Cloud sign-in passkeys. Registration starts the WebAuthn ceremony only after a click. */
export function Passkeys() {
  const passkeys = useAtomValue(passkeysAtom);
  const retry = useAtomRefresh(passkeysAtom);
  const add = useAtomSet(addPasskeyAtom, { mode: "promiseExit" });
  const adding = useAtomValue(addPasskeyAtom);
  const [error, setError] = useState<string>();
  if (AsyncResult.isInitial(passkeys)) return <PasskeysPending />;
  return (
    <Card className={accountSettingClass}>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {AsyncResult.isFailure(passkeys) ? (
          <div className="flex items-center justify-between gap-2 text-[13px] text-destructive">
            <span role="alert">Could not load your passkeys.</span>
            <Button variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : passkeys.value.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No passkeys yet.</p>
        ) : (
          <ul className="divide-y rounded-[6px] border" aria-label="Passkeys">
            {passkeys.value.map((passkey) => (
              <PasskeyRow key={passkey.id} passkey={passkey} />
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
        <p>{hint}</p>
        <div className="flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10">
          <Button
            variant="outline"
            loading={adding.waiting}
            onClick={async () => {
              setError(undefined);
              const result = await add("Passkey");
              if (Exit.isFailure(result))
                setError("Passkey was not added. Try again on a device that supports passkeys.");
            }}
          >
            Add passkey
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function PasskeyRow({ passkey }: { readonly passkey: PasskeySummary }) {
  const remove = useAtomSet(deletePasskeyAtom(passkey.id), { mode: "promiseExit" });
  const state = useAtomValue(deletePasskeyAtom(passkey.id));
  const [error, setError] = useState<string>();
  const name = passkey.name?.trim() || "Passkey";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className="text-[12px] text-muted-foreground">
          {passkey.backedUp ? "Synced" : "Device-bound"} · Added{" "}
          <LocalTime value={passkey.createdAt} options={shortMoment} />
        </div>
        {error && (
          <p role="alert" className="auth-error mt-1 text-destructive text-[12px]">
            {error}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        loading={state.waiting}
        aria-label={`Remove ${name}`}
        onClick={async () => {
          setError(undefined);
          const result = await remove();
          if (Exit.isFailure(result)) setError("Passkey was not removed. Try again.");
        }}
      >
        Remove
      </Button>
    </li>
  );
}
