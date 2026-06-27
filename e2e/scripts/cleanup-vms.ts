import { cleanupCurrentEc2Resources, sweepExpiredEc2Resources } from "../src/vm/ec2-lifecycle";
import { cleanupCurrentTartResources, sweepExpiredTartResources } from "../src/vm/tart-lifecycle";

const usage =
  "usage: bun e2e/scripts/cleanup-vms.ts tart|ec2 [--sweep-expired --minimum-age-hours N]";

const optionValue = (args: readonly string[], option: string) => {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  return args[index + 1];
};

const main = async () => {
  const [provider, ...options] = process.argv.slice(2);
  if (provider === "tart") {
    if (!options.includes("--sweep-expired")) {
      if (options.length > 0) throw new Error(usage);
      const result = await cleanupCurrentTartResources();
      console.log(`deleted ${result.deleted} tart VM(s) for scope ${result.scope}`);
      return;
    }

    const rawMinimumAge = optionValue(options, "--minimum-age-hours");
    if (!rawMinimumAge || options.length !== 3) throw new Error(usage);
    const result = await sweepExpiredTartResources({
      minimumAgeHours: Number(rawMinimumAge),
    });
    console.log(`deleted ${result.deleted} expired tart VM(s) owned by ${result.repository}`);
    return;
  }

  if (provider === "ec2") {
    if (!options.includes("--sweep-expired")) {
      if (options.length > 0) throw new Error(usage);
      const result = await cleanupCurrentEc2Resources();
      console.log(`deleted ${result.deleted} EC2 resource(s) for scope ${result.scope}`);
      return;
    }

    const rawMinimumAge = optionValue(options, "--minimum-age-hours");
    if (!rawMinimumAge || options.length !== 3) throw new Error(usage);
    const minimumAgeHours = Number(rawMinimumAge);
    const result = await sweepExpiredEc2Resources({ minimumAgeHours });
    console.log(`deleted ${result.deleted} expired EC2 resource(s) owned by ${result.repository}`);
    return;
  }

  throw new Error(usage);
};

await main();
