import { AccountConnectionDialog } from "@executor-js/hosted-web/pages/connection-dialog";
import { createFileRoute } from "@tanstack/react-router";
import { OpenAppAction } from "@executor-js/hosted-web/pages/app-sign-in";
import { AppDetailPage } from "@executor-js/hosted-web/pages/app-detail";
import { parseAppSearch } from "@executor-js/hosted-web/contracts/navigation";
import { parseAppParams } from "@executor-js/hosted-web/route-params";

export const Route = createFileRoute("/org/$organizationSlug/apps/$appId")({
  params: { parse: parseAppParams },
  validateSearch: parseAppSearch,
  component: AppPage,
});
function AppPage() {
  const { appId } = Route.useParams();
  const { view, tool, profile, connection, client } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <>
      <AppDetailPage
        appId={appId}
        view={view}
        tool={tool}
        profile={profile}
        openApp={(app, selected) => <OpenAppAction app={app} profile={selected?.id} />}
      />
      <AccountConnectionDialog
        connectionId={connection}
        client={client}
        onClose={() => {
          void navigate({ search: { view, tool, profile }, replace: true });
        }}
      />
    </>
  );
}
