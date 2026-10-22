import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { AccountHttpApi, AccountUnauthorized, DelegatedCredentialsResponse } from "./api";
import { AccountHandlers } from "./handlers";
import {
  AccountProvider,
  DelegationProvider,
  type AccountProviderShape,
  type DelegationProviderShape,
  type DelegationRequestContext,
} from "./service";

const deny = (..._args: ReadonlyArray<unknown>) => Effect.fail(new AccountUnauthorized());

const accountProvider: AccountProviderShape = {
  me: deny,
  listApiKeys: deny,
  createApiKey: deny,
  revokeApiKey: deny,
  listOrgApiKeys: deny,
  createOrgApiKey: deny,
  revokeOrgApiKey: deny,
  listMembers: deny,
  listRoles: deny,
  inviteMember: deny,
  removeMember: deny,
  updateMemberRole: deny,
  updateOrgName: deny,
};

const emptyDelegatedCredentials: typeof DelegatedCredentialsResponse.Type = {
  credentials: [],
  nextCursor: null,
  capabilities: {
    issuanceEnabled: false,
    localKeysEnabled: false,
    externalAdapters: [],
    canFilterTargets: false,
  },
  notifications: [],
};

describe("account request origin boundary", () => {
  it("keeps the actual request origin separate from a forged browser Origin", async () => {
    const seen: DelegationRequestContext[] = [];
    const delegationProvider: DelegationProviderShape = {
      listDelegatedCredentials: (request) => {
        seen.push(request);
        return Effect.succeed(emptyDelegatedCredentials);
      },
      listDelegationTargets: deny,
      listDelegationScopeOptions: deny,
      listDelegationNotifications: deny,
      markDelegationNotificationRead: deny,
      createDelegatedKey: deny,
      startDelegationChallenge: deny,
      getDelegationChallenge: deny,
      completeDelegationProof: deny,
      consentDelegationChallenge: deny,
      consentDelegatedCredential: deny,
      rotateDelegatedKey: deny,
      revokeDelegatedCredential: deny,
      revokeAllDelegatedCredentials: deny,
      listDelegationAudit: deny,
    };
    const app = HttpApiBuilder.layer(AccountHttpApi).pipe(
      Layer.provide(AccountHandlers),
      HttpRouter.provideRequest(
        Layer.merge(
          Layer.succeed(AccountProvider)(accountProvider),
          Layer.succeed(DelegationProvider)(delegationProvider),
        ),
      ),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
    );
    const web = HttpRouter.toWebHandler(app, { disableLogger: true });
    const handlerContext = Context.make(AccountProvider, accountProvider).pipe(
      Context.add(DelegationProvider, delegationProvider),
    );
    const response = await web.handler(
      new Request("https://actual.example/account/delegated-credentials", {
        headers: { origin: "https://evil.example" },
      }),
      handlerContext,
    );
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      requestOrigin: "https://actual.example",
      browserOrigin: "https://evil.example",
    });

    await web.handler(
      new Request("https://actual.example/account/delegated-credentials"),
      handlerContext,
    );
    expect(seen[1]).toMatchObject({
      requestOrigin: "https://actual.example",
      browserOrigin: null,
    });
    await web.dispose();
  });
});
