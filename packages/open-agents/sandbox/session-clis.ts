import type { Sandbox } from "./interface";
import { installConfiguredBraintrustCli } from "./braintrust-cli";
import { installConfiguredDatadogPupCli } from "./datadog-pup-cli";
import { installConfiguredSnowflakeCli } from "./snowflake-cli";

export async function installConfiguredSessionClis(sandbox: Sandbox): Promise<void> {
  await Promise.all([
    installConfiguredBraintrustCli(sandbox),
    installConfiguredDatadogPupCli(sandbox),
    installConfiguredSnowflakeCli(sandbox),
  ]);
}
