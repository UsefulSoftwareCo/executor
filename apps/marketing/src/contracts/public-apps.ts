/** Public Apps uses the registry reader without importing dashboard authentication or data. */
import { remoteRegistry } from "@executor-js/app-registry/client";
import { PackageName } from "@executor-js/app-registry/contracts";
import { Data, Effect, Layer, Option, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";

const runtime = Atom.runtime(Layer.empty);
const registry = () => remoteRegistry(window.location.origin);
/** Published metadata is refreshed when a visitor returns to the page. */
export const publicApps = runtime
  .atom(Effect.suspend(() => registry().list()))
  .pipe(Atom.refreshOnWindowFocus);
/** Look up only the publication named by the public URL. */
export const publicApp = Atom.family((name: string) =>
  runtime.atom(Effect.suspend(() => registry().list(name))).pipe(Atom.refreshOnWindowFocus),
);
class SnapshotReference extends Data.Class<{ readonly name: string; readonly commit: string }> {}
const snapshots = Atom.family((reference: SnapshotReference) =>
  runtime.atom(Effect.suspend(() => registry().snapshot(reference.name, reference.commit))),
);
/** Files are pinned to the displayed publication, never the author's working source. */
export const publicAppFiles = (name: string, commit: string) =>
  snapshots(new SnapshotReference({ name, commit }));
/** The static Apps shell handles fresh package URLs without a site rebuild. */
export function publicAppsLocation(
  pathname: string,
):
  | { readonly kind: "directory" }
  | { readonly kind: "app"; readonly name: string }
  | { readonly kind: "invalid" } {
  if (pathname === "/apps" || pathname === "/apps/") return { kind: "directory" };
  const match = /^\/apps\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  const scope = match?.[1];
  const app = match?.[2];
  if (scope === undefined || app === undefined) return { kind: "invalid" };
  const decoded = Option.liftThrowable(decodeURIComponent)(`@${scope}/${app}`);
  const name = Option.flatMap(decoded, Schema.decodeUnknownOption(PackageName));
  return Option.isSome(name) ? { kind: "app", name: name.value } : { kind: "invalid" };
}
