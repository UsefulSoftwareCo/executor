/**
 * In place remove
 */
export function removeUndefined<T extends Record<string, unknown>>(
  obj: T,
  recursive = false
): T {
  for (const k in obj) {
    if (obj[k] === undefined) {
      delete obj[k];
      continue;
    }

    if (recursive && isPlainObject(obj[k])) {
      obj[k] = removeUndefined(obj[k], recursive);
    }
  }

  return obj;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && value.constructor === Object
  );
}
