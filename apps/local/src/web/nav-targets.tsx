// ---------------------------------------------------------------------------
// Local app NavTargets — mounts shared `@executor-js/react` components against
// the local route tree, where source/policy routes live at the root.
// ---------------------------------------------------------------------------

import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { NavTargetsProvider, type NavTargets } from "@executor-js/react/api/nav-targets";

export const LocalNavTargets = ({ children }: { children: React.ReactNode }) => {
  const navigate = useNavigate();

  const value = useMemo<NavTargets>(
    () => ({
      SourceLink: ({ namespace, ...rest }) => (
        <Link to="/sources/$namespace" params={{ namespace }} {...rest} />
      ),
      AddSourceLink: ({ pluginKey, search, ...rest }) => (
        <Link to="/sources/add/$pluginKey" params={{ pluginKey }} search={search} {...rest} />
      ),
      PoliciesLink: (props) => <Link to="/policies" {...props} />,
      goToSource: (namespace) =>
        void navigate({ to: "/sources/$namespace", params: { namespace } }),
      goToAddSource: (pluginKey, search) =>
        void navigate({
          to: "/sources/add/$pluginKey",
          params: { pluginKey },
          search,
        }),
    }),
    [navigate],
  );

  return <NavTargetsProvider value={value}>{children}</NavTargetsProvider>;
};
