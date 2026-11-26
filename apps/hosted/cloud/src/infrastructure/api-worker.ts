import * as Cloudflare from "alchemy/Cloudflare";

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}
