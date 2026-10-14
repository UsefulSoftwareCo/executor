/** Run npm without a shell. Windows npm is a shell wrapper, so Node runs its JavaScript entry. */
import { Effect, Path } from "effect";

export const npmCommand = Effect.gen(function* () {
  const path = yield* Path.Path;
  return process.platform === "win32"
    ? {
        command: process.execPath,
        prefix: [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")],
      }
    : { command: "npm", prefix: [] };
});
