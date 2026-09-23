import type { AccountSubmission } from "@executor-js/ui/contracts/credentials";
import type { DashboardError } from "../../contracts/errors.ts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit, Cause, Result } from "effect";
import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LockKeyholeIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { AccountConnection } from "@executor-js/sdk";
import type { ConnectionGrant } from "@executor-js/local-server/account-connections";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import {
  connectionDetailsAtom,
  connectionEntryAtom,
  submitConnectionAtom,
  cancelConnectionAtom,
} from "../../contracts/account-connections.ts";
import { faviconUrl } from "@executor-js/ui/contracts/icons";
import { Button } from "@executor-js/ui/components/button";
import { Failure } from "../components/common.tsx";
import { AccountForm } from "@executor-js/ui/dashboard/account-form";
import { OAuthFields } from "./oauth-fields.tsx";

/** A standalone, mobile-sized handoff page with no dashboard navigation or access. */
export function ConnectAccountPage() {
  const entry = useAtomValue(connectionEntryAtom);
  const result = useAtomValue(connectionDetailsAtom);
  return (
    <main className="account-connect-page min-h-dvh [padding:28px_20px_48px] flex flex-col items-center gap-8">
      <div className="account-connect-brand flex items-center gap-2.25 text-[18px] font-semibold [&_img]:w-6 [&_img]:h-6">
        <img src="/favicon.png" alt="" />
        executor
      </div>
      <section className="account-connect-card w-full max-w-105 p-[28px] border border-border rounded-[12px] bg-background [&_h1]:text-[22px] [&_h1]:font-semibold [&_h1]:tracking-[-0.03em] [&_h1]:[margin:0_0_8px] [&_p]:text-muted-foreground [&_p]:text-[13px] [&_.setup-form]:w-full [&_.setup-form]:max-w-none [&_.setup-form]:p-0 [&_.setup-form]:border-0 [&_.setup-form_.form-actions_>_button]:w-full [&_>_button]:w-full max-[480px]:py-[22px] max-[480px]:px-[18px]">
        {!entry ? (
          <>
            <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
              Open a new connection link
            </h1>
            <p>Ask your agent for a link to connect this account.</p>
          </>
        ) : AsyncResult.isFailure(result) ? (
          <Failure cause={result.cause} />
        ) : !AsyncResult.isSuccess(result) || !result.value ? (
          <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
            Loading connection…
          </h1>
        ) : (
          <>
            {result.value.completion && Result.isFailure(result.value.completion) && (
              <Failure cause={Cause.fail(result.value.completion.failure)} />
            )}
            <ConnectionForm
              key={entry.connection}
              grant={entry}
              connection={result.value.connection}
            />
          </>
        )}
      </section>
    </main>
  );
}

function ConnectionForm({
  grant,
  connection,
}: {
  readonly grant: ConnectionGrant;
  readonly connection: AccountConnection;
}) {
  const [state, setState] = useState(connection.state);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<DashboardError>>();
  const submit = useAtomSet(submitConnectionAtom, { mode: "promiseExit" });
  const cancel = useAtomSet(cancelConnectionAtom, { mode: "promiseExit" });
  const refresh = useAtomRefresh(connectionDetailsAtom);
  const icon = faviconUrl(providerDisplayUrl(connection.provider.definition), 32);
  if (state.status !== "pending")
    return (
      <div className="account-connect-result py-[24px] px-0 text-center [&_>_svg]:[margin:0_auto_18px]">
        {state.status === "completed" && (
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-hidden size={28} />
        )}
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          {state.status === "completed"
            ? "Account connected"
            : state.status === "cancelled"
              ? "Connection cancelled"
              : "This link has expired"}
        </h1>
        <p>
          {state.status === "completed"
            ? `${state.account.label} · ${connection.provider.definition.name}`
            : state.status === "expired"
              ? "Ask your agent for a new connection link."
              : "No credentials were saved."}
        </p>
        {state.status === "completed" && connection.target && (
          <p>Connected to {connection.target.name}.</p>
        )}
        <p className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
          You can return to your agent.
        </p>
      </div>
    );
  return (
    <>
      <header className="account-connect-heading mb-7 [&_>_img]:w-9 [&_>_img]:h-9 [&_>_img]:mb-4.5">
        {icon && <img src={icon} alt="" referrerPolicy="no-referrer" />}
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Connect {connection.provider.definition.name}
        </h1>
        <p>
          {connection.target ? `For ${connection.target.name}` : "Save this account in Executor."}
        </p>
      </header>
      <AccountForm
        provider={connection.provider}
        {...(connection.reconnectAccount ? { account: connection.reconnectAccount } : {})}
        Failure={Failure}
        submitLabel="Connect account"
        disabled={pending}
        onPendingChange={setPending}
        submit={(input: AccountSubmission) => submit({ payload: { ...grant, ...input } })}
        onSaved={(account) => setState({ status: "completed", account })}
        oauth={(props) => (
          <OAuthFields
            provider={connection.provider}
            connection={grant}
            onSaved={(account) => setState({ status: "completed", account })}
            {...(connection.reconnectAccount ? { account: connection.reconnectAccount } : {})}
            {...props}
          />
        )}
      />
      {error && <Failure cause={error} />}
      <p className="account-connect-privacy flex items-center justify-center gap-1.5 [margin:22px_0_8px]">
        <HugeiconsIcon icon={LockKeyholeIcon} strokeWidth={2} aria-hidden size={13} />
        Credentials go directly to Executor.
      </p>
      <Button
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void cancel({ payload: grant }).then((exit) => {
            setPending(false);
            if (Exit.isSuccess(exit)) setState(exit.value.state);
            else {
              setError(exit.cause);
              refresh();
            }
          });
        }}
      >
        Cancel
      </Button>
    </>
  );
}
