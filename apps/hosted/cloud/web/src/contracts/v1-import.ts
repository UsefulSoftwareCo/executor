import { browserOnly } from "@executor-js/ui/contracts/http";
import { Cause, Effect, Exit } from "effect";
import { Atom } from "effect/reactivity";
import type {
  V1ImportStart,
  V1ItemResult,
  V1OrganizationId,
} from "../../../src/contracts/v1-import.ts";
import { CloudClient } from "./billing.ts";

/** The caller's v1 workspaces and v2 organizations; read only in the browser, on the import page. */
export const v1ImportChoicesAtom = browserOnly(CloudClient.query("v1Import", "choices", {})).pipe(
  Atom.withLabel("ui.v1Import.choices"),
);

/** What importing one v1 workspace would do, and each item's last result. */
export const v1ImportPreviewAtom = Atom.family((organization: V1OrganizationId) =>
  browserOnly(CloudClient.query("v1Import", "preview", { params: { organization } })).pipe(
    Atom.withLabel("ui.v1Import.preview"),
  ),
);

/** Results posted so far in the running import, by `kind:id`. */
export const v1ImportProgressAtom = Atom.family((_organization: V1OrganizationId) =>
  Atom.make<ReadonlyMap<string, V1ItemResult>>(new Map()).pipe(Atom.keepAlive),
);

export const itemKey = (item: { readonly kind: string; readonly id: string }) =>
  `${item.kind}:${item.id}`;

/**
 * Start (or resume) the import, post every item not yet imported in order, then finish. One
 * request per item keeps slow steps within the Worker's limits; closing the tab stops here and
 * running again resumes from the server's import map, retrying failed items.
 */
export const runV1ImportAtom = Atom.family((organization: V1OrganizationId) =>
  CloudClient.runtime
    .fn((target: V1ImportStart["target"], get) =>
      Effect.gen(function* () {
        const client = yield* CloudClient;
        const started = yield* client.v1Import.start({
          params: { organization },
          payload: { target },
        });
        let progress: ReadonlyMap<string, V1ItemResult> = new Map();
        for (const item of started.items) {
          if (item.result?.status === "imported") {
            progress = new Map(progress).set(itemKey(item), item.result);
            continue;
          }
          const exit = yield* client.v1Import
            .item({ params: { organization, kind: item.kind, id: item.id } })
            .pipe(Effect.exit);
          const failure = Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause);
          const result: V1ItemResult = Exit.isSuccess(exit)
            ? exit.value
            : {
                status: "failed",
                reason:
                  failure instanceof Error
                    ? failure.message
                    : "The request failed. Contact support if you need it.",
              };
          progress = new Map(progress).set(itemKey(item), result);
          get.set(v1ImportProgressAtom(organization), progress);
        }
        const finished = yield* client.v1Import.finish({ params: { organization } });
        get.refresh(v1ImportPreviewAtom(organization));
        get.refresh(v1ImportChoicesAtom);
        return finished;
      }),
    )
    .pipe(Atom.withLabel("ui.v1Import.run")),
);
