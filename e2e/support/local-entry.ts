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

export const isScript = (entry: string) => /\.(?:[cm]?js|[cm]?ts)$/u.test(entry);

const unsupported = (entry: string): never => {
  throw new Error(`${entry} is an executable; Node loader hooks need a script entry`);
};
