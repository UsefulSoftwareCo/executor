import * as Cloudflare from "alchemy/Cloudflare";
import type { ArtifactsTokenCoordinator } from "./artifacts-tokens.ts";

export class ArtifactsCredentials extends Cloudflare.Worker<
  ArtifactsCredentials,
  {},
  ArtifactsTokenCoordinator
>()("ArtifactsCredentials") {}
