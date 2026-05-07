// ---------------------------------------------------------------------------
// NavTargets — app-injected navigation primitives
// ---------------------------------------------------------------------------
//
// The shared `@executor-js/react` package needs to navigate to a handful of
// app-defined routes (source detail, add-source, policies). Local mounts
// these at the root (`/sources/...`); cloud mounts them under `/$org/...`.
// The shared package can't be typed against both route trees, so each app
// provides typed `<Link>` components and `navigate(...)` callbacks via this
// context, and the package consumes them through `useNavTargets()`.

import { createContext, useContext } from "react";
import type { ComponentType, MouseEvent, ReactNode } from "react";

/** Common passthrough props for the injected link components. */
export type NavLinkProps = {
  children?: ReactNode;
  className?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

/** Search params accepted by the add-source page. */
export type AddSourceSearch = {
  readonly url?: string;
  readonly namespace?: string;
  readonly preset?: string;
};

export type NavTargets = {
  /** `<Link>` to the source detail page (`/sources/$namespace`). */
  SourceLink: ComponentType<NavLinkProps & { namespace: string }>;
  /** `<Link>` to the add-source page (`/sources/add/$pluginKey`). */
  AddSourceLink: ComponentType<NavLinkProps & { pluginKey: string; search?: AddSourceSearch }>;
  /** `<Link>` to the policies page (`/policies`). */
  PoliciesLink: ComponentType<NavLinkProps>;
  /** Programmatic navigation to the source detail page. */
  goToSource: (namespace: string) => void;
  /** Programmatic navigation to the add-source page. */
  goToAddSource: (pluginKey: string, search?: AddSourceSearch) => void;
};

const NavTargetsContext = createContext<NavTargets | null>(null);

export const NavTargetsProvider = NavTargetsContext.Provider;

export const useNavTargets = (): NavTargets => {
  const value = useContext(NavTargetsContext);
  if (!value) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React hook invariant
    throw new Error(
      "useNavTargets: no NavTargetsProvider in tree. Mount one in the app shell so the shared @executor-js/react components can navigate.",
    );
  }
  return value;
};
