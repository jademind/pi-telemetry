import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Activity = "working" | "waiting_input" | "unknown";
type ContextPressure = "normal" | "approaching_limit" | "near_limit" | "at_limit";

interface InstanceSnapshot {
  schemaVersion: 2;
  source: "pi-telemetry";
  process: {
    pid: number;
    ppid: number;
    startedAt: number;
    updatedAt: number;
    uptimeMs: number;
    heartbeatSeq: number;
    heartbeatMs: number;
  };
  system: {
    host: string;
    user: string;
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
  };
  workspace: {
    cwd: string;
    git?: {
      branch?: string;
      commit?: string;
    };
  };
  session: {
    id: string;
    file?: string;
    name?: string;
  };
  model?: {
    provider?: string;
    id?: string;
    name?: string;
    thinkingLevel?: string;
  };
  state: {
    activity: Activity;
    isIdle: boolean;
    hasPendingMessages: boolean;
    waitingForInput: boolean;
    busy: boolean;
  };
  context?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    remainingTokens: number | null;
    remainingPercent: number | null;
    pressure: ContextPressure;
    closeToLimit: boolean;
    nearLimit: boolean;
  };
  capabilities: {
    hasUI: boolean;
  };
  lastEvent: string;
}

function getTelemetryDir(): string {
  const configured = process.env.PI_TELEMETRY_DIR?.trim();
  if (configured) return configured;
  return path.join(os.homedir(), ".pi", "agent", "telemetry", "instances");
}

function getHeartbeatMs(): number {
  const configured = Number(process.env.PI_TELEMETRY_HEARTBEAT_MS ?? "");
  const raw = Number.isFinite(configured) && configured > 0 ? configured : 1500;
  return Math.max(250, Math.floor(raw));
}

function getThresholds() {
  const close = Number(process.env.PI_TELEMETRY_CLOSE_PERCENT ?? "85");
  const near = Number(process.env.PI_TELEMETRY_NEAR_PERCENT ?? "95");
  return {
    close: Number.isFinite(close) ? close : 85,
    near: Number.isFinite(near) ? near : 95,
  };
}

function atomicWriteJson(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, filePath);
}

function safeUnlink(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function getGitInfo(cwd: string): { branch?: string; commit?: string } | undefined {
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 250,
    }).trim();
    const commit = execFileSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 250,
    }).trim();
    if (!branch && !commit) return undefined;
    return { branch: branch || undefined, commit: commit || undefined };
  } catch {
    return undefined;
  }
}

function getContextSummary(
  contextUsage: ReturnType<ExtensionContext["getContextUsage"]>,
  closeThreshold: number,
  nearThreshold: number,
): InstanceSnapshot["context"] | undefined {
  if (!contextUsage) return undefined;

  const tokens = contextUsage.tokens;
  const contextWindow = contextUsage.contextWindow;
  const percent = contextUsage.percent;

  const remainingTokens = typeof tokens === "number" && Number.isFinite(tokens) ? Math.max(contextWindow - tokens, 0) : null;
  const remainingPercent = typeof percent === "number" && Number.isFinite(percent) ? Math.max(100 - percent, 0) : null;

  const atLimit = typeof percent === "number" && percent >= 100;
  const nearLimit = typeof percent === "number" && percent >= nearThreshold;
  const closeToLimit = typeof percent === "number" && percent >= closeThreshold;

  const pressure: ContextPressure = atLimit
    ? "at_limit"
    : nearLimit
      ? "near_limit"
      : closeToLimit
        ? "approaching_limit"
        : "normal";

  return {
    tokens,
    contextWindow,
    percent,
    remainingTokens,
    remainingPercent,
    pressure,
    closeToLimit,
    nearLimit,
  };
}

export default function (pi: ExtensionAPI) {
  const startedAt = Date.now();
  const telemetryDir = getTelemetryDir();
  const telemetryFile = path.join(telemetryDir, `${process.pid}.json`);
  const heartbeatMs = getHeartbeatMs();
  const thresholds = getThresholds();

  let heartbeatSeq = 0;
  let lastSnapshot: InstanceSnapshot | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function makeSnapshot(ctx: ExtensionContext, lastEvent: string): InstanceSnapshot {
    const contextUsage = ctx.getContextUsage();
    const isIdle = ctx.isIdle();
    const hasPendingMessages = ctx.hasPendingMessages();
    const waitingForInput = isIdle && !hasPendingMessages;

    const model = ctx.model
      ? {
          provider: ctx.model.provider,
          id: ctx.model.id,
          name: ctx.model.name,
          thinkingLevel: (ctx.model as { thinkingLevel?: string }).thinkingLevel,
        }
      : undefined;

    return {
      schemaVersion: 2,
      source: "pi-telemetry",
      process: {
        pid: process.pid,
        ppid: process.ppid,
        startedAt,
        updatedAt: Date.now(),
        uptimeMs: Date.now() - startedAt,
        heartbeatSeq,
        heartbeatMs,
      },
      system: {
        host: os.hostname(),
        user: os.userInfo().username,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
      workspace: {
        cwd: ctx.cwd,
        git: getGitInfo(ctx.cwd),
      },
      session: {
        id: ctx.sessionManager.getSessionId(),
        file: ctx.sessionManager.getSessionFile() ?? undefined,
        name: pi.getSessionName(),
      },
      model,
      state: {
        activity: waitingForInput ? "waiting_input" : isIdle ? "unknown" : "working",
        isIdle,
        hasPendingMessages,
        waitingForInput,
        busy: !waitingForInput,
      },
      context: getContextSummary(contextUsage, thresholds.close, thresholds.near),
      capabilities: {
        hasUI: ctx.hasUI,
      },
      lastEvent,
    };
  }

  function publish(ctx: ExtensionContext, eventName: string) {
    heartbeatSeq += 1;
    const snapshot = makeSnapshot(ctx, eventName);
    lastSnapshot = snapshot;
    atomicWriteJson(telemetryFile, snapshot);
  }

  function startHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (!lastSnapshot) return;
      heartbeatSeq += 1;
      const now = Date.now();
      const next: InstanceSnapshot = {
        ...lastSnapshot,
        process: {
          ...lastSnapshot.process,
          updatedAt: now,
          uptimeMs: now - startedAt,
          heartbeatSeq,
        },
      };
      lastSnapshot = next;
      atomicWriteJson(telemetryFile, next);
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  function stopHeartbeat() {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  pi.registerCommand("pi-telemetry", {
    description: "Show where this process publishes telemetry",
    handler: async (_args, ctx) => {
      publish(ctx, "command:pi-telemetry");
      const msg = `pi-telemetry → ${telemetryFile}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    publish(ctx, "session_start");
    startHeartbeat();
  });

  pi.on("before_agent_start", async (_event, ctx) => publish(ctx, "before_agent_start"));
  pi.on("agent_start", async (_event, ctx) => publish(ctx, "agent_start"));
  pi.on("turn_start", async (_event, ctx) => publish(ctx, "turn_start"));
  pi.on("turn_end", async (_event, ctx) => publish(ctx, "turn_end"));
  pi.on("agent_end", async (_event, ctx) => publish(ctx, "agent_end"));
  pi.on("model_select", async (_event, ctx) => publish(ctx, "model_select"));
  pi.on("session_switch", async (_event, ctx) => publish(ctx, "session_switch"));
  pi.on("session_tree", async (_event, ctx) => publish(ctx, "session_tree"));
  pi.on("session_fork", async (_event, ctx) => publish(ctx, "session_fork"));
  pi.on("session_compact", async (_event, ctx) => publish(ctx, "session_compact"));

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopHeartbeat();
    safeUnlink(telemetryFile);
  });
}
