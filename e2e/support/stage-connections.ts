/**
 * Installs the stage-request wrapper (`support/lost-connections.ts`) the moment it is imported:
 * each request to a stage origin then goes on a connection of its own and a lost one is recorded.
 *
 * Effect's `FetchHttpClient` reads `globalThis.fetch` once and keeps it for the life of the
 * process, so the wrapper has to be in place before anything can make a request: a process that
 * installed it later kept Node's keep-alive pool for every request after the first (the deployed
 * suite's `/health` check came before the preparation installed it). So every entry point that
 * makes outbound calls (run.ts, deployed.ts, cleanup-deployed.ts, cli.ts, create-emulators.ts) and
 * Vitest's setup file (setup.ts) import this second, right after `connect-timeout.ts`. Which
 * origins are a stage is decided at each request, so installing before they are known is enough.
 */
import { installLostConnections } from "./lost-connections.ts";

installLostConnections();
