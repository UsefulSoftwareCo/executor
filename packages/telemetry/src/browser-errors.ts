export const scriptDirectory = (moduleUrl: string): string =>
  moduleUrl.slice(0, moduleUrl.lastIndexOf("/") + 1);

const engineLocation = (location: string) =>
  location === "<anonymous>" ||
  location === "native" ||
  location === "[native code]" ||
  location.startsWith("self-hosted") ||
  /^index \d+$/.test(location);

const v8Frame = /^\s+at (?:[^(]*? \((.*)\)|(.*))$/;

const v8EvalOrigin = /^eval at [^(]*\((.*)\)(?:, [^()]*)?$/;

const evalOrigin = (location: string): string => {
  const match = v8EvalOrigin.exec(location);
  return match === null ? location : evalOrigin(match[1] ?? "");
};

const namedFrame = /^((?:(?!: )[^@])*)@(.*)$/;

const bareFrame = /^[a-z][\w+.-]*:\S*$/i;

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

export const firstPartyFailure = (value: unknown, scripts: string): boolean => {
  if (!(value instanceof Error)) return false;
  const locations = typeof value.stack === "string" ? frameLocations(value.stack) : [];
  const thrower = locations.find((location) => !engineLocation(location));
  if (thrower === undefined) return true;
  return thrower.startsWith(scripts);
};

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
