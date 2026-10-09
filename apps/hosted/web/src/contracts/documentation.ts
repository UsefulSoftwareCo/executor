import { publicDocsBaseUrl } from "@executor-js/ui/contracts/documentation";
import { Schema } from "effect";
import { Atom } from "effect/reactivity";

/**
 * Where this deployment's documentation lives, as an absolute URL ending in `/`, sent with each
 * server-rendered document. A host that serves its own documentation sets it; any other host
 * links to the public documentation site.
 */
export const documentationBaseAtom = Atom.make<string>(publicDocsBaseUrl).pipe(
  Atom.serializable({ key: "hosted:documentation-base", schema: Schema.String }),
  Atom.keepAlive,
);

/** A documentation page below `base`; the empty path is the documentation index. */
export const documentationPage = (base: string, path = "") => `${base.replace(/\/?$/, "/")}${path}`;
