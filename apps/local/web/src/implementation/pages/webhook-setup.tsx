import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { WebhookSetupPage as SharedPage } from "@executor-js/ui/dashboard/webhook-setup";
import type { AppId, WebhookId } from "@executor-js/sdk";
import { localWebhookSetupAtoms } from "../../contracts/webhook-setup.ts";
import { Failure } from "../components/common.tsx";
/** The existing dashboard gate pairs the browser before these private atoms mount. */
export function WebhookSetupPage({
  appId,
  subscriptionId,
}: {
  readonly appId: AppId;
  readonly subscriptionId: WebhookId;
}) {
  const atoms = localWebhookSetupAtoms(appId, subscriptionId);
  const complete = useAtomSet(atoms.complete, { mode: "promiseExit" });
  const remove = useAtomSet(atoms.remove, { mode: "promiseExit" });
  const confirmRemoval = useAtomSet(atoms.confirmRemoval, { mode: "promiseExit" });
  return (
    <SharedPage
      result={useAtomValue(atoms.details)}
      complete={complete}
      remove={() => remove()}
      confirmRemoval={() => confirmRemoval()}
      retry={useAtomRefresh(atoms.details)}
      Failure={Failure}
    />
  );
}
