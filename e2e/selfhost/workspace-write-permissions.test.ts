import { Effect } from "effect";

import { createInvitedIdentity } from "../targets/selfhost";
import { scenario } from "../src/scenario";
import { Target } from "../src/services";
import { workspaceWritePermissions } from "../src/workspace-write-permissions";

scenario(
  "Workspace writes · self-host members are denied while Personal writes and admin writes succeed",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const admin = yield* target.newIdentity();
    const member = yield* Effect.promise(() =>
      createInvitedIdentity(target.baseUrl, admin, {
        role: "member",
        emailPrefix: "write-permissions-member",
      }),
    );
    yield* workspaceWritePermissions(target, admin, member);
  }),
);
