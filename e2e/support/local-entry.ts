/**
 * The local CLI as a command. A JavaScript entry, the source `bin.ts` or a `bin.mjs` launcher,
 * runs under Node; a release executable runs directly, with no Node involved.
 */
export const localEntryCommand = (
  entry: string,
  args: ReadonlyArray<string>,
  nodeArgs: ReadonlyArray<string> = [],
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
  isScript(entry)
    ? { command: "node", args: [...nodeArgs, entry, ...args] }
    : nodeArgs.length === 0
      ? { command: entry, args }
      : unsupported(entry);

/** Whether the entry is a script Node starts rather than an executable. */
export const isScript = (entry: string) => /\.(?:[cm]?js|[cm]?ts)$/u.test(entry);

/** Node loader hooks cannot reach inside an executable, which refuses every preload. */
const unsupported = (entry: string): never => {
  throw new Error(`${entry} is an executable; Node loader hooks need a script entry`);
};
