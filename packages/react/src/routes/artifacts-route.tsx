import { ArtifactId } from "@executor-js/sdk/shared";

import { ArtifactDetailPage } from "../pages/artifact-detail";
import { ArtifactsPage } from "../pages/artifacts";

/**
 * The one component both artifact routes render. `/artifacts/$artifactId` is a
 * child of `/artifacts` in the generated tree and the parent renders no
 * `<Outlet/>`, so the parent has to resolve which view to show — the shape
 * `toolkits-route.tsx` established.
 */
export function ArtifactsRoute(props: { readonly artifactId?: string | undefined }) {
  if (props.artifactId === undefined) return <ArtifactsPage />;
  return <ArtifactDetailPage artifactId={ArtifactId.make(props.artifactId)} />;
}
