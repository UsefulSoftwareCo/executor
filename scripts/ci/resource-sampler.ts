import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const intervalMs = 5_000;
const topProcesses = 6;
const commandName = /^[\w.+:@-][\w .+:@/-]{0,14}$/u;
const pageMb = 4096 / 1024 / 1024;

interface CpuTicks {
  readonly busy: number;
  readonly total: number;
  readonly iowait: number;
  readonly steal: number;
}
interface Sample {
  readonly t: string;
  readonly load: readonly [number, number, number];
  readonly cores: number;
  readonly busy: number;
  readonly iowait: number;
  readonly steal: number;
  readonly coresBusy: number;
  readonly memTotalMb: number;
  readonly memAvailableMb: number;
  readonly memUsedMb: number;
  readonly swapUsedMb: number;
  readonly appdataRssMb?: number;
  readonly top: ReadonlyArray<{
    readonly name: string;
    readonly cpu: number;
    readonly n: number;
    readonly rssMb: number;
  }>;
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const cpuTicks = (): Map<string, CpuTicks> => {
  const ticks = new Map<string, CpuTicks>();
  for (const line of (read("/proc/stat") ?? "").split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const [name, ...fields] = line.trim().split(/\s+/u);
    const [user, nice, system, idle, iowait, irq, softirq, steal] = fields.map(Number);
    const values = [user, nice, system, idle, iowait, irq, softirq, steal].map(
      (value) => value ?? 0,
    );
    const total = values.reduce((sum, value) => sum + value, 0);
    ticks.set(name!, {
      busy: total - (values[3] ?? 0) - (values[4] ?? 0),
      total,
      iowait: values[4] ?? 0,
      steal: values[7] ?? 0,
    });
  }
  return ticks;
};

const processTicks = () => {
  const ticks = new Map<
    string,
    { readonly name: string; readonly cpu: number; readonly rss: number }
  >();
  let entries: Array<string> = [];
  try {
    entries = readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry));
  } catch {
    return ticks;
  }
  for (const pid of entries) {
    const stat = read(`/proc/${pid}/stat`);
    if (stat === undefined) continue;
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close < open) continue;
    const comm = stat.slice(open + 1, close);
    const fields = stat.slice(close + 2).split(" ");
    const cpu = Number(fields[11]) + Number(fields[12]);
    const rss = Number(fields[21]);
    if (!Number.isFinite(cpu)) continue;
    ticks.set(pid, {
      name: commandName.test(comm) ? comm : "other",
      cpu,
      rss: Number.isFinite(rss) ? rss : 0,
    });
  }
  return ticks;
};

const appdata = new Map<string, boolean>();
const isAppData = (pid: string) => {
  const known = appdata.get(pid);
  if (known === true) return true;
  let found = false;
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        if (/-appdata-.*AppDataSupervisor/u.test(readlinkSync(`/proc/${pid}/fd/${fd}`))) {
          found = true;
          break;
        }
      } catch {}
    }
  } catch {
    return false;
  }
  if (found) appdata.set(pid, true);
  return found;
};

const memory = () => {
  const values = new Map<string, number>();
  for (const line of (read("/proc/meminfo") ?? "").split("\n")) {
    const match = /^(\w+):\s+(\d+) kB$/u.exec(line);
    if (match) values.set(match[1]!, Number(match[2]) / 1024);
  }
  const total = values.get("MemTotal") ?? 0;
  const available = values.get("MemAvailable") ?? 0;
  return {
    memTotalMb: Math.round(total),
    memAvailableMb: Math.round(available),
    memUsedMb: Math.round(total - available),
    swapUsedMb: Math.round((values.get("SwapTotal") ?? 0) - (values.get("SwapFree") ?? 0)),
  };
};

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

const sample = (directory: string) => {
  const hz = 100;
  const samples: Array<Sample> = [];
  const totals = new Map<string, { cpuSeconds: number; peakRssMb: number }>();
  const appdataPeak = { rssMb: 0, at: "", pids: new Set<string>() };
  let cpu = cpuTicks();
  let processes = processTicks();
  let last = Date.now();
  const file = join(directory, "samples.ndjson");

  const tick = () => {
    try {
      const now = Date.now();
      const seconds = (now - last) / 1000;
      const nextCpu = cpuTicks();
      const nextProcesses = processTicks();
      const all = nextCpu.get("cpu");
      const previous = cpu.get("cpu");
      if (all === undefined || previous === undefined || seconds <= 0) return;
      const span = all.total - previous.total || 1;
      let coresBusy = 0;
      let cores = 0;
      for (const [name, value] of nextCpu) {
        if (name === "cpu") continue;
        cores++;
        const before = cpu.get(name);
        if (before && (value.busy - before.busy) / (value.total - before.total || 1) > 0.5)
          coresBusy++;
      }
      const byName = new Map<string, { cpu: number; n: number; rss: number }>();
      for (const [pid, value] of nextProcesses) {
        const before = processes.get(pid);
        const used = before && before.name === value.name ? value.cpu - before.cpu : value.cpu;
        const entry = byName.get(value.name) ?? { cpu: 0, n: 0, rss: 0 };
        entry.cpu += Math.max(0, used);
        entry.n++;
        entry.rss += value.rss;
        byName.set(value.name, entry);
      }
      for (const [name, entry] of byName) {
        const total = totals.get(name) ?? { cpuSeconds: 0, peakRssMb: 0 };
        total.cpuSeconds += entry.cpu / hz;
        total.peakRssMb = Math.max(total.peakRssMb, entry.rss * pageMb);
        totals.set(name, total);
      }
      const appdataPids = [...nextProcesses]
        .filter(([pid, value]) => value.name === "workerd" && isAppData(pid))
        .map(([pid]) => pid);
      const appdataRssMb =
        appdataPids.length === 0
          ? undefined
          : Math.round(
              appdataPids.reduce((sum, pid) => sum + (nextProcesses.get(pid)?.rss ?? 0), 0) *
                pageMb,
            );
      for (const pid of appdataPids) appdataPeak.pids.add(pid);
      if (appdataRssMb !== undefined && appdataRssMb > appdataPeak.rssMb) {
        appdataPeak.rssMb = appdataRssMb;
        appdataPeak.at = new Date(now).toISOString();
      }
      const [one, five, fifteen] = (read("/proc/loadavg") ?? "0 0 0").split(" ").map(Number);
      const row: Sample = {
        t: new Date(now).toISOString(),
        load: [one ?? 0, five ?? 0, fifteen ?? 0],
        cores,
        busy: round((all.busy - previous.busy) / span),
        iowait: round((all.iowait - previous.iowait) / span),
        steal: round((all.steal - previous.steal) / span),
        coresBusy,
        ...memory(),
        ...(appdataRssMb === undefined ? {} : { appdataRssMb }),
        top: [...byName]
          .sort((a, b) => b[1].cpu - a[1].cpu)
          .slice(0, topProcesses)
          .map(([name, entry]) => ({
            name,
            cpu: round(entry.cpu / hz / seconds),
            n: entry.n,
            rssMb: Math.round(entry.rss * pageMb),
          })),
      };
      samples.push(row);
      appendFileSync(file, `${JSON.stringify(row)}\n`);
      cpu = nextCpu;
      processes = nextProcesses;
      last = now;
    } catch {}
  };

  const summarise = () => {
    try {
      const busy = samples.map((row) => row.busy);
      const seconds = intervalMs / 1000;
      const cores = samples.at(-1)?.cores ?? 0;
      const summary = {
        samples: samples.length,
        intervalSeconds: seconds,
        from: samples[0]?.t ?? null,
        to: samples.at(-1)?.t ?? null,
        cores,
        busy: { p50: quantile(busy, 0.5), p90: quantile(busy, 0.9), max: quantile(busy, 1) },
        secondsOver90PercentBusy: samples.filter((row) => row.busy >= 0.9).length * seconds,
        coresBusy: {
          p50: quantile(
            samples.map((row) => row.coresBusy),
            0.5,
          ),
          p90: quantile(
            samples.map((row) => row.coresBusy),
            0.9,
          ),
          secondsAllBusy:
            samples.filter((row) => cores > 0 && row.coresBusy >= cores).length * seconds,
        },
        steal: {
          p50: quantile(
            samples.map((row) => row.steal),
            0.5,
          ),
          max: quantile(
            samples.map((row) => row.steal),
            1,
          ),
        },
        iowait: {
          p50: quantile(
            samples.map((row) => row.iowait),
            0.5,
          ),
          max: quantile(
            samples.map((row) => row.iowait),
            1,
          ),
        },
        load1: {
          p50: quantile(
            samples.map((row) => row.load[0]),
            0.5,
          ),
          max: quantile(
            samples.map((row) => row.load[0]),
            1,
          ),
        },
        memTotalMb: samples.at(-1)?.memTotalMb ?? null,
        memAvailableMb: {
          min: quantile(
            samples.map((row) => row.memAvailableMb),
            0,
          ),
        },
        swapUsedMb: {
          max: quantile(
            samples.map((row) => row.swapUsedMb),
            1,
          ),
        },
        appdata:
          appdataPeak.pids.size === 0
            ? null
            : {
                peakRssMb: appdataPeak.rssMb,
                peakAt: appdataPeak.at,
                pids: appdataPeak.pids.size,
              },
        processes: [...totals]
          .sort((a, b) => b[1].cpuSeconds - a[1].cpuSeconds)
          .slice(0, 12)
          .map(([name, total]) => ({
            name,
            cpuSeconds: Math.round(total.cpuSeconds),
            peakRssMb: Math.round(total.peakRssMb),
          })),
      };
      writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    } catch {}
  };

  const timer = setInterval(tick, intervalMs);
  const stop = () => {
    clearInterval(timer);
    tick();
    summarise();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};

const [command, directory] = process.argv.slice(2);
try {
  if (directory === undefined || !existsSync("/proc/stat")) {
  } else if (command === "start") {
    mkdirSync(directory, { recursive: true });
    const child = spawn(process.execPath, [process.argv[1]!, "run", directory], {
      detached: true,
      stdio: "ignore",
    });
    writeFileSync(join(directory, "sampler.pid"), String(child.pid));
    child.unref();
  } else if (command === "run") {
    sample(directory);
  } else if (command === "stop") {
    const pid = Number(read(join(directory, "sampler.pid")));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      const deadline = Date.now() + 5_000;
      const wait = () => {
        if (existsSync(join(directory, "summary.json"))) return report();
        if (Date.now() > deadline) return;
        setTimeout(wait, 100);
      };
      const report = () => {
        const summary = JSON.parse(read(join(directory, "summary.json")) ?? "{}") as {
          appdata?: { peakRssMb: number; peakAt: string; pids: number } | null;
        };
        if (summary.appdata)
          console.log(
            `Local Cloud's AppData runtime peaked at ${summary.appdata.peakRssMb} MB resident at ${summary.appdata.peakAt}` +
              (summary.appdata.pids > 1
                ? `, across ${summary.appdata.pids} AppData processes in this job (one per local Cloud the job started, and any that replaced one that died)`
                : "") +
              ".",
          );
      };
      wait();
    }
  }
} catch {}
