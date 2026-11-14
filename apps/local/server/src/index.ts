/** Local server composition for CLI and desktop hosts. Importing this package opens no resources. */
export { ServerConfig, config } from "./contracts/config.ts";
export { localApi } from "./implementation/server.ts";
export { LocalAuthApi } from "./contracts/auth.ts";
