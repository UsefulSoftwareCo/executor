import { HttpRouter } from "effect/http";
import { emulatorRoutes } from "./emulator.ts";

const { handler } = HttpRouter.toWebHandler(emulatorRoutes, { disableLogger: true });

export default { fetch: (request: Request) => handler(request) };
