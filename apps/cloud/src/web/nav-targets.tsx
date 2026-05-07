// ---------------------------------------------------------------------------
// Cloud app NavTargets — mounts shared `@executor-js/react` components against
// the cloud route tree, where source/policy routes live under `/$org/...`.
// Reads the URL-active org handle from `OrgRouteContext` so every link/nav
// target carries the right `:org` param.
// ---------------------------------------------------------------------------

import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { NavTargetsProvider, type NavTargets } from "@executor-js/react/api/nav-targets";

import { useOrgRoute } from "./org-route";

export const CloudNavTargets = ({ children }: { children: React.ReactNode }) => {
  const navigate = useNavigate();
  const { orgHandle } = useOrgRoute();

  const value = useMemo<NavTargets>(
    () => ({
      SourceLink: ({ namespace, ...rest }) => (
        <Link to="/$org/sources/$namespace" params={{ org: orgHandle, namespace }} {...rest} />
      ),
      AddSourceLink: ({ pluginKey, search, ...rest }) => (
        <Link
          to="/$org/sources/add/$pluginKey"
          params={{ org: orgHandle, pluginKey }}
          search={search}
          {...rest}
        />
      ),
      PoliciesLink: (props) => <Link to="/$org/policies" params={{ org: orgHandle }} {...props} />,
      goToSource: (namespace) =>
        void navigate({
          to: "/$org/sources/$namespace",
          params: { org: orgHandle, namespace },
        }),
      goToAddSource: (pluginKey, search) =>
        void navigate({
          to: "/$org/sources/add/$pluginKey",
          params: { org: orgHandle, pluginKey },
          search,
        }),
    }),
    [navigate, orgHandle],
  );

  return <NavTargetsProvider value={value}>{children}</NavTargetsProvider>;
};
