/** Native Alchemy resource; product authorization remains on the calling Worker. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { makeFacetSupervisor } from "@executor-js/app-data/cloudflare";
import type { RemoteCapabilities } from "@executor-js/sdk/workerd";
import { AppData } from "./app-data-worker.ts";
import { inJurisdiction } from "./jurisdiction.ts";

type FacetSupervisor = Effect.Success<ReturnType<typeof makeFacetSupervisor>>;
type Supervisor = Pick<FacetSupervisor, "invoke" | "cancel" | "evaluated" | "wake"> & {
  /**
   * A cache command. `trace` is the caller's trace ID and `invocation` its runner invocation's
   * opaque ID, compared with the call that woke the supervisor; the reply also says how the
   * supervisor ran.
   */
  readonly cache: (
    namespace: string,
    command: unknown,
    trace?: string,
    invocation?: string,
  ) => Effect.Effect<unknown, Effect.Error<ReturnType<FacetSupervisor["observedCache"]>>>;
  /**
   * Run a call that uses the app's database (see `runsInFacet`) with its runner inside this
   * supervisor, as the AppData Worker's runner `invoke` runs any call.
   */
  readonly run: (invocation: string, capabilities: RemoteCapabilities) => Effect.Effect<string>;
};
/**
 * One supervisor name is one immutable configured-app ID, across deployments. The namespace, with
 * every app's data, moved here from the API Worker.
 */
export class AppDataSupervisor extends Cloudflare.DurableObject<AppDataSupervisor, Supervisor>()(
  "AppDataSupervisor",
  { transferredFrom: "Api" },
) {}

/** Every other Worker binds the namespace across scripts. */
export const appDataSupervisors = inJurisdiction(AppDataSupervisor.from(AppData));
