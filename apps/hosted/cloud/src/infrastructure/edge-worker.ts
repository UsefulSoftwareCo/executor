/** A test stage's stand-in for v1's edge; importing this binding imports nothing else. */
import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Forwards the requests v1's edge on `executor.sh` forwards to v2 (`edge-paths.ts`) to the
 * marketing gateway with their original URL, as v1 does. Only test stages deploy it.
 */
export class Edge extends Cloudflare.Worker<Edge, {}>()("Edge") {}
