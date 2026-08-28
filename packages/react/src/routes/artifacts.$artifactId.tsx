import { createFileRoute } from "@tanstack/react-router";

import { ArtifactsRoute } from "./artifacts-route";

export const Route = createFileRoute("/{-$orgSlug}/artifacts/$artifactId")({
  component: ArtifactDetailRouteComponent,
});

function ArtifactDetailRouteComponent() {
  const { artifactId } = Route.useParams();
  return <ArtifactsRoute artifactId={artifactId} />;
}
