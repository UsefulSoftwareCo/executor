/** Cloud reaches each app's data supervisor through its Durable Object namespace. */
import { RuntimeContext } from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { evaluatedDeclarations } from "@executor-js/sdk/core";
import type { AppDataSupervisor } from "./app-data.ts";

export const durableDeclarations = (databases: Cloudflare.DurableObject<AppDataSupervisor>) =>
  evaluatedDeclarations((app, command) =>
    databases.getByName(app).evaluated(command).pipe(Effect.provide(RuntimeContext.phantom)),
  );
