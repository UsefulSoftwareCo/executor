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

export function useDisplayFormat(): DisplayFormat {
  const server = useAtomValue(displayFormatAtom);
  return useSyncExternalStore(unchanging, currentBrowserFormat, () => server);
}

export const formatMoment = (
  value: Date | number | string,
  format: DisplayFormat,
  options?: Intl.DateTimeFormatOptions,
) => new Date(value).toLocaleString(format.locale, { timeZone: format.timeZone, ...options });

export function DisplayFormatSync() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "";
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${timeZoneCookie}=${encodeURIComponent(currentBrowserFormat().timeZone)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }, []);
  return null;
}
