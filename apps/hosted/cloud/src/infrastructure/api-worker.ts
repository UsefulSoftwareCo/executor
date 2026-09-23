/** Bind the API Worker without importing its routes and application initialization. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { ArtifactsTokenCoordinator } from "./artifacts-tokens.ts";
import type { AppDataSupervisor } from "./app-data.ts";

/** Stable native Worker identity; main.ts supplies its implementation and properties. */
export class Api extends Cloudflare.Worker<
  Api,
  {},
  AppDataSupervisor | ArtifactsTokenCoordinator
>()("Api") {}
