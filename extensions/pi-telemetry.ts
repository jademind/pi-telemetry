import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Activity = "working" | "waiting_input" | "unknown";
type ContextPressure = "normal" | "approaching_limit" | "near_limit" | "at_limit";
type MuxType = "tmux" | "zellij" | "screen";

type PsRow = {
  pid: number;
  ppid: number;
  comm: string;
  tty: string;
  args: string;
};

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
  routing?: {
    tty?: string;
    mux?: MuxType;
    muxSession?: string;
    muxPid?: number;
    terminalApp?: string;
    terminalPid?: number;
    source: "env" | "ancestry" | "mixed" | "none";
    env?: {
      tmux?: string;
      tmuxPane?: string;
      zellij?: string;
      zellijSessionName?: string;
      zellijPaneId?: string;
      zellijTabName?: string;
    };
    tmux?: {
      paneTTY?: string;
      paneTarget?: string;
      windowName?: string;
    };
    zellij?: {
      tabCandidates?: Array<{
        index: number;
        name: string;
        paneCwd: string;
      }>;
      matchedTab?: {
        index: number;
        name: string;
        paneCwd: string;
        match: "exact" | "suffix" | "single_candidate";
      };
    };
  };
  capabilities: {
    hasUI: boolean;
  };
  messages?: {
    lastAssistantText?: string;
    lastAssistantHtml?: string;
    lastAssistantUpdatedAt: number;
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

function sanitizeAssistantText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return undefined;
  return normalized.length > 16_000 ? `${normalized.slice(0, 15_997)}...` : normalized;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assistantTextToHtml(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const escaped = escapeHtml(text);
  return `<div class=\"pi-last-assistant\"><pre>${escaped}</pre></div>`;
}

function extractTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object")
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

function getLastAssistantTextFromBranch(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i] as { type?: string; message?: { role?: string; stopReason?: string; content?: unknown } };
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    if (typeof msg.stopReason === "string" && msg.stopReason !== "stop") continue;

    const text = extractTextContent(msg.content);
    const cleaned = sanitizeAssistantText(text);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function atomicWriteJson(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
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

function safeExecFileSync(cmd: string, args: string[], timeout = 300): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    });
  } catch {
    return undefined;
  }
}

function readPsRows(): PsRow[] {
  const output = safeExecFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm=,tty=,args="], 400);
  if (!output) return [];

  const rows: PsRow[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const parts = line.split(/\s+/, 5);
    if (parts.length < 4) continue;

    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const comm = parts[2] ?? "";
    const tty = parts[3] ?? "??";
    const args = parts[4] ?? comm;

    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, comm, tty, args });
  }

  return rows;
}

function extractZellijSession(args: string): string | undefined {
  const parts = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if ((p === "-s" || p === "--session") && i + 1 < parts.length) {
      return parts[i + 1];
    }
    if (p === "--server" && i + 1 < parts.length) {
      return path.basename(parts[i + 1]);
    }
  }
  return undefined;
}

function extractTmuxSession(args: string): string | undefined {
  const parts = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";

    if ((p === "-t" || p === "--target") && i + 1 < parts.length) {
      const target = (parts[i + 1] ?? "").trim();
      if (target) return target.split(":", 1)[0];
    }

    if (p.startsWith("-t") && p.length > 2) {
      const target = p.slice(2).trim();
      if (target) return target.split(":", 1)[0];
    }
  }
  return undefined;
}

function getTmuxSessionFromCurrentClient(): string | undefined {
  const output = safeExecFileSync("tmux", ["display-message", "-p", "#S"], 250);
  const session = output?.trim();
  return session || undefined;
}

function detectTerminalFromAncestry(pid: number, byPid: Map<number, PsRow>): { terminalApp?: string; terminalPid?: number } {
  let cur: number | undefined = pid;
  const seen = new Set<number>();

  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = byPid.get(cur);
    if (!row) break;

    const comm = row.comm.toLowerCase();
    const args = row.args.toLowerCase();

    if (comm.includes("ghostty") || args.includes("ghostty")) {
      return { terminalApp: "Ghostty", terminalPid: cur };
    }
    if (comm.includes("iterm") || args.includes("iterm")) {
      return { terminalApp: "iTerm2", terminalPid: cur };
    }
    if (comm === "terminal" || args.includes("terminal.app")) {
      return { terminalApp: "Terminal", terminalPid: cur };
    }

    cur = row.ppid;
  }

  return {};
}

function detectMuxFromAncestry(pid: number, byPid: Map<number, PsRow>): { mux?: MuxType; muxSession?: string; muxPid?: number } {
  let cur: number | undefined = byPid.get(pid)?.ppid;
  const seen = new Set<number>();

  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = byPid.get(cur);
    if (!row) break;

    const low = row.args.toLowerCase();
    const comm = row.comm.toLowerCase();

    if (comm.includes("zellij") || /(^|\s|\/)zellij(\s|$)/.test(low)) {
      return {
        mux: "zellij",
        muxSession: extractZellijSession(row.args),
        muxPid: row.pid,
      };
    }
    if (comm.includes("tmux") || /(^|\s|\/)tmux(\s|$)/.test(low)) {
      return {
        mux: "tmux",
        muxSession: extractTmuxSession(row.args),
        muxPid: row.pid,
      };
    }
    if (comm.includes("screen") || /(^|\s|\/)screen(\s|$)/.test(low)) {
      return { mux: "screen", muxPid: row.pid };
    }

    cur = row.ppid;
  }

  return {};
}

function getTmuxPaneForTTY(tty: string): { paneTTY?: string; paneTarget?: string; windowName?: string } | undefined {
  const ttyPath = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  const output = safeExecFileSync(
    "tmux",
    ["list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index} #{window_name}"],
    350,
  );
  if (!output) return undefined;

  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(" ", 3);
    if (parts.length < 2) continue;

    const paneTTY = parts[0];
    const paneTarget = parts[1];
    const windowName = parts[2] ?? "";

    if (paneTTY === ttyPath) {
      return { paneTTY, paneTarget, windowName };
    }
  }

  return undefined;
}

type ZellijTabCandidate = { index: number; name: string; paneCwd: string };

function parseZellijPiTabs(layout: string): ZellijTabCandidate[] {
  let tabIndex = 0;
  let currentTab = "";
  const tabs: ZellijTabCandidate[] = [];

  for (const raw of layout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("tab name=")) {
      tabIndex += 1;
      const m = line.match(/name="([^"]+)"/);
      currentTab = m?.[1] ?? `tab-${tabIndex}`;
      continue;
    }

    if (line.includes('pane command="pi"')) {
      const m = line.match(/cwd="([^"]+)"/);
      tabs.push({
        index: tabIndex,
        name: currentTab,
        paneCwd: m?.[1] ?? "",
      });
    }
  }

  return tabs;
}

function getZellijRouting(
  session: string,
  cwd: string,
): {
  tabCandidates?: ZellijTabCandidate[];
  matchedTab?: { index: number; name: string; paneCwd: string; match: "exact" | "suffix" | "single_candidate" };
} | undefined {
  const output = safeExecFileSync("zellij", ["-s", session, "action", "dump-layout"], 400);
  if (!output) return undefined;

  const tabCandidates = parseZellijPiTabs(output);
  if (tabCandidates.length === 0) return { tabCandidates };

  const normalize = (v: string) => path.normalize(v || "").replace(/\\/g, "/").toLowerCase();
  const cwdNorm = normalize(cwd);

  const exact = tabCandidates.find((t) => normalize(t.paneCwd) === cwdNorm);
  if (exact) {
    return {
      tabCandidates,
      matchedTab: { ...exact, match: "exact" },
    };
  }

  const suffix = tabCandidates.find((t) => {
    const paneNorm = normalize(t.paneCwd);
    return paneNorm.length > 0 && (cwdNorm === paneNorm || cwdNorm.endsWith(`/${paneNorm}`));
  });
  if (suffix) {
    return {
      tabCandidates,
      matchedTab: { ...suffix, match: "suffix" },
    };
  }

  if (tabCandidates.length === 1) {
    return {
      tabCandidates,
      matchedTab: { ...tabCandidates[0], match: "single_candidate" },
    };
  }

  return { tabCandidates };
}

function getRoutingSummary(ctx: ExtensionContext): InstanceSnapshot["routing"] {
  const rows = readPsRows();
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const self = byPid.get(process.pid);

  const tty = self?.tty && self.tty !== "??" ? self.tty : undefined;
  const ancestry = detectMuxFromAncestry(process.pid, byPid);
  const terminal = detectTerminalFromAncestry(process.pid, byPid);

  const env = {
    tmux: process.env.TMUX,
    tmuxPane: process.env.TMUX_PANE,
    zellij: process.env.ZELLIJ,
    zellijSessionName: process.env.ZELLIJ_SESSION_NAME,
    zellijPaneId: process.env.ZELLIJ_PANE_ID,
    zellijTabName: process.env.ZELLIJ_TAB_NAME,
  };

  let source: InstanceSnapshot["routing"]["source"] = "none";

  const envMux: MuxType | undefined = env.zellij || env.zellijSessionName ? "zellij" : env.tmux ? "tmux" : undefined;
  const envSession = envMux === "zellij" ? env.zellijSessionName : envMux === "tmux" ? getTmuxSessionFromCurrentClient() : undefined;

  let mux: MuxType | undefined = ancestry.mux;
  let muxSession = ancestry.muxSession;

  if (envMux && ancestry.mux && envMux === ancestry.mux) {
    source = "mixed";
  } else if (envMux) {
    source = "env";
    mux = envMux;
  } else if (ancestry.mux) {
    source = "ancestry";
  }

  if (envSession) {
    muxSession = envSession;
  }

  const routing: InstanceSnapshot["routing"] = {
    tty,
    mux,
    muxSession,
    muxPid: ancestry.muxPid,
    terminalApp: terminal.terminalApp,
    terminalPid: terminal.terminalPid,
    source,
    env,
  };

  if (mux === "tmux" && tty) {
    const pane = getTmuxPaneForTTY(tty);
    if (pane) routing.tmux = pane;
  }

  if (mux === "zellij" && muxSession) {
    const zr = getZellijRouting(muxSession, ctx.cwd);
    if (zr) routing.zellij = zr;
  }

  return routing;
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
  let lastAssistantTextCache: string | undefined;

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

    const apiLastAssistantText = sanitizeAssistantText(
      (ctx as ExtensionContext & { getLastAssistantText?: () => string | undefined }).getLastAssistantText?.(),
    );
    const branchLastAssistantText = getLastAssistantTextFromBranch(ctx);
    const lastAssistantText = apiLastAssistantText ?? branchLastAssistantText ?? lastAssistantTextCache;
    if (lastAssistantText) {
      lastAssistantTextCache = lastAssistantText;
    }
    const lastAssistantHtml = assistantTextToHtml(lastAssistantText);

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
      routing: getRoutingSummary(ctx),
      capabilities: {
        hasUI: ctx.hasUI,
      },
      messages: {
        lastAssistantText,
        lastAssistantHtml,
        lastAssistantUpdatedAt: Date.now(),
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

  function parseCommandArgs(args: string): string[] {
    return args.trim().split(/\s+/).filter(Boolean);
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

  try {
    pi.registerCommand("pi-telemetry", {
      description: "Show telemetry path and optionally emit the latest telemetry JSON",
      handler: async (args, ctx) => {
        publish(ctx, "command:pi-telemetry");

        const argv = parseCommandArgs(args);
        const wantsData = argv.includes("--data") || argv.includes("--json");
        const pretty = argv.includes("--pretty");

        const locationMsg = `pi-telemetry → ${telemetryFile}`;
        if (!wantsData) {
          if (ctx.hasUI) ctx.ui.notify(locationMsg, "info");
          return;
        }

        const snapshot = readJson(telemetryFile);
        if (!snapshot) {
          const errorMsg = `${locationMsg}\n(no telemetry snapshot available yet)`;
          pi.sendMessage({
            customType: "pi-telemetry",
            content: errorMsg,
            display: true,
          });
          if (ctx.hasUI) ctx.ui.notify("pi-telemetry: no snapshot available yet", "warning");
          return;
        }

        const payload = JSON.stringify(snapshot, null, pretty ? 2 : 0);
        const output = `${locationMsg}\n${payload}`;

        pi.sendMessage({
          customType: "pi-telemetry",
          content: output,
          display: true,
          details: {
            telemetryFile,
          },
        });

        if (ctx.hasUI) ctx.ui.notify("pi-telemetry: telemetry JSON emitted as message", "info");
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("conflicts with")) {
      console.warn(`[pi-telemetry] command /pi-telemetry already registered (${message})`);
    } else {
      throw error;
    }
  }

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
