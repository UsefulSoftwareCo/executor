import { publicDocsBaseUrl } from "@executor-js/ui/contracts/documentation";
import { Schema } from "effect";
import { Atom } from "effect/reactivity";

export const documentationBaseAtom = Atom.make<string>(publicDocsBaseUrl).pipe(
  Atom.serializable({ key: "hosted:documentation-base", schema: Schema.String }),
  Atom.keepAlive,
);

export const documentationPage = (base: string, path = "") => `${base.replace(/\/?$/, "/")}${path}`;
