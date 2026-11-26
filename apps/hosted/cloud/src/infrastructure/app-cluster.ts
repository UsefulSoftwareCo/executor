// external: Cloudflare deletes a Durable Object class, with every object of it, when a deploy no longer declares it; declared here, before anything uses it, so a rollback to this release keeps a later release's objects.
import * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";

type Methods = {
  readonly call: (
    key: string,
    method: string,
    args: ReadonlyArray<unknown>,
    build?: string,
  ) => Effect.Effect<unknown>;
  readonly facetAlarm: (
    key: string,
    op: "get" | "set" | "delete",
    at?: number,
  ) => Effect.Effect<number | null>;
};
export class AppCluster extends Cloudflare.DurableObject<AppCluster, Methods>()("AppCluster") {}
