/** Shared app-domain foundation. The existing paid ACM subscription is a prerequisite, never purchased by deployment. */
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Config, Effect } from "effect";
import { AppDomainZone } from "./src/infrastructure/app-domain-zone.ts";

export default AppDomainZone.make(
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const zone = yield* Cloudflare.Zone.Zone("Zone", {
      name: yield* Config.NonEmptyString("EXECUTOR_APP_DOMAIN_ZONE"),
    }).pipe(adopt(), retain());
    yield* Cloudflare.Acm.TotalTls("TotalTls", {
      zoneId: zone.zoneId,
      enabled: true,
      certificateAuthority: "google",
    }).pipe(adopt(), retain());
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const token = yield* Cloudflare.ApiToken.AccountApiToken("ControllerToken", {
      accountId,
      policies: zone.zoneId.pipe(
        Output.map((zoneId) => [
          {
            effect: "allow" as const,
            permissionGroups: [
              "DNS Write" as const,
              "Zone Read" as const,
              "SSL and Certificates Read" as const,
            ],
            resources: {
              [`com.cloudflare.api.account.${accountId}`]: {
                [`com.cloudflare.api.account.zone.${zoneId}`]: "*",
              },
            },
          },
        ]),
      ),
    }).pipe(retain());
    // Account-owned tokens currently share the saturated account allowance.
    // Test stages use the deployment user's separate quota through one scoped
    // token, without consuming a token for every disposable environment.
    const testToken = yield* Cloudflare.ApiToken.UserApiToken("TestControllerToken", {
      policies: zone.zoneId.pipe(
        Output.map((zoneId) => [
          {
            effect: "allow" as const,
            permissionGroups: [
              "DNS Write" as const,
              "Zone Read" as const,
              "SSL and Certificates Read" as const,
            ],
            resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
          },
        ]),
      ),
    }).pipe(retain());
    return {
      zone: { id: zone.zoneId, domain: zone.name, accountId },
      controllerToken: token.value,
      testControllerToken: testToken.value,
    };
  }),
);
