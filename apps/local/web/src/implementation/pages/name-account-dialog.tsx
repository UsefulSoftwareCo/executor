import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { Account, AppId } from "@executor-js/sdk";
import { QueryView } from "@executor-js/ui/dashboard/context";
import {
  NameAccountForm,
  NameAccountHeader,
  NameAccountModal,
  suggestedAccountName,
} from "@executor-js/ui/dashboard/name-account";
import {
  accountAtom,
  accountToNameAtom,
  checkAccountAtom,
  updateAccountAtom,
} from "../../contracts/accounts.ts";
import { Failure, LoadingRows } from "../components/common.tsx";

/** Prompt for a name for a newly connected account, over whatever page follows. */
export function NameAccountDialog() {
  const pending = useAtomValue(accountToNameAtom);
  const setPending = useAtomSet(accountToNameAtom);
  const [busy, setBusy] = useState(false);
  if (pending === undefined) return null;
  const close = () => setPending(undefined);
  return (
    <NameAccountModal
      key={pending.account}
      handoff={pending.saved !== undefined}
      busy={busy}
      onClose={close}
    >
      {pending.saved ? (
        <>
          <NameAccountHeader provider={pending.saved.provider} />
          <LocalNameAccount
            account={{ id: pending.account, label: pending.saved.account.label }}
            providerName={pending.saved.provider.definition.name}
            app={pending.app}
            onPendingChange={setBusy}
            onDone={close}
          />
        </>
      ) : (
        // After an OAuth return the prompt has only the account ID, so it reads the account first.
        <QueryView
          query={accountAtom(pending.account)}
          Failure={Failure}
          pending={
            <>
              <NameAccountHeader />
              <LoadingRows />
            </>
          }
        >
          {(data) => (
            <>
              <NameAccountHeader provider={data.provider} />
              <LocalNameAccount
                account={data.account}
                providerName={data.provider.definition.name}
                app={pending.app}
                onPendingChange={setBusy}
                onDone={close}
              />
            </>
          )}
        </QueryView>
      )}
    </NameAccountModal>
  );
}

/** Stop waiting for a name if the expected selection or its check never arrives. */
const identityWaitMillis = 10_000;

function LocalNameAccount({
  account,
  providerName,
  app,
  onPendingChange,
  onDone,
}: {
  readonly account: Pick<Account, "id" | "label">;
  readonly providerName: string;
  readonly app: AppId | undefined;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onDone: () => void;
}) {
  const update = useAtomSet(updateAccountAtom(account.id), { mode: "promiseExit" });
  const check = useAtomSet(checkAccountAtom(account.id), { mode: "promiseExit" });
  // The account is saved before the app selects it, so follow the live account and check as soon
  // as a selecting app can. A passing check may name the upstream account.
  const health = Option.getOrUndefined(
    AsyncResult.value(useAtomValue(accountAtom(account.id))),
  )?.health;
  const waiting =
    health?.apps
      .filter((entry) => entry.checkable && (entry.check === null || !entry.check.current))
      .map((entry) => entry.app)
      .join(",") ?? "";
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (waiting === "") return;
    void check().then((exit) => {
      if (Exit.isFailure(exit)) setSettled(true);
    });
  }, [waiting, check]);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), identityWaitMillis);
    return () => clearTimeout(timer);
  }, []);
  const selecting =
    app !== undefined && !(health?.apps.some((entry) => entry.app === app) ?? false);
  const resolving = !settled && (health === undefined || waiting !== "" || selecting);
  return (
    <NameAccountForm
      account={account}
      providerName={providerName}
      update={update}
      Failure={Failure}
      identity={
        resolving ? { resolving: true } : { resolving: false, name: suggestedAccountName(health) }
      }
      onPendingChange={onPendingChange}
      onDone={onDone}
    />
  );
}
