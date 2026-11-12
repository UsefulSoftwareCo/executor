/** A native minute heartbeat repairs coordinator alarms after a failed event or isolate restart. */
export const scheduleRecoveryMilliseconds = 60_000;

/**
 * How far past its time a stored alarm must be, while nothing explains the wait, before the
 * coordinators treat it as held by the runtime and write it again. Delivery is normally well
 * under a second late; held alarms waited 10 to 60 seconds.
 */
export const heldAlarmMilliseconds = 5_000;

/**
 * Scheduled runs the coordinator keeps in flight at once, for every organization together. A run
 * holds its slot while its mutation waits on the app and the services it calls, which takes about
 * 2 s for most runs and 30 s or more for some. The Node hosts' 8 slots, sized for one server's own
 * workload, were full whenever a few slow runs met the runs due on the minute, so due runs from
 * every organization waited for other organizations' slow ones to finish. Replayed against four
 * days of production runs, at most about 35 were in flight at once, and 32 slots left none waiting
 * except in the backlog after a stall.
 */
export const cloudScheduleConcurrency = 32;
