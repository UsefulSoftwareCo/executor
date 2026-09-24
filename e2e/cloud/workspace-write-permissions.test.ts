import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Target } from "../src/services";
import { workspaceWritePermissions } from "../src/workspace-write-permissions";
import { joinOrg } from "./support/session";

scenario(
  "Workspace writes · cloud members are denied while Personal writes and admin writes succeed",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);
    yield* workspaceWritePermissions(target, admin, member);
  }),
);
