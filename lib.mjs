// Plumbing the notifier, the mute action and the doctor all share: what the
// config keys are, how a value is resolved from them, where herdr's binary is,
// and how not to print a bot token. One copy, so a fix to any of it reaches all
// three. The message itself is built in notify.mjs.

import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";


// Every key is overridable from the plugin config dir's .env (see .env.example).
export const DEFAULTS = {
  NOTIFY_STATUSES: "done,blocked",
  SHOW_TITLE: "1",
  SHOW_PROMPT: "1",
  PROMPT_CHARS: "120",
  SHOW_PROJECT: "1",
  SHOW_BRANCH: "1",
  SHOW_CHANGES: "1",
  SHOW_DURATION: "1",
  SHOW_TIMESTAMP: "0",
  SHOW_TOKENS: "1",
  SHOW_TOOLS: "0",
  SHOW_PANE: "1",
  SHOW_HOST: "1",
  SHOW_HERD: "1",
  SHOW_LAST_MESSAGE: "1",
  SHOW_SCREEN_ON_BLOCKED: "1",
  LAST_MESSAGE_CHARS: "1200",
  SCREEN_LINES: "12",
  MIN_DURATION_SECONDS: "0",
  BLOCKED_REMINDER_MINUTES: "0",
  QUIET_HOURS: "",
  TELEGRAM_TOPIC_ID: "",
  TELEGRAM_TOPICS: "",
  NOTIFY_WORKSPACES: "",
  IGNORE_WORKSPACES: "",
  DEBUG: "0",
  DRY_RUN: "0",
};

export function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// The .env holds the bot token, and anyone holding it can post as the bot. Herdr
// creates the config dir with the default umask, so the file is usually born
// world-readable — say so on every run that reads a loose one, with the fix.
export function warnIfWorldReadable(path) {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      console.error(
        `herdr-telegram-notify: ${path} is readable by other users (mode ${mode.toString(8)}) and holds your bot token — run: chmod 600 ${path}`
      );
    }
  } catch {}
}

export function loadEnvFile(dir) {
  if (!dir) return {};
  try {
    const file = join(dir, ".env");
    const text = readFileSync(file, "utf8");
    warnIfWorldReadable(file);
    const out = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

// Keys the plugin reads that have no default: the two required ones, and the one
// only the mute action looks at.
export const EXTRA_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "MUTE_MINUTES"];

// A .env key nobody reads is silent by nature: SHOW_TOKEN looks exactly like a
// setting that is working, and the message it was meant to change never changes.
export function warnUnknownKeys(fileEnv) {
  const known = [...Object.keys(DEFAULTS), ...EXTRA_KEYS];
  const lookup = known.map((k) => k.toLowerCase());
  for (const key of Object.keys(fileEnv)) {
    if (known.includes(key)) continue;
    const lower = key.toLowerCase();
    // A wrong case, a missing letter or one too many — the typos a list of every
    // valid key would not help you find.
    const index = lookup.findIndex((k) => k === lower || k.startsWith(lower) || lower.startsWith(k));
    console.error(
      `herdr-telegram-notify: .env sets ${key}, which this plugin does not read${index === -1 ? "" : ` — did you mean ${known[index]}?`}`
    );
  }
}

// The process env wins over the config dir's .env, which wins over DEFAULTS —
// so a single run can be overridden (DRY_RUN=1, SCREEN_LINES=40) without
// editing the file that holds the persistent setup.
export function loadConfig() {
  const fileEnv = loadEnvFile(process.env.HERDR_PLUGIN_CONFIG_DIR);
  warnUnknownKeys(fileEnv);
  return (key) => firstDefined(process.env[key], fileEnv[key], DEFAULTS[key]);
}

// Undefined when the list is empty — "nothing said", which is not the same

export function isOn(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

export function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The bot token is in the request URL, so anything that quotes the URL back —
// a fetch error, a stack trace — would put it in a log file. The pattern catches
// a token-shaped string even where the token itself was not passed in, which is
// the case anywhere config has not been read yet.
export function redact(text, token) {
  const s = token ? String(text).split(token).join("<token>") : String(text);
  // No leading boundary: in a request URL the token follows `bot` directly, and
  // `t8735…` is not a word boundary at all.
  return s.replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, "<token>");
}

// Herdr's server may not have the interactive shell's PATH, so prefer the
// binary path it injects and fall back to the usual install locations.
export function herdrBin() {
  const candidates = [
    process.env.HERDR_BIN_PATH,
    join(homedir(), ".local", "bin", "herdr"),
    "/usr/local/bin/herdr",
    "/usr/bin/herdr",
    "/opt/homebrew/bin/herdr",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "herdr";
}

export function herdr(args, timeout = 4000) {
  const res = spawnSync(herdrBin(), args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return undefined;
  return res.stdout;
}

// ------------------------------------------------ formatting the message

export const TELEGRAM_LIMIT = 4096;

// Longest a single head line may be before it is clipped; see buildMessage().
export const HEAD_LINE_CHARS = 300;

// Past this the quote is sent collapsed, with Telegram's own "show more" on it.
// Below it, collapsing costs a tap and saves nothing.
export const EXPANDABLE_QUOTE_CHARS = 300;

// answer as "said no".
export function listMatches(list, ...values) {
  const wanted = String(list ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return undefined;
  return values.some((v) => v !== undefined && wanted.includes(String(v).toLowerCase()));
}

// `marys.hu:12,wB:15` — which topic of a forum group a workspace's messages
// belong in. Falls back to TELEGRAM_TOPIC_ID, and to the group's General topic
// when neither names one.
export function topicFor(cfg, label, id) {
  for (const pair of String(cfg("TELEGRAM_TOPICS") ?? "").split(",")) {
    const at = pair.lastIndexOf(":");
    if (at === -1) continue;
    if (listMatches(pair.slice(0, at), label, id)) return toInt(pair.slice(at + 1), undefined);
  }
  return toInt(cfg("TELEGRAM_TOPIC_ID"), undefined);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Agents write Markdown; Telegram wants tags. Run this after escapeHtml — the
// markers it looks for survive escaping untouched.
export function inlineMarkdown(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}

export function stripEmphasis(text) {
  return text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

export function tilde(path) {
  const home = homedir();
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function humanDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

export function humanTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
}

// "23:00-07:00", a window that may run past midnight. Anything unparseable is
// read as no window at all: a typo should cost you a silent night, not silence
// every notification you have.
export function inQuietHours(spec, now = new Date()) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec ?? ""));
  if (!match) return false;
  const [fromH, fromM, toH, toM] = match.slice(1).map(Number);
  if (fromH > 23 || toH > 23 || fromM > 59 || toM > 59) return false;
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  if (from === to) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

// A turn that cost four tenths of a cent is the common case, and `$0.00` says
// nothing about it — so the precision follows the number down. Two decimals
// above a dime, because money written `$1.2` reads like a typo.
export function humanCost(cost) {
  if (cost >= 0.1) return `$${cost.toFixed(2)}`;
  if (cost < 0.0005) return "<$0.001";
  return `$${cost.toFixed(cost >= 0.01 ? 3 : 4).replace(/0+$/, "")}`;
}

export function clockTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function truncate(text, max) {
  const collapsed = text.replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).replace(/\s+\S*$/, "")} …`;
}

// What the person actually typed, out of a record that also carries whatever the
// harness wrapped around it.
export function promptText(raw) {
  const text = String(raw ?? "");
  // A slash command arrives as a wrapper around its name; the name is the ask.
  const command = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (command) return command[1].trim();
  return text
    .replace(/<(system-reminder|local-command-[a-z]+|command-[a-z]+)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

// The shape of the work: what it reached for, and how often. The busiest four
// carry it — a list of every tool a long turn touched is a paragraph, not a line.
export function toolSummary(tools) {
  if (!tools?.size) return undefined;
  const ranked = [...tools.entries()].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, 4).map(([name, n]) => `${n} ${name}`);
  const rest = ranked.slice(4).reduce((sum, [, n]) => sum + n, 0);
  if (rest) shown.push(`+${rest} more`);
  return shown.join(" · ");
}

// A head line is short by nature, but nothing promises it: a pane title is
// whatever the terminal last set it to. Clipping the source — before escaping,
// so no entity is ever cut in half — keeps the whole head well inside the limit,
// which leaves the budget below to be spent entirely on the body.
export function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function buildMessage(parts) {
  const { emoji, agent, statusLabel, title, prompt, project, changes, tools, meta, pane, herd, bodyIsScreen, late } = parts;

  const render = (body) => {
    const plain = [];
    const html = [];
    if (late) {
      plain.push(late);
      html.push(escapeHtml(late));
    }
    plain.push(`${emoji} ${clip(agent, 60)} · ${clip(statusLabel, 60)}`);
    html.push(`${emoji} <b>${escapeHtml(clip(agent, 60))} · ${escapeHtml(clip(statusLabel, 60))}</b>`);

    if (title) {
      const shown = clip(title, HEAD_LINE_CHARS);
      plain.push(shown);
      html.push(`<i>${escapeHtml(shown)}</i>`);
    }
    for (const line of [prompt, project, changes, tools, meta, pane, herd ? `🐑 ${herd}` : undefined].filter(Boolean)) {
      const shown = clip(line, HEAD_LINE_CHARS);
      plain.push(shown);
      html.push(escapeHtml(shown));
    }
    if (body) {
      plain.push("", bodyIsScreen ? body : stripEmphasis(body));
      html.push(
        "",
        bodyIsScreen
          ? `<pre>${escapeHtml(body)}</pre>`
          : `<blockquote${body.length > EXPANDABLE_QUOTE_CHARS ? " expandable" : ""}>${inlineMarkdown(
              escapeHtml(body)
            )}</blockquote>`
      );
    }
    return { plain: plain.join("\n"), html: html.join("\n") };
  };

  // Escaping turns one character into as many as six and the body is wrapped in
  // tags, so the body's own length says little about the message's. Shrink the
  // source and render again until it fits: cutting the finished HTML to length
  // instead would leave a half-written tag behind, and Telegram rejects the
  // whole message over it — every long message arrived stripped of its markup.
  let body = parts.body;
  let message = render(body);
  while (body && (message.html.length > TELEGRAM_LIMIT || message.plain.length > TELEGRAM_LIMIT)) {
    // Scale rather than subtract: a body of `<` renders four characters for
    // every one it holds, and taking the overshoot off the source directly
    // would cut the whole body away in a single step.
    const rendered = Math.max(message.html.length, message.plain.length);
    const room = Math.min(Math.floor((body.length * TELEGRAM_LIMIT) / rendered), body.length - 32);
    body = room > 0 ? truncate(body, room) : undefined;
    message = render(body);
  }
  return message;
}

// Worth another go: a connection that never landed (status 0), a rate limit, or
// a server-side error. A 400 is the markup, handled on its own below; 401, 403
// and 404 are the token or the chat id, and no amount of retrying fixes those.
export function isRetryable(status) {
  return status === 0 || status === 429 || status >= 500;
}

// Longest a rate limit may park a send for, whatever Telegram asks.
const MAX_RETRY_AFTER = 30 * 1000;

// Telegram says how long to wait when it rate-limits; honour it, within reason.
export function retryAfterMs(body) {
  try {
    const seconds = JSON.parse(body)?.parameters?.retry_after;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER);
  } catch {}
  return undefined;
}

// -------------------------------------------------- reading a transcript

// Herdr reports the agent session as either a transcript path (pi) or a session
// id (claude); the id is resolved against ~/.claude/projects/<escaped-cwd>/.
export function transcriptPath(session) {
  if (!session?.value) return undefined;
  if (session.kind === "path") return existsSync(session.value) ? session.value : undefined;
  if (session.kind !== "id") return undefined;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${session.value}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Transcripts run to megabytes, so only the tail is read — but the tail has to
// be long enough to reach back past the turn being reported, and an afternoon of
// tool calls is measured in hundreds of kilobytes.
export function readTail(path, bytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function blocksToText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Claude and pi spell the same numbers differently.
export function usageOf(message) {
  const u = message?.usage;
  if (!u) return undefined;
  const input = u.input_tokens ?? u.input ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cacheRead ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? u.cacheWrite ?? 0;
  return {
    out: u.output_tokens ?? u.output ?? 0,
    context: input + cacheRead + cacheWrite,
    cost: u.cost?.total ?? 0,
  };
}

// A tool result is also a `user` record; the turn starts at the last one a
// person actually typed.
export function isHumanPrompt(record, message) {
  if (record.isMeta) return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === "text") && !content.some((b) => b?.type === "tool_result");
}

// One backwards pass over the transcript tail for everything the turn can tell
// us: what the agent said last, how long the turn took and what it spent.
// Claude writes `{type:"assistant", message:{…}}`, pi writes
// `{type:"message", message:{role:"assistant", …}}`.
// maxRecords bounds the walk back to the turn's opening prompt. Set too low it
// fails silently and expensively: no prompt, no duration, and a token count that
// only covers the part of the turn it managed to see. A turn of forty tool calls
// was already past two hundred records.
export function readTurn(path, maxRecords = 1500) {
  const tail = readTail(path);
  if (!tail) return {};
  const lines = tail.split("\n").filter((l) => l.trim());

  let text;
  let prompt;
  const tools = new Map();
  let endedAt;
  let startedAt;
  let out = 0;
  let context = 0;
  let cost = 0;
  let seen = 0;

  for (let i = lines.length - 1; i >= 0 && seen < maxRecords; i--) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    seen += 1;
    if (record.isSidechain) continue; // a subagent's record, not the pane's
    const message = record.message ?? record;
    const role = message.role ?? record.type;

    if (role === "assistant") {
      if (!endedAt) endedAt = record.timestamp;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "tool_use" && block.name) {
          tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
        }
      }
      const body = blocksToText(message.content);
      if (!text && body) text = body;
      const usage = usageOf(message);
      if (usage) {
        out += usage.out;
        context = Math.max(context, usage.context);
        cost += usage.cost;
      }
      continue;
    }
    if (role === "user" && isHumanPrompt(record, message)) {
      startedAt = record.timestamp;
      prompt = promptText(blocksToText(message.content)) || undefined;
      break; // start of this turn
    }
  }

  // Ran out of records before finding where the turn began — everything measured
  // from its start is therefore partial.
  const truncated = seen >= maxRecords && !startedAt;
  const from = Date.parse(startedAt ?? "");
  const to = Date.parse(endedAt ?? "");
  return {
    text,
    prompt,
    truncated,
    tools,
    // Identifies the turn: two panes on one session read the same last record.
    endedAt,
    duration: Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : undefined,
    out,
    context,
    cost,
  };
}
