import { Link, useNavigate } from "@tanstack/react-router";
import type { DeployedApp } from "@executor-js/sdk";
import {
  MakeYourOwn as SharedMakeYourOwn,
  AddAppMenu as SharedMenu,
} from "@executor-js/ui/dashboard/add-app";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { Failure } from "./common.tsx";

function useAddAppDialogs() {
  const navigate = useNavigate();
  return {
    mutation: dashboardAtoms.importCustom,
    Failure,
    onInstalled: (app: DeployedApp) =>
      navigate({
        to: Object.keys(app.requirements.accounts).length ? "/apps/$appId/setup" : "/apps/$appId",
        params: { appId: app.id },
      }),
  };
}

export function AddAppMenu() {
  return (
    <SharedMenu
      {...useAddAppDialogs()}
      catalog={(content) => <Link to="/apps/add">{content}</Link>}
    />
  );
}

export function MakeYourOwn({ appearance }: { readonly appearance?: "link" | "button" }) {
  return <SharedMakeYourOwn appearance={appearance} {...useAddAppDialogs()} />;
}
