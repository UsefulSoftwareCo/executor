export { startServer } from "./serve";
export {
  makeSelfHostApp,
  makeSelfHostApiHandler,
  type SelfHostApiHandler,
  type MakeSelfHostAppOptions,
} from "./app";
export {
  loadConfig,
  resolveDatabaseConfig,
  resolveMcpMode,
  type SelfHostConfig,
  type SelfHostDatabaseConfig,
  type SelfHostMcpMode,
} from "./config";
export { BetterAuth, buildBetterAuth, betterAuthIdentityLayer } from "./auth";
