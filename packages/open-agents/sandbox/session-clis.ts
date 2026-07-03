import type { Sandbox } from "./interface";
import {
  hasConfiguredBraintrustCliCredentials,
  installConfiguredBraintrustCli,
} from "./braintrust-cli";
import {
  hasConfiguredDatadogPupCliCredentials,
  installConfiguredDatadogPupCli,
} from "./datadog-pup-cli";
import {
  hasConfiguredSnowflakeCliCredentials,
  installConfiguredSnowflakeCli,
} from "./snowflake-cli";

export async function installConfiguredSessionClis(sandbox: Sandbox): Promise<void> {
  const installers = [
    {
      name: "braintrust",
      configured: hasConfiguredBraintrustCliCredentials(),
      install: installConfiguredBraintrustCli,
    },
    {
      name: "datadog-pup",
      configured: hasConfiguredDatadogPupCliCredentials(),
      install: installConfiguredDatadogPupCli,
    },
    {
      name: "snowflake",
      configured: hasConfiguredSnowflakeCliCredentials(),
      install: installConfiguredSnowflakeCli,
    },
  ] as const;

  console.info("[session-clis] setup start", {
    sandboxType: sandbox.type,
    workingDirectory: sandbox.workingDirectory,
    configured: installers
      .filter((installer) => installer.configured)
      .map((installer) => installer.name),
  });

  await Promise.all(
    installers.map(async (installer) => {
      if (!installer.configured) {
        console.info("[session-clis] skipped", { cli: installer.name });
        return;
      }

      const startTime = Date.now();
      try {
        await installer.install(sandbox);
        console.info("[session-clis] installed", {
          cli: installer.name,
          durationMs: Date.now() - startTime,
        });
      } catch (error) {
        console.error(
          "[session-clis] failed",
          {
            cli: installer.name,
            durationMs: Date.now() - startTime,
          },
          error,
        );
        throw error;
      }
    }),
  );
}
