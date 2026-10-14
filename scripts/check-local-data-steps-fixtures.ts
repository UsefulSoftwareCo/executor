/**
 * Trees check-local-data-steps.ts must reject or accept: the latest SDK storage version and the
 * data steps local lists. Local must list step 7 from storage 4.0.11 on, whatever comes after it.
 */
export interface Fixture {
  readonly name: string;
  readonly storage: string;
  readonly steps: ReadonlyArray<string>;
  readonly rejects: boolean;
}

const everyHost = [
  "1_app_framework_pin",
  "2_app_framework_pin_catch_up",
  "3_build_framework_once",
  "4_expire_idle_agent_grants",
  "5_redeploy_pre_beta10_executor_apps",
  "6_stored_oauth_clients",
];

export const fixtures: ReadonlyArray<Fixture> = [
  { name: "4.0.11 without step 7", storage: "4.0.11", steps: everyHost, rejects: true },
  { name: "a later storage without step 7", storage: "4.0.12", steps: everyHost, rejects: true },
  { name: "a later minor without step 7", storage: "4.1.0", steps: everyHost, rejects: true },
  {
    name: "4.0.11 with step 7",
    storage: "4.0.11",
    steps: [...everyHost, "7_local_owners"],
    rejects: false,
  },
  { name: "4.0.10 without step 7", storage: "4.0.10", steps: everyHost, rejects: false },
];
