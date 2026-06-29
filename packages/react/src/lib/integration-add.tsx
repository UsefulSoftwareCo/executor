// ---------------------------------------------------------------------------
// Integration add-flow helpers — the plugin-agnostic pieces every Add-source
// form repeats: decoding a mutation Exit into a user-facing message, the
// IntegrationAlreadyExistsError guard, the live slug-collision check against
// the catalog, and the inline error/collision alerts.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { integrationsOptimisticAtom } from "../api/atoms";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

/** The failed Exit's `message`, or `fallback` when the error carries none. */
export const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

export const isIntegrationAlreadyExistsExit = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => false,
    onSome: Predicate.isTagged("IntegrationAlreadyExistsError"),
  });

export const integrationExistsMessage = (slug: string): string =>
  `An integration named "${slug}" already exists. To add more authentication, update your existing integration.`;

/** Decode an add-integration failure into its inline message: the
 *  already-exists guard message for a slug collision, otherwise the error's
 *  own message (or `fallback`). */
export const addIntegrationErrorMessage = (
  exit: Exit.Exit<unknown, unknown>,
  slug: string,
  fallback: string,
): string =>
  isIntegrationAlreadyExistsExit(exit)
    ? integrationExistsMessage(slug)
    : errorMessageFromExit(exit, fallback);

/** Whether `slug` is already taken in the tenant-scoped catalog (pre-empting
 *  the API's `IntegrationAlreadyExistsError`). Blank slugs never collide —
 *  they let the server assign one. */
export function useSlugAlreadyExists(slug: string): boolean {
  const integrationsResult = useAtomValue(integrationsOptimisticAtom);
  return useMemo(
    () =>
      slug.length > 0 &&
      AsyncResult.isSuccess(integrationsResult) &&
      integrationsResult.value.some((integration) => String(integration.slug) === slug),
    [integrationsResult, slug],
  );
}

/** Inline destructive alert for a form-level error message. */
export function FormErrorAlert(props: { readonly message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="text-[12px] text-destructive">{props.message}</p>
    </div>
  );
}

/** The slug-collision alert with a link to the existing integration. Render
 *  gated by the caller (typically `show && !adding`). */
export function SlugCollisionAlert(props: { readonly slug: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="text-[12px] text-destructive">
        An integration named &quot;{props.slug}&quot; already exists. To add more authentication,
        update your existing integration.{" "}
        <Link
          to="/{-$orgSlug}/integrations/$namespace"
          params={{ namespace: props.slug }}
          className="font-medium underline underline-offset-2"
        >
          Open it
        </Link>
      </p>
    </div>
  );
}
