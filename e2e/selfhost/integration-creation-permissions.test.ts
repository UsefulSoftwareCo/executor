import { Effect } from "effect";
import { scenario } from "../src/scenario";
import { Target } from "../src/services";
import { integrationCreationPermissions } from "../src/integration-creation-permissions";
import { createInvitedIdentity } from "../targets/selfhost";

scenario(
  "Integration creation · self-host members see admin guidance and owners can add",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const admin = yield* target.newIdentity();
    const member = yield* Effect.promise(() =>
      createInvitedIdentity(target.baseUrl, admin, {
        role: "member",
        emailPrefix: "integration-permissions",
      }),
    );
    yield* integrationCreationPermissions(admin, member);
  }),
);
