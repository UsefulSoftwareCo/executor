// ---------------------------------------------------------------------------
// Preset icon — a preset's `icon` is usually a plain image URL. A preset whose
// icon can only come from the local server (e.g. a Codex plugin's own icon,
// read off this machine at runtime) uses the `executor:` scheme instead: the
// path after the scheme is fetched from the executor API with the server auth
// header and must answer `{ icon: string | null }` (a data URI). The
// indirection exists because local auth is deliberately bearer-header-only —
// an <img> cannot authenticate itself.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "../api/server-connection";

export const EXECUTOR_ICON_SCHEME = "executor:";

const IconResponse = Schema.Struct({ icon: Schema.NullOr(Schema.String) });
const decodeIconResponse = Schema.decodeUnknownOption(IconResponse);

const resolved = new Map<string, Promise<string | null>>();

/** Resolve an `executor:`-scheme icon path to its data URI (or null). Shared
 *  by every surface that renders preset icons, including IntegrationFavicon's
 *  cascade. Results are memoized per path for the session; any failure is
 *  "no icon", never an error. */
export const resolveExecutorIcon = (path: string): Promise<string | null> => {
  const cached = resolved.get(path);
  if (cached) return cached;
  const authorization = getExecutorServerAuthorizationHeader();
  const request = Effect.runPromise(
    Effect.tryPromise(async () => {
      const response = await fetch(`${getExecutorApiBaseUrl()}${path}`, {
        headers: authorization === null ? {} : { authorization },
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return Option.match(decodeIconResponse(body), {
        onNone: () => null,
        onSome: ({ icon }) => icon,
      });
    }).pipe(Effect.orElseSucceed(() => null)),
  );
  resolved.set(path, request);
  return request;
};

/** Renders a preset icon, resolving `executor:` scheme icons through the
 *  authenticated API. `fallback` shows while loading and when there is no
 *  icon. */
export function PresetIcon(props: {
  readonly icon?: string;
  readonly className?: string;
  readonly fallback?: React.ReactNode;
}) {
  const isExecutorIcon = props.icon?.startsWith(EXECUTOR_ICON_SCHEME) ?? false;
  const [fetched, setFetched] = useState<string | null>(null);

  useEffect(() => {
    if (!isExecutorIcon || props.icon === undefined) return;
    let live = true;
    void resolveExecutorIcon(props.icon.slice(EXECUTOR_ICON_SCHEME.length)).then((icon) => {
      if (live) setFetched(icon);
    });
    return () => {
      live = false;
    };
  }, [isExecutorIcon, props.icon]);

  const src = isExecutorIcon ? fetched : (props.icon ?? null);
  if (src === null) return <>{props.fallback ?? null}</>;
  return <img src={src} alt="" className={props.className} loading="lazy" />;
}
