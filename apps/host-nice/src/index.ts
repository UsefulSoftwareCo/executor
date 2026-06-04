export { startServer } from "./serve";
export {
  makeSelfHostApp,
  makeSelfHostApiHandler,
  type SelfHostApiHandler,
  type MakeSelfHostAppOptions,
} from "./app";
export { loadConfig, type SelfHostConfig } from "./config";
export { BetterAuth, buildBetterAuth, betterAuthIdentityLayer } from "./auth";
