/**
 * Page-level error handlers receive failures from every script in the document:
 * extensions, in-app browser bridges, wallet injections and third-party loaders
 * as well as our own bundles. A failure captured by that automatic
 * instrumentation belongs to us only when the frame that raised it is part of a
 * script from our built asset directory. Origin alone is not enough: injected
 * page code reports the document URL, and proxied vendor scripts share our origin.
 */

/** The directory holding a surface's built chunks, derived from one of its own modules. */
export const scriptDirectory = (moduleUrl: string): string =>
  moduleUrl.slice(0, moduleUrl.lastIndexOf("/") + 1);

/** Engine-provided functions have a marker instead of a script location; the caller raised them. */
const engineLocation = (location: string) =>
  location === "<anonymous>" ||
  location === "native" ||
  location === "[native code]" ||
  location.startsWith("self-hosted") ||
  /^index \d+$/.test(location);

/** A V8 frame is `at name (location)` or `at location`. */
const v8Frame = /^\s+at (?:[^(]*? \((.*)\)|(.*))$/;

/** V8 code from `eval` or `new Function` reports the location that created it. */
const v8EvalOrigin = /^eval at [^(]*\((.*)\)(?:, [^()]*)?$/;

const evalOrigin = (location: string): string => {
  const match = v8EvalOrigin.exec(location);
  return match === null ? location : evalOrigin(match[1] ?? "");
};

/**
 * JavaScriptCore and SpiderMonkey print `name@location`, where the name may be
 * empty and never contains the `: ` that follows the error name in every V8
 * description line.
 */
const namedFrame = /^((?:(?!: )[^@])*)@(.*)$/;

/** JavaScriptCore prints an anonymous function as its bare script location. */
const bareFrame = /^[a-z][\w+.-]*:\S*$/i;

/**
 * The script location of each frame, innermost first. Only lines that have the
 * shape of a frame count.
 *
 * V8 starts the stack with the error's description, which may span lines and
 * no longer match the error once its message changes, then prints one `at` line
 * per frame; an error the browser raised outside any script (a failed module
 * import or fetch) has the description alone. JavaScriptCore and SpiderMonkey
 * print frames only.
 */
const frameLocations = (stack: string): ReadonlyArray<string> => {
  const lines = stack.split("\n");
  const v8 = lines.flatMap((line) => {
    const match = v8Frame.exec(line);
    return match === null ? [] : [evalOrigin(match[1] ?? match[2] ?? "")];
  });
  if (v8.length > 0) return v8;
  return lines.flatMap((line) => {
    const frame = line.trim();
    if (bareFrame.test(frame)) return [frame];
    const match = namedFrame.exec(frame);
    return match === null ? [] : [match[2] ?? ""];
  });
};

/**
 * Whether an automatically captured value may be reported as a first-party failure.
 *
 * A thrown non-Error value carries no location. Only Error objects are
 * attributed; a failure our code raises as another value is not reported
 * automatically. An Error with no frame in any script is kept: browsers raise
 * those for our own module imports, fetches and clipboard writes, whoever
 * started them. Otherwise the innermost frame with a script location decides.
 *
 * A JavaScriptCore frame with an empty location (`caret@`, and `anonymous@` or
 * `eval code@` for code compiled by `new Function` or `eval`) cannot be traced
 * to a script, so it is foreign. It must be read from the raw stack: Sentry's
 * parser drops it, and when the function runs later from a listener or timer
 * the next frame is Sentry's own wrapper inside our chunk. Our bundles compile
 * no code at runtime, so no first-party failure has this shape.
 */
export const firstPartyFailure = (value: unknown, scripts: string): boolean => {
  if (!(value instanceof Error)) return false;
  const locations = typeof value.stack === "string" ? frameLocations(value.stack) : [];
  const thrower = locations.find((location) => !engineLocation(location));
  if (thrower === undefined) return true;
  return thrower.startsWith(scripts);
};

/** Whether the browser SDK captured this event from page-wide handlers or wrapped browser APIs. */
export const automaticBrowserCapture = (event: {
  readonly exception?:
    | {
        readonly values?:
          | ReadonlyArray<{ readonly mechanism?: { readonly type?: string } | undefined }>
          | undefined;
      }
    | undefined;
}): boolean =>
  event.exception?.values?.some((value) => value.mechanism?.type?.startsWith("auto.browser.")) ===
  true;
