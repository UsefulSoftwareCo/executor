import { createFileRoute, useParams } from "@tanstack/react-router";

import { ArtifactsRoute } from "./artifacts-route";

export const Route = createFileRoute("/{-$orgSlug}/artifacts")({
  component: ArtifactsRouteComponent,
});

function ArtifactsRouteComponent() {
  // `/artifacts/$artifactId` generates as a CHILD of this route, and this
  // component renders no <Outlet/>, so the parent must serve both URLs — the
  // same shape `toolkits.tsx` uses for `/toolkits/$toolkitSlug`.
  const { artifactId } = useParams({ strict: false }) as { artifactId?: string };
  return <ArtifactsRoute artifactId={artifactId} />;
}
