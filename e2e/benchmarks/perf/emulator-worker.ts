/** Cloudflare Worker entry for the perf emulator; bundled and uploaded by `run-perf.ts emulator deploy`. */
import { HttpRouter } from "effect/unstable/http";
import { emulatorRoutes } from "./emulator.ts";

const { handler } = HttpRouter.toWebHandler(emulatorRoutes, { disableLogger: true });

export default { fetch: (request: Request) => handler(request) };
