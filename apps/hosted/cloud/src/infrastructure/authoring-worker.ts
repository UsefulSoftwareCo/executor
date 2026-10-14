/** Lightweight service contract. Importing this binding never imports the authoring reference. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { AuthoringReference } from "../contracts/authoring.ts";

/** The reference has no public URL; the API Worker reads it through a private service binding. */
export class Authoring extends Cloudflare.Worker<Authoring, AuthoringReference>()("Authoring") {}
