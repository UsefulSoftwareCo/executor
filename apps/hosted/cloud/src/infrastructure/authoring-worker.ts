import * as Cloudflare from "alchemy/Cloudflare";
import type { AuthoringReference } from "../contracts/authoring.ts";

export class Authoring extends Cloudflare.Worker<Authoring, AuthoringReference>()("Authoring") {}
