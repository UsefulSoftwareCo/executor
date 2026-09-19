import { Effect } from "effect";
import { scenario } from "../src/scenario";
import { Target } from "../src/services";
import { integrationCreationPermissions } from "../src/integration-creation-permissions";
import { forBrowser, joinOrg } from "./support/session";

scenario(
  "Integration creation · cloud members see admin guidance and admins can add",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);
    yield* integrationCreationPermissions(forBrowser(admin), forBrowser(member));
  }),
);
