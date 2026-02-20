#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function getTelemetryDir() {
  const configured = process.env.PI_TELEMETRY_DIR?.trim();
  if (configured) return configured;
  return path.join(os.homedir(), ".pi", "agent", "telemetry", "instances");
}

function getStaleMs() {
  const arg = getArg("--stale-ms");
  const configured = Number(arg ?? process.env.PI_TELEMETRY_STALE_MS ?? "");
  const raw = Number.isFinite(configured) && configured > 0 ? configured : 10_000;
  return Math.floor(raw);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function normalizeInstance(data) {
  if (!data || typeof data !== "object") return undefined;
  if (data.schemaVersion === 2 && data.process?.pid) return data;
  return undefined;
}

const now = Date.now();
const staleMs = getStaleMs();
const telemetryDir = getTelemetryDir();

let files = [];
try {
  files = fs
    .readdirSync(telemetryDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(telemetryDir, name));
} catch {
  // directory may not exist yet
}

const instances = [];
for (const file of files) {
  const data = normalizeInstance(readJson(file));
  if (!data) continue;

  const pid = Number(data.process?.pid);
  const updatedAt = Number(data.process?.updatedAt);
  const alive = isPidAlive(pid);
  const stale = !Number.isFinite(updatedAt) || now - updatedAt > staleMs;

  instances.push({
    ...data,
    telemetry: {
      file,
      alive,
      stale,
      ageMs: Number.isFinite(updatedAt) ? now - updatedAt : null,
    },
  });
}

const active = instances
  .filter((i) => i.telemetry.alive && !i.telemetry.stale)
  .sort((a, b) => a.process.pid - b.process.pid);

const counts = {
  total: active.length,
  working: active.filter((i) => i.state?.activity === "working").length,
  waiting_input: active.filter((i) => i.state?.activity === "waiting_input").length,
  unknown: active.filter((i) => i.state?.activity === "unknown").length,
};

const aggregate =
  counts.total === 0
    ? "none"
    : counts.working === counts.total
      ? "working"
      : counts.waiting_input === counts.total
        ? "waiting_input"
        : "mixed";

const context = {
  reporting: active.filter((i) => i.context && typeof i.context.percent === "number").length,
  closeToLimit: active.filter((i) => i.context?.closeToLimit).length,
  nearLimit: active.filter((i) => i.context?.nearLimit).length,
  atLimit: active.filter((i) => i.context?.pressure === "at_limit").length,
  maxPercent: active.reduce((max, i) => {
    const p = i.context?.percent;
    return typeof p === "number" && p > max ? p : max;
  }, 0),
};

const sessions = {};
for (const instance of active) {
  const key = instance.session?.id || "unknown";
  if (!sessions[key]) {
    sessions[key] = {
      sessionId: key,
      name: instance.session?.name,
      file: instance.session?.file,
      cwd: instance.workspace?.cwd,
      pids: [],
      activities: { working: 0, waiting_input: 0, unknown: 0 },
      context: { closeToLimit: 0, nearLimit: 0, atLimit: 0, maxPercent: 0 },
    };
  }
  const group = sessions[key];
  group.pids.push(instance.process.pid);
  const activity = instance.state?.activity;
  if (activity === "working" || activity === "waiting_input" || activity === "unknown") {
    group.activities[activity] += 1;
  }
  if (instance.context?.closeToLimit) group.context.closeToLimit += 1;
  if (instance.context?.nearLimit) group.context.nearLimit += 1;
  if (instance.context?.pressure === "at_limit") group.context.atLimit += 1;
  const p = instance.context?.percent;
  if (typeof p === "number" && p > group.context.maxPercent) group.context.maxPercent = p;
}

const instancesByPid = {};
for (const instance of active) {
  instancesByPid[String(instance.process.pid)] = instance;
}

const payload = {
  schemaVersion: 2,
  source: "pi-telemetry-snapshot",
  generatedAt: now,
  telemetryDir,
  staleMs,
  aggregate,
  counts,
  context,
  sessions,
  instancesByPid,
  instances: active,
};

const pretty = process.argv.includes("--pretty");
process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : 0));
process.stdout.write("\n");
