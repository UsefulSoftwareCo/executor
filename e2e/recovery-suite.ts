import { scenarios } from "./test-plan.ts";

type ScenarioKey = keyof typeof scenarios;

export const recoveryFiles: ReadonlyArray<string> = [
  "desktop-recovery.spec.ts",
  "desktop-apps.spec.ts",
];

export const skippedOnPackagedLanes: Readonly<Partial<Record<ScenarioKey, ReadonlyArray<string>>>> =
  {
    desktopAppPermissions: ["darwin"],
    desktopMigrationSettings: ["darwin"],
    desktopAppLifecycle: ["linux"],
    desktopLocalChoice: ["darwin", "win32"],
    desktopInstalledApps: ["darwin"],
    desktopAppColdStart: ["darwin"],
    desktopAppCapture: ["darwin", "win32"],
    desktopAppStartAtLogin: ["win32"],
  };

export const skippedOn = (key: ScenarioKey, platform: string) =>
  skippedOnPackagedLanes[key]?.includes(platform) === true;

export const recoveryTitles = (platform: string) =>
  (Object.entries(scenarios) as Array<[ScenarioKey, (typeof scenarios)[ScenarioKey]]>)
    .filter(([key, scenario]) => recoveryFiles.includes(scenario.file) && !skippedOn(key, platform))
    .map(([, scenario]) => scenario.title);
