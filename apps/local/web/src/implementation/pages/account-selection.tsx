import { QueryView } from "@executor-js/ui/dashboard/context";
import type { AppId } from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";
import { appAtom } from "../../contracts/api.ts";
import type { SetupSearch } from "../../contracts/navigation.ts";
import { useNavigate } from "@tanstack/react-router";
import { Failure, LoadingRows } from "../components/common.tsx";
import { AppDetailPage } from "./app-detail.tsx";
import { AccountSelectionDialog } from "./account-selection-dialog.tsx";

/** Deep links and OAuth returns open the editor over the app's Accounts tab. */
export function AccountSelectionPage({
  id,
  data,
  ...search
}: { readonly id: AppId; readonly data: DashboardOverview } & SetupSearch) {
  const navigate = useNavigate();
  return (
    <>
      <AppDetailPage
        id={id}
        overview={data}
        tab="accounts"
        tool={undefined}
        profile={search.profile}
      />
      <QueryView query={appAtom(id)} Failure={Failure} pending={<LoadingRows />}>
        {(snapshot) => (
          <AccountSelectionDialog
            app={snapshot.app}
            data={data}
            {...search}
            defaultOpen
            onClose={() => {
              void navigate({
                to: "/apps/$appId",
                params: { appId: id },
                search: { view: "accounts" },
                replace: true,
              });
            }}
          />
        )}
      </QueryView>
    </>
  );
}
