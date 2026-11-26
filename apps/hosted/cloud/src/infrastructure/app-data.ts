import * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { makeFacetSupervisor } from "@executor-js/app-data/cloudflare";
import type { RemoteCapabilities } from "@executor-js/sdk/workerd";
import { AppData } from "./app-data-worker.ts";
import { inJurisdiction } from "./jurisdiction.ts";

type FacetSupervisor = Effect.Success<ReturnType<typeof makeFacetSupervisor>>;
type Supervisor = Pick<FacetSupervisor, "invoke" | "cancel" | "evaluated" | "wake"> & {
  readonly cache: (
    namespace: string,
    command: unknown,
    trace?: string,
    invocation?: string,
  ) => Effect.Effect<unknown, Effect.Error<ReturnType<FacetSupervisor["observedCache"]>>>;
  readonly run: (invocation: string, capabilities: RemoteCapabilities) => Effect.Effect<string>;
};
export class AppDataSupervisor extends Cloudflare.DurableObject<AppDataSupervisor, Supervisor>()(
  "AppDataSupervisor",
  { transferredFrom: "Api" },
) {}

export const appDataSupervisors = inJurisdiction(AppDataSupervisor.from(AppData));
