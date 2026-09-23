/** Node-only adapter for measurements of this process, never the whole machine. */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { cpuUsage, memoryUsage, pid, uptime } from "node:process";
import { Effect, Metric } from "effect";

const gauge = (name: string, unit: string, description: string) =>
  Metric.gauge(name, { description, attributes: { unit } });

const metrics = {
  cpu: gauge(
    "executor.process.cpu.cores",
    "1",
    "CPU seconds per wall second; one means one busy core",
  ),
  rss: gauge("process.memory.usage", "By", "Resident memory of this process"),
  heapUsed: gauge("nodejs.memory.heap.used", "By", "Used JavaScript heap"),
  heapTotal: gauge("nodejs.memory.heap.total", "By", "Allocated JavaScript heap"),
  external: gauge(
    "nodejs.memory.external",
    "By",
    "Memory associated with JavaScript objects outside the heap",
  ),
  utilization: gauge(
    "nodejs.eventloop.utilization",
    "1",
    "Fraction of the interval the event loop was active",
  ),
  delayMean: gauge(
    "nodejs.eventloop.delay.mean",
    "s",
    "Mean event-loop delay during this interval",
  ),
  delayP99: gauge(
    "nodejs.eventloop.delay.p99",
    "s",
    "99th percentile event-loop delay during this interval",
  ),
  delayMax: gauge(
    "nodejs.eventloop.delay.max",
    "s",
    "Maximum event-loop delay during this interval",
  ),
};

/**
 * Start one sampler in the host's scope and metric registry. The first log follows
 * a one-second measurement window, then one log every 30 seconds. Logs remain
 * useful without a metrics exporter. Closing the scope stops sampling and releases
 * the delay monitor. Install once per process, outside request-owned scopes.
 */
export const startProcessMetrics = (service: string) =>
  Effect.gen(function* () {
    const delay = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const monitor = monitorEventLoopDelay({ resolution: 20 });
        monitor.enable();
        return monitor;
      }),
      (monitor) => Effect.sync(() => monitor.disable()),
    );
    let previousTime = performance.now();
    let previousCpu = cpuUsage();
    let previousLoop = performance.eventLoopUtilization();
    const sample = Effect.gen(function* () {
      const now = performance.now();
      const cpu = cpuUsage();
      const loop = performance.eventLoopUtilization();
      const memory = memoryUsage();
      const seconds = (now - previousTime) / 1_000;
      const cores =
        (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1_000_000 / seconds;
      const utilization = performance.eventLoopUtilization(loop, previousLoop).utilization;
      const eventLoopDelay =
        delay.count === 0
          ? undefined
          : {
              mean: delay.mean / 1_000_000_000,
              p99: delay.percentile(99) / 1_000_000_000,
              max: delay.max / 1_000_000_000,
            };
      previousTime = now;
      previousCpu = cpu;
      previousLoop = loop;
      delay.reset();

      yield* Metric.update(metrics.cpu, cores);
      yield* Metric.update(metrics.rss, memory.rss);
      yield* Metric.update(metrics.heapUsed, memory.heapUsed);
      yield* Metric.update(metrics.heapTotal, memory.heapTotal);
      yield* Metric.update(metrics.external, memory.external);
      yield* Metric.update(metrics.utilization, utilization);
      if (eventLoopDelay !== undefined) {
        yield* Metric.update(metrics.delayMean, eventLoopDelay.mean);
        yield* Metric.update(metrics.delayP99, eventLoopDelay.p99);
        yield* Metric.update(metrics.delayMax, eventLoopDelay.max);
      }
      yield* Effect.logInfo("process.runtime").pipe(
        Effect.annotateLogs({
          "event.name": "process.runtime",
          "service.name": service,
          "process.pid": pid,
          "process.uptime.seconds": uptime(),
          "sample.duration.seconds": seconds,
          "process.cpu.cores": cores,
          "process.cpu.user.seconds": cpu.user / 1_000_000,
          "process.cpu.system.seconds": cpu.system / 1_000_000,
          "process.memory.rss.bytes": memory.rss,
          "process.memory.heap.used.bytes": memory.heapUsed,
          "process.memory.heap.total.bytes": memory.heapTotal,
          "process.memory.external.bytes": memory.external,
          "eventloop.utilization": utilization,
          ...(eventLoopDelay === undefined
            ? {}
            : {
                "eventloop.delay.mean.ms": eventLoopDelay.mean * 1_000,
                "eventloop.delay.p99.ms": eventLoopDelay.p99 * 1_000,
                "eventloop.delay.max.ms": eventLoopDelay.max * 1_000,
              }),
        }),
      );
    });
    yield* Effect.sleep("1 second").pipe(
      Effect.andThen(sample),
      Effect.andThen(Effect.sleep("30 seconds").pipe(Effect.andThen(sample), Effect.forever)),
      Effect.forkScoped,
    );
  });
