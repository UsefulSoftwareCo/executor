// Stamp the surface client for this process so the integrations User-Agent is
// always `cli` or `desktop`, never guessed. The desktop app sets
// EXECUTOR_CLIENT=desktop before spawning the CLI as its sidecar/daemon, so
// `??=` preserves that; every other invocation is the CLI itself.
//
// This MUST run before the `@executor-js/local` import graph loads: apps/local
// builds its User-Agent from EXECUTOR_CLIENT at module init (installation.ts),
// so setting the env in main.ts's body would run too late. Imported as an early
// side effect in main.ts, right after native-bindings.
process.env.EXECUTOR_CLIENT ??= "cli";
