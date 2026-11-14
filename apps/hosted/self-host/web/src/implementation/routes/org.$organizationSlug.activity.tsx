import { createFileRoute } from "@tanstack/react-router";
import { parseToolCallSearch } from "@executor-js/hosted-web/contracts/tool-calls";
import { ActivityPage, activityPageReads } from "@executor-js/hosted-web/pages/activity";

/** The tool call log; its search, filters and range are kept in the URL. */
export const Route = createFileRoute("/org/$organizationSlug/activity")({
  validateSearch: parseToolCallSearch,
  component: Page,
  staticData: { organizationReads: activityPageReads },
});

function Page() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ActivityPage
      search={search}
      onSearchChange={(next, options) => {
        void navigate({
          search: (current) => ({ ...current, ...next }),
          replace: options?.replace ?? false,
          resetScroll: false,
        });
      }}
    />
  );
}
