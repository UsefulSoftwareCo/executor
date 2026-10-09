/** Public HTML and assets run independently of the placed application Worker. */
import * as Cloudflare from "alchemy/Cloudflare";

/** Stable service binding for v1's edge and the test stage's forwarding Worker. */
export class Marketing extends Cloudflare.Worker<Marketing, {}>()("Marketing") {}
