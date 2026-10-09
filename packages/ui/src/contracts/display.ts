/**
 * Locale and time zone for dates and numbers. A server render formats with the request's values
 * and sends them with the page, so hydration renders the same text; the browser then switches to
 * its own values if they differ, which happens only before it has saved its time zone.
 */
import { Schema } from "effect";
import { Atom } from "effect/reactivity";

export const DisplayFormat = Schema.Struct({ locale: Schema.String, timeZone: Schema.String });
export type DisplayFormat = typeof DisplayFormat.Type;

/** Saved by the browser so later documents render its local time on the server. */
export const timeZoneCookie = "executor-tz";

const supported = (format: DisplayFormat): boolean => {
  try {
    new Intl.DateTimeFormat(format.locale, { timeZone: format.timeZone });
    return true;
  } catch {
    return false;
  }
};

/** The browser's own locale and time zone. */
export const browserDisplayFormat = (): DisplayFormat => {
  const options = new Intl.DateTimeFormat().resolvedOptions();
  return { locale: options.locale, timeZone: options.timeZone };
};

/** A document request's preferred locale and saved time zone, or UTC before one is saved. */
export const requestDisplayFormat = (headers: {
  readonly acceptLanguage: string | undefined;
  readonly timeZone: string | undefined;
}): DisplayFormat => {
  const locale = headers.acceptLanguage?.split(",")[0]?.split(";")[0]?.trim();
  const preferred = {
    locale: locale === undefined || locale === "" || locale === "*" ? "en-US" : locale,
    timeZone: headers.timeZone ?? "UTC",
  };
  if (supported(preferred)) return preferred;
  const zone = { locale: "en-US", timeZone: preferred.timeZone };
  return supported(zone) ? zone : { locale: "en-US", timeZone: "UTC" };
};

export const displayFormatAtom = Atom.make<DisplayFormat>(
  typeof window === "undefined" ? { locale: "en-US", timeZone: "UTC" } : browserDisplayFormat(),
).pipe(Atom.serializable({ key: "display-format", schema: DisplayFormat }), Atom.keepAlive);
