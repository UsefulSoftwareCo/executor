import { Struct } from "effect";

// Keep these helpers deliberately small and local. They preserve only the
// upstream helper behavior this vendored compiler actually uses.
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const cloneDeep = <T>(value: T): T => structuredClone(value);

export const merge = <T extends object>(
  target: T,
  ...sources: ReadonlyArray<object | undefined>
): T => {
  const output = target as Record<string, unknown>;
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const current = output[key];
      output[key] =
        isPlainObject(current) && isPlainObject(value)
          ? merge({ ...current }, value)
          : cloneDeep(value);
    }
  }
  return target;
};

export const findKey = <T>(
  object: Record<string, T> | undefined,
  predicate: (value: T, key: string) => boolean,
): string | undefined => {
  if (!object) return undefined;
  for (const [key, value] of Object.entries(object)) {
    if (predicate(value, key)) return key;
  }
  return undefined;
};

export const memoize = <F extends (arg: any, ...rest: any[]) => any>(fn: F): F => {
  const cache = new Map<Parameters<F>[0], ReturnType<F>>();
  return ((arg: Parameters<F>[0], ...rest: unknown[]) => {
    if (cache.has(arg)) return cache.get(arg);
    const value = fn(arg, ...rest);
    cache.set(arg, value);
    return value;
  }) as F;
};

export const omit = <T extends object, K extends keyof T>(object: T, ...keys: K[]): Omit<T, K> =>
  Struct.omit(object, keys);

export const uniqBy = <T>(items: ReadonlyArray<T>, iteratee: (value: T) => string): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = iteratee(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

export const deburr = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export const upperFirst = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
