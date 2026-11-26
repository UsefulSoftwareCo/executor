import * as Cloudflare from "alchemy/Cloudflare";

export class Edge extends Cloudflare.Worker<Edge, {}>()("Edge") {}
