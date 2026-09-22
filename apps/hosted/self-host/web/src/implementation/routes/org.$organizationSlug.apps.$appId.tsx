import { createFileRoute } from "@tanstack/react-router";
import { AppDetailPage } from "@executor-js/hosted-web/pages/app-detail";
import { OpenAppAction } from "@executor-js/hosted-web/pages/app-sign-in";
import { parseAppSearch } from "@executor-js/hosted-web/contracts/navigation";

export const Route = createFileRoute("/org/$organizationSlug/apps/$appId")({
  validateSearch: parseAppSearch,
  component: AppPage,
});
function AppPage() {
  const { appId } = Route.useParams();
  const { view, tool, profile } = Route.useSearch();
  return (
    <AppDetailPage
      appId={appId}
      view={view}
      tool={tool}
      profile={profile}
      openApp={(app, selected) => <OpenAppAction app={app} profile={selected?.id} />}
    />
  );
}
