/** Synchronous metadata storage. It holds no call arguments, answers or authority. */
export interface McpMetadataStorage {
  readonly get: (key: string) => unknown;
  readonly put: (key: string, value: unknown) => void;
  readonly delete: (key: string) => unknown;
  readonly list: (options: { readonly prefix: string }) => Iterable<[string, unknown]>;
}

/** Partition records by the authenticated caller before a protocol or interaction reads them. */
export const callerMcpStorage = (
  storage: McpMetadataStorage,
  caller: string,
): McpMetadataStorage => {
  const prefix = `${JSON.stringify(caller)}:`;
  return {
    get: (key) => storage.get(prefix + key),
    put: (key, value) => storage.put(prefix + key, value),
    delete: (key) => storage.delete(prefix + key),
    list: (options) =>
      Array.from(storage.list({ prefix: prefix + options.prefix }), ([key, value]) => [
        key.slice(prefix.length),
        value,
      ]),
  };
};
