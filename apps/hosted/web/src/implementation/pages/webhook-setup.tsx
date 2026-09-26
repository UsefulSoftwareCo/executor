import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { WebhookSetupPage as SharedPage } from "@executor-js/ui/dashboard/webhook-setup";
import type { AppId, WebhookId } from "@executor-js/sdk";
import { hostedWebhookSetupAtoms } from "../../contracts/webhook-setup.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
/** Cloud and self-host render the same page through their own TanStack route trees. */
export function WebhookSetupPage({
  appId,
  subscriptionId,
}: {
  readonly appId: AppId;
  readonly subscriptionId: WebhookId;
}) {
  const { organization } = useOrganizationRoute();
  const atoms = hostedWebhookSetupAtoms(organization, appId, subscriptionId);
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
      Failure={HostedFailure}
    />
  );
}
