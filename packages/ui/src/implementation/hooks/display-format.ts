/** Dates and times in the reader's locale and time zone; see `contracts/display.ts`. */
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";
import {
  browserDisplayFormat,
  displayFormatAtom,
  timeZoneCookie,
  type DisplayFormat,
} from "../../contracts/display.ts";

const unchanging = () => () => {};
// oxlint-disable-next-line executor/no-module-level-mutable-state -- read only in the browser; server renders use the server snapshot
let browserFormat: DisplayFormat | undefined;
const currentBrowserFormat = () => (browserFormat ??= browserDisplayFormat());

/**
 * The format for this render. Hydration uses the server document's format, so the markup
 * matches; the next render uses the browser's own locale and time zone.
 */
export function useDisplayFormat(): DisplayFormat {
  const server = useAtomValue(displayFormatAtom);
  return useSyncExternalStore(unchanging, currentBrowserFormat, () => server);
}

/** Format a moment with explicit parts; the default is a full date and time. */
export const formatMoment = (
  value: Date | number | string,
  format: DisplayFormat,
  options?: Intl.DateTimeFormatOptions,
) => new Date(value).toLocaleString(format.locale, { timeZone: format.timeZone, ...options });

/**
 * After the document hydrates, mark it interactive and save the browser's time zone so later
 * documents render its local time on the server. Render once near the root of each dashboard.
 */
export function DisplayFormatSync() {
  useEffect(() => {
    // The page now responds to input; automation waits for this before interacting.
    document.documentElement.dataset.hydrated = "";
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${timeZoneCookie(window.location.protocol === "https:")}=${encodeURIComponent(currentBrowserFormat().timeZone)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }, []);
  return null;
}
