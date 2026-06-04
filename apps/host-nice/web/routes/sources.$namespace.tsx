import { createFileRoute } from "@tanstack/react-router";
import { SourceDetailPage } from "@executor-js/react/pages/source-detail";

export const Route = createFileRoute("/sources/$namespace")({
  component: () => {
    const { namespace } = Route.useParams();
    return <SourceDetailPage namespace={namespace} />;
  },
});
