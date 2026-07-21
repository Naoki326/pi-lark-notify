import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";

/**
 * lark-notify —— pi 主对话 ⇄ 飞书 双向桥
 *
 * 下行（通知）：主对话（非子 agent）每次完成时，通过 lark-cli 向指定飞书用户/群发送通知。
 * 上行（回注）：监听飞书 im.message.receive_v1 事件（WebSocket 长连接，lark-cli
 *   event consume 子进程），把你在飞书里的回复注入对应 pi 会话继续执行。
 *
 * 路由规则：
 *   - 回复某条通知（飞书里长按回复）→ 注入发出该通知的会话（按 message_id 精确匹配）。
 *   - 直接发消息（不回复通知）→ 注入最近发送过通知的会话。
 *   - 多个 pi 会话并存时各自认领，互不串话。
 *
 * 安全边界：
 *   - 只处理 sender_type = user 的单聊事件；配置了 userId 时只接受该用户的消息，
 *     他人给机器人发消息不会触发任何动作。
 *   - 子 agent 运行在独立进程中，不触发主会话事件，天然排除。
 *
 * 配置（~/.pi/agent/settings.json 或项目 .pi/settings.json）：
 * {
 *   "lark-notify": {
 *     "enabled": true,        // 总开关（默认 true）
 *     "userId": "ou_xxx",     // 私聊：接收人 open_id（与 chatId 二选一，userId 优先）
 *     "chatId": "oc_xxx",     // 群聊：目标群 chat_id
 *     "replyEnabled": true,   // 上行回注开关（默认 true）
 *     "receipt": true         // 转达后回执一条"已转达"（默认 true）
 *   }
 * }
 *
 * 依赖 @amaster.ai/pi-lark 提供的 lark-cli（~/.lark-cli），凭证由 pi-lark 初始化。
 */

interface NotifyConfig {
  enabled?: boolean;
  userId?: string;
  chatId?: string;
  replyEnabled?: boolean;
  receipt?: boolean;
}

// ---------------------------------------------------------------------------
// 配置与 lark-cli 调用
// ---------------------------------------------------------------------------

function loadConfig(cwd: string): NotifyConfig {
  const read = (file: string): NotifyConfig => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const section = parsed?.["lark-notify"];
      return section && typeof section === "object" ? section : {};
    } catch {
      return {};
    }
  };
  const globalCfg = read(join(homedir(), ".pi", "agent", "settings.json"));
  const projectCfg = read(join(cwd, ".pi", "settings.json"));
  return { ...globalCfg, ...projectCfg };
}

function resolveLarkCliBin(): string {
  const cliRoot = join(homedir(), ".lark-cli", "node_modules", "@larksuite", "cli", "bin");
  const candidates = [
    join(cliRoot, "lark-cli.exe"), // Windows
    join(cliRoot, "lark-cli"), // macOS / Linux
    join(homedir(), ".lark-cli", "node_modules", ".bin", "lark-cli"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "lark-cli"; // fallback to PATH
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * 本机安装了 hermes 时，环境里会有 HERMES_HOME 等变量，
 * lark-cli 检测到后会误认为是 hermes agent 调用并要求 config bind。
 * 这里清洗环境变量，让 lark-cli 走 ~/.lark-cli/config.json 的常规凭证。
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HERMES_|OPENCLAW_|LARK_CHANNEL)/i.test(key)) delete env[key];
  }
  return env;
}

function runLarkCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveLarkCliBin(), args, {
      env: cleanEnv(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("lark-cli 执行超时（30s）"));
    }, 30000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 发送飞书消息，成功返回 message_id，失败抛错。 */
async function sendLarkMessage(cfg: NotifyConfig, text: string): Promise<string | null> {
  const args = ["im", "+messages-send", "--as", "bot", "--text", text];
  if (cfg.userId) {
    args.push("--user-id", cfg.userId);
  } else {
    args.push("--chat-id", cfg.chatId!);
  }
  const result = await runLarkCli(args);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim().slice(0, 300) || `exit ${result.code}`);
  }
  try {
    return JSON.parse(result.stdout)?.data?.message_id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 跨会话共享状态（路由与去重）
// ---------------------------------------------------------------------------

interface SharedState {
  sessions: Record<string, { pid: number; cwd: string; startedAt: string; consumerPid?: number }>;
  notifications: Record<string, { sid: string; ts: number }>; // message_id -> 发送会话
  lastNotifier?: { sid: string; ts: number };
  claimed: Record<string, { sid: string; ts: number }>; // 已认领的事件 message_id
}

const STATE_FILE = join(homedir(), ".pi", "agent", "lark-notify-state.json");
const LOCK_DIR = `${STATE_FILE}.lock`;
const mySid = randomUUID();

function readState(): SharedState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      sessions: parsed.sessions ?? {},
      notifications: parsed.notifications ?? {},
      lastNotifier: parsed.lastNotifier,
      claimed: parsed.claimed ?? {},
    };
  } catch {
    return { sessions: {}, notifications: {}, claimed: {} };
  }
}

/** 目录锁：mkdir 原子创建实现跨进程互斥，保护状态文件的读-改-写。 */
function withStateLock<T>(fn: () => T): T | undefined {
  let acquired = false;
  for (let i = 0; i < 40; i++) {
    try {
      mkdirSync(LOCK_DIR);
      acquired = true;
      break;
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        // 锁已存在：超过 15 秒视为死锁持有者已崩溃，强制破锁
        try {
          if (Date.now() - statSync(LOCK_DIR).mtimeMs > 15000) rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {}
        const until = Date.now() + 75;
        while (Date.now() < until) {} // 忙等 75ms（锁持有时间极短）
        continue;
      }
      break;
    }
  }
  if (!acquired) return undefined;
  try {
    return fn();
  } finally {
    try {
      rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {}
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM"; // EPERM = 存在但无权
  }
}

function updateState(mutate: (st: SharedState) => void): void {
  withStateLock(() => {
    try {
      const st = readState();
      mutate(st);
      // 裁剪：通知映射保留 7 天，认领记录保留 2 天
      const now = Date.now();
      for (const [k, v] of Object.entries(st.notifications)) {
        if (now - v.ts > 7 * 86400_000) delete st.notifications[k];
      }
      for (const [k, v] of Object.entries(st.claimed)) {
        if (now - v.ts > 2 * 86400_000) delete st.claimed[k];
      }
      mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
      const tmp = `${STATE_FILE}.${mySid}.tmp`;
      writeFileSync(tmp, JSON.stringify(st, null, 2));
      renameSync(tmp, STATE_FILE);
    } catch {
      // 状态文件异常不阻断主流程
    }
  });
}

/** 终止指定 pid（尽力而为）。 */
function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

/**
 * 清理过期会话条目及其消费者：
 * - pid 已死的会话；
 * - 同进程但 5 秒前启动的旧实例（/reload 不产生 session_shutdown，
 *   同一 pi-web 进程里的旧扩展实例及其 lark-cli 消费者会残留泄漏）。
 *   不用「pid===process.pid 即杀」是因为 pi-web 模式下同一进程管理多个会话，
 *   那些是活跃的并发会话而非旧实例，不能误杀。
 */
function cleanupStaleSessions(): void {
  const now = Date.now();
  const STALE_AGE_MS = 5000;
  const toKill: number[] = [];
  updateState((st) => {
    for (const [sid, info] of Object.entries(st.sessions)) {
      if (sid === mySid) continue;
      const dead = !pidAlive(info.pid);
      const sameProcOld = info.pid === process.pid &&
        Date.parse(info.startedAt) < now - STALE_AGE_MS;
      if (dead || sameProcOld) {
        if (info.consumerPid && pidAlive(info.consumerPid)) toKill.push(info.consumerPid);
        delete st.sessions[sid];
      }
    }
  });
  for (const pid of toKill) killPid(pid);
}

/**
 * 兜底清理孤儿消费者进程。
 *
 * cleanupStaleSessions 只能清理 state 里登记过的 session 对应的消费者。
 * 但 session_shutdown 会先 delete session 条目再杀进程，一旦 kill 失败（Windows 上
 * ChildProcess.kill 对已 detach 的子进程可能不生效），消费者就成了 state 里查不到的孤儿，
 * 永远不会再被清。本函数以「系统里实际存在的 event consume 进程」为依据，杀掉不属于任何
 * 存活 session 的同类进程，与 cleanupStaleSessions 互补。
 */
async function cleanupOrphanConsumers(): Promise<void> {
  const aliveConsumerPids = new Set<number>();
  updateState((st) => {
    for (const info of Object.values(st.sessions)) {
      if (info.consumerPid && pidAlive(info.consumerPid)) aliveConsumerPids.add(info.consumerPid);
    }
  });
  // 枚举系统里实际存在的 event consume 进程（当前会话 consumer 尚未启动，不会误伤）
  let orphans: number[] = [];
  try {
    orphans = await listConsumerPids();
  } catch {
    return; // 枚举失败不阻断启动
  }
  for (const pid of orphans) {
    if (aliveConsumerPids.has(pid)) continue;
    killPid(pid);
  }
}

/**
 * 枚举本机所有 lark-cli “event consume im.message.receive_v1” 进程的 pid。
 * 跨平台：Windows 用 PowerShell Get-CimInstance；macOS/Linux 用 pgrep。
 */
function listConsumerPids(): Promise<number[]> {
  const isWin = platform() === "win32";
  const cmd = isWin ? "powershell" : "pgrep";
  const args = isWin
    ? [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'lark-cli.exe' -and $_.CommandLine -like '*event consume im.message.receive_v1*' } | Select-Object -ExpandProperty ProcessId",
      ]
    : ["-af", "lark-cli"];
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve([]);
    }, 8000);
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const pids: number[] = [];
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!isWin) {
          // pgrep -af 输出形如 “1234 lark-cli event consume ...”，需取首列并校验含 event consume
          if (!/event\s+consume\s+im\.message\.receive_v1/.test(trimmed)) continue;
        }
        const m = trimmed.match(/^\s*(\d+)/);
        if (m) pids.push(Number(m[1]));
      }
      resolve(pids);
    });
  });
}

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function larkNotify(pi: ExtensionAPI) {
  let lastAssistantText = "";
  let sessionCwd = "";
  let startedAtMs = 0;

  // 事件消费者生命周期
  let consumer: ChildProcess | null = null;
  let shuttingDown = false;
  let restartDelay = 3000;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;

  const ownNotifications = new Set<string>(); // 本会话发出的通知 message_id
  const seenEvents = new Set<string>(); // 本会话处理过的事件 message_id

  /** Set 超限裁剪：按插入顺序淘汰最旧的条目（Set 迭代有序）。 */
  function capSet(set: Set<string>, max: number): void {
    if (set.size <= max) return;
    let excess = set.size - max;
    for (const v of set) {
      set.delete(v);
      if (--excess < 0) break;
    }
  }

  function rememberSeen(id: string): void {
    seenEvents.add(id);
    capSet(seenEvents, 1000);
  }

  // -----------------------------------------------------------------------
  // 上行：飞书事件 → pi 会话
  // -----------------------------------------------------------------------

  async function handleEventLine(line: string): Promise<void> {
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }
    if (evt?.type !== "im.message.receive_v1") return;
    if (evt.sender_type !== "user") return; // 忽略 bot 自己

    const cfg = loadConfig(sessionCwd);
    if (cfg.enabled === false || cfg.replyEnabled === false) return;
    // 安全边界：配置了 userId 时只接受该用户的消息
    if (cfg.userId && evt.sender_id !== cfg.userId) return;
    if (evt.chat_type !== "p2p") return; // v1 只处理单聊

    const mid: string | undefined = evt.message_id;
    if (!mid || seenEvents.has(mid)) return;
    rememberSeen(mid);

    // 过期事件防护：消费者重连后 bus 可能补发缓冲事件
    const createMs = Number(evt.create_time);
    if (Number.isFinite(createMs) && startedAtMs > 0 && createMs < startedAtMs - 15000) return;

    const text = String(evt.content ?? "").trim();
    if (!text) return;

    // 路由：回复通知 → 精确匹配发送会话；直接发消息 → 最近通知过的会话
    if (evt.reply_to) {
      const own =
        ownNotifications.has(evt.reply_to) ||
        readState().notifications[evt.reply_to]?.sid === mySid;
      if (!own) return;
    } else {
      if (readState().lastNotifier?.sid !== mySid) return;
    }

    // 跨会话/重投递去重：先到先得
    let claimed = false;
    updateState((st) => {
      if (!st.claimed[mid]) {
        st.claimed[mid] = { sid: mySid, ts: Date.now() };
        claimed = true;
      }
    });
    if (!claimed) return;

    // 注入会话（忙时排队，空闲立即触发新一轮）
    pi.sendUserMessage(`【飞书】${text}`, { deliverAs: "followUp" });

    if (cfg.receipt !== false) {
      const project = basename(sessionCwd) || sessionCwd;
      try {
        await sendLarkMessage(cfg, `✅ 已转达 pi 会话（项目: ${project}）`);
      } catch {
        // 回执失败不影响注入
      }
    }
  }

  function startConsumer(): void {
    if (shuttingDown || consumer) return;
    const args = ["event", "consume", "im.message.receive_v1", "--as", "bot"];
    let child: ChildProcess;
    try {
      child = spawn(resolveLarkCliBin(), args, {
        env: cleanEnv(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      scheduleRestart();
      return;
    }
    consumer = child;
    // 登记消费者 pid，供 /reload 后的新实例清理本实例残留的消费者
    const consumerPid = child.pid;
    if (consumerPid) {
      updateState((st) => {
        if (st.sessions[mySid]) st.sessions[mySid].consumerPid = consumerPid;
      });
    }

    let buf = "";
    child.stdout?.on("data", (d) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          handleEventLine(line).catch(() => {});
        }
      }
    });
    child.stderr?.on("data", (d) => {
      // 收到 ready 标记说明连接正常，重置退避
      if (String(d).includes("ready event_key=")) restartDelay = 3000;
    });
    child.on("error", () => {
      // close 事件随后会到，统一在那里处理重启
    });
    child.on("close", () => {
      if (consumer === child) consumer = null;
      if (!shuttingDown) scheduleRestart();
    });
  }

  function scheduleRestart(): void {
    if (shuttingDown || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      restartDelay = Math.min(restartDelay * 2, 60000);
      startConsumer();
    }, restartDelay);
    restartTimer.unref?.();
  }

  function stopConsumer(): void {
    shuttingDown = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    const c = consumer;
    consumer = null;
    if (c) {
      try {
        c.stdin?.end(); // lark-cli 约定：stdin EOF = 优雅退出
      } catch {}
      const killer = setTimeout(() => {
        try {
          c.kill();
        } catch {}
      }, 2000);
      killer.unref?.();
    }
  }

  // -----------------------------------------------------------------------
  // pi 事件钩子
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    sessionCwd = ctx.cwd;
    startedAtMs = Date.now();

    const cfg = loadConfig(ctx.cwd);
    if (cfg.enabled === false || (!cfg.userId && !cfg.chatId)) return;

    cleanupStaleSessions();
    await cleanupOrphanConsumers();
    updateState((st) => {
      st.sessions[mySid] = {
        pid: process.pid,
        cwd: ctx.cwd,
        startedAt: new Date().toISOString(),
      };
    });

    if (cfg.replyEnabled !== false) startConsumer();
  });

  pi.on("session_shutdown", async () => {
    stopConsumer();
    updateState((st) => {
      delete st.sessions[mySid];
    });
  });

  pi.on("agent_end", async (event) => {
    const messages = (event as any).messages;
    if (!Array.isArray(messages)) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant") {
        const text = extractText(m.content).trim();
        if (text) {
          lastAssistantText = text;
          break;
        }
      }
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;

    const cfg = loadConfig(ctx.cwd);
    if (cfg.enabled === false) return;
    if (!cfg.userId && !cfg.chatId) return; // 未配置接收人，静默跳过

    const project = basename(ctx.cwd) || ctx.cwd;
    const time = new Date().toLocaleString("zh-CN", { hour12: false });

    // 完整附上最后一条回复，不截断、不改写（--text 原样发送，保留换行）
    const lines = [`✅ pi 主对话已完成`, `项目: ${project}`, `时间: ${time}`];
    if (lastAssistantText) lines.push("", lastAssistantText);
    const text = lines.join("\n");

    try {
      const messageId = await sendLarkMessage(cfg, text);
      // 记录 通知 message_id → 本会话 的映射，供回复路由
      if (messageId) ownNotifications.add(messageId);
      capSet(ownNotifications, 500);
      const ts = Date.now();
      updateState((st) => {
        st.lastNotifier = { sid: mySid, ts };
        if (messageId) st.notifications[messageId] = { sid: mySid, ts };
      });
      ctx.ui.notify("飞书通知已发送", "info");
    } catch (err) {
      ctx.ui.notify(
        `飞书通知发送失败: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
    }
  });
}
