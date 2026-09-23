import { useAtomSet } from "@effect/atom-react";
import type { DashboardAccountDetail } from "@executor-js/local-server/contracts";
import { DisconnectAccount as SharedDisconnect } from "@executor-js/ui/dashboard/account-detail";
import { disconnectAccountAtom } from "../../contracts/accounts.ts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Failure } from "../components/common.tsx";

/** Local navigation and live invalidation stay with the local product. */
export function DisconnectAccount({ data }: { readonly data: DashboardAccountDetail }) {
  const navigate = useNavigate();
  const disconnect = useAtomSet(disconnectAccountAtom(data.account.id), { mode: "promiseExit" });
  return (
    <SharedDisconnect
      data={data}
      Failure={Failure}
      disconnect={() => disconnect()}
      onDisconnected={() => {
        void navigate({ to: "/accounts" });
      }}
      cancel={
        <Link to="/accounts/$accountId" params={{ accountId: data.account.id }}>
          Cancel
        </Link>
      }
    />
  );
}
