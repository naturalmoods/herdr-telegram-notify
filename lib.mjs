// Plumbing the notifier, the mute action and the doctor all share: what the
// config keys are, how a value is resolved from them, where herdr's binary is,
// and how not to print a bot token. One copy, so a fix to any of it reaches all
// three. The message itself is built in notify.mjs.

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  unlinkSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";


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
  SWEEP_MINUTES: "0",
  QUIET_HOURS: "",
  TELEGRAM_TOPIC_ID: "",
  TELEGRAM_TOPICS: "",
  NOTIFY_WORKSPACES: "",
  IGNORE_WORKSPACES: "",
  REPLIES: "0",
  REPLY_ALLOWED_USER_IDS: "",
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

// The statuses herdr reports, and so the only ones NOTIFY_STATUSES can name.
export const STATUSES = ["done", "blocked", "working", "idle"];

// A value the runtime cannot parse falls back to the default, silently — the
// failure mode of `SWEEP_MINUTES=5min` is a sweeper that never runs and a config
// file that looks right. Every rule here is the runtime's own parser (toInt,
// parseQuietHours, the status split), so the two cannot disagree: this only
// names what the runtime would ignore. Keys, never values, of anything secret.
export function configProblems(cfg) {
  const problems = [];
  const say = (key, detail) => problems.push({ key, detail });

  // Empty means "the default", which is always valid; 0 is off for the three
  // switches that measure a duration and is not allowed for the sizes.
  for (const [key, min] of [
    ["PROMPT_CHARS", 1],
    ["LAST_MESSAGE_CHARS", 1],
    ["SCREEN_LINES", 1],
    ["MUTE_MINUTES", 1],
    ["TELEGRAM_TOPIC_ID", 1],
    ["MIN_DURATION_SECONDS", 0],
    ["BLOCKED_REMINDER_MINUTES", 0],
    ["SWEEP_MINUTES", 0],
  ]) {
    const raw = String(cfg(key) ?? "").trim();
    if (!raw) continue;
    if (toInt(raw, undefined) === undefined && !(min === 0 && raw === "0")) {
      say(key, `${raw} is not a whole number of ${min} or more — the value is ignored and the default used instead`);
    }
  }

  const statuses = String(cfg("NOTIFY_STATUSES") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // An unset key falls back to the default, so only a value that parses to
  // nothing gets here — and it would drop every message.
  // The list is used as written, typo and all — there is no falling back to the
  // default here, which is what makes a misspelt status quieter than a missing
  // key: everything else in the list goes on sending.
  if (!statuses.length) say("NOTIFY_STATUSES", "names no status, so nothing would ever send");
  const unknown = statuses.filter((s) => !STATUSES.includes(s));
  if (unknown.length) {
    const rest = statuses.filter((s) => STATUSES.includes(s));
    say(
      "NOTIFY_STATUSES",
      `${unknown.join(", ")} — not a status (${STATUSES.join(", ")}); it matches nothing, so only ${rest.join(", ") || "nothing"} sends`
    );
  }

  const quiet = String(cfg("QUIET_HOURS") ?? "").trim();
  if (quiet && !parseQuietHours(quiet)) {
    say("QUIET_HOURS", `${quiet} — not HH:MM-HH:MM, or an empty window; no hours are kept quiet`);
  }

  for (const pair of String(cfg("TELEGRAM_TOPICS") ?? "").split(",")) {
    const text = pair.trim();
    if (!text) continue;
    const at = text.lastIndexOf(":");
    if (at < 1 || !toInt(text.slice(at + 1), undefined)) {
      say("TELEGRAM_TOPICS", `${text} — not a workspace:topic pair with a positive topic id; the pair routes nothing`);
    }
  }

  for (const id of String(cfg("REPLY_ALLOWED_USER_IDS") ?? "").split(",")) {
    const text = id.trim();
    if (text && !toInt(text, undefined)) {
      // The list stays in force with the rest of its ids: a typo here narrows
      // who may reply, it does not turn the allowlist off.
      say("REPLY_ALLOWED_USER_IDS", `${text} — not a Telegram user id; it matches no one, and the other ids still apply`);
    }
  }

  return problems;
}

// Undefined when the list is empty — "nothing said", which is not the same

export function isOn(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

// Whole number or nothing: `12min` is a typo, and taking the 12 out of it would
// hide the typo behind a value that happens to work. The doctor reports exactly
// what this rejects, which is why it is one function and not two.
export function toInt(value, fallback) {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : fallback;
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

// Every workspace, pane and agent herdr knows about. The notifier reads one per
// run and the poller one per /status, so it lives here rather than in either.
export function loadSnapshot() {
  const out = herdr(["api", "snapshot"]);
  if (!out) return undefined;
  try {
    return JSON.parse(out).result?.snapshot;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------ formatting the message

const STATUS_EMOJI = { done: "✅", blocked: "⚠️", working: "⏳", idle: "💤" };

export function statusEmoji(status) {
  return STATUS_EMOJI[status] ?? "🔔";
}

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

// `storefront:12,wB:15` — which topic of a forum group a workspace's messages
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
export function parseQuietHours(spec) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec ?? ""));
  if (!match) return undefined;
  const [fromH, fromM, toH, toM] = match.slice(1).map(Number);
  if (fromH > 23 || toH > 23 || fromM > 59 || toM > 59) return undefined;
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  return from === to ? undefined : { from, to };
}

export function inQuietHours(spec, now = new Date()) {
  const window = parseQuietHours(spec);
  if (!window) return false;
  const { from, to } = window;
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

// ------------------------------------------------------ reading a screen

// A panel's left edge is what gives a split screen away: every one of its lines
// begins in the same column, with a margin in front of it. Prose starts its words
// wherever they fall, so nothing in a single column comes close to these.
const MIN_ROWS_FOR_COLUMNS = 6;
const MIN_BOUNDARY_COLUMN = 24; // below this it is indentation, not a panel
const BOUNDARY_EDGE_SHARE = 0.4; // rows beginning a run in exactly this column
const BOUNDARY_MARGIN_BLANK = 0.8; // with the column before it blank

// Both sides then have to be lived in: one deep indent among ordinary lines can
// look like an edge, and its near-empty other half gives it away.
const MIN_BLOCK_OCCUPANCY = 0.25;

// What a question looks like when an agent is waiting on one.
const PROMPT_MARKER = /(^|\s)❯|^\s*\d+\.\s+(yes|no)\b|\bdo you want\b|\bwould you like\b|\(y\/n\)/i;

// The character ranges a screen's rows divide into, or nothing at all when it is
// the ordinary single column. Looking for a blank gutter does not work: a panel
// wraps its text to its own full width, so the space between the two is often a
// single column and sometimes none.
export function screenColumns(rows) {
  const filled = rows.filter((row) => row.trim());
  if (filled.length < MIN_ROWS_FOR_COLUMNS) return [];
  const width = Math.max(...filled.map((row) => row.length));

  const boundaries = [];
  for (let col = MIN_BOUNDARY_COLUMN; col < width; col += 1) {
    let starts = 0;
    let margin = 0;
    for (const row of filled) {
      const here = col < row.length ? row[col] : " ";
      const before = col - 1 < row.length ? row[col - 1] : " ";
      if (before === " ") {
        margin += 1;
        if (here !== " ") starts += 1;
      }
    }
    if (starts / filled.length >= BOUNDARY_EDGE_SHARE && margin / filled.length >= BOUNDARY_MARGIN_BLANK) {
      boundaries.push(col);
    }
  }
  if (!boundaries.length) return [];

  const cuts = [0, ...boundaries, width];
  const blocks = cuts.slice(0, -1).map((from, i) => [from, cuts[i + 1]]);
  const lived = blocks.filter(
    ([from, to]) =>
      filled.filter((row) => row.slice(from, to).trim()).length / filled.length >= MIN_BLOCK_OCCUPANCY
  );
  return lived.length >= 2 ? lived : [];
}

// A pane can be showing two things at once — an agent's transcript with a diff
// panel beside it — and then every row of the screen holds a piece of each. Read
// as lines they interleave into a paragraph that reads as neither, so one column
// is kept and the rest of each row dropped. The question the agent is waiting on
// decides which; failing that the widest, on the grounds that the main view is
// what the pane gave the room to.
export function cropScreen(rows) {
  const blocks = screenColumns(rows);
  if (blocks.length < 2) return rows;

  const sliced = ([from, to]) => rows.map((row) => row.slice(from, to));
  const asking = blocks.find((block) => sliced(block).some((line) => PROMPT_MARKER.test(line)));
  const chosen = asking ?? blocks.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  return sliced(chosen);
}

// A blocked agent's question lives on screen, not in the transcript.
export function screenTail(paneId, maxLines) {
  // More rows than will be shown: finding the column boundary is a question
  // about the shape of the whole screen, and a handful of rows cannot answer it.
  const rows = Math.max(maxLines * 2, 24);
  const out = herdr(["pane", "read", paneId, "--lines", String(rows), "--format", "text"]);
  if (!out) return undefined;

  // Escapes and box drawing go first and column positions are kept: a vertical
  // rule between two columns has to read as blank space before the gutter it
  // sits in can be seen at all.
  const screen = out
    .split("\n")
    .map((line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[─-╿▀-▟]/g, " ").replace(/\s+$/, ""));

  const lines = cropScreen(screen)
    // Only now: with one column in hand, the runs of spaces left in a row are
    // its own alignment rather than the wall between it and the next column.
    .map((line) => line.replace(/\s+/g, " ").trim())
    // Drop separators and the agent's own chrome: the empty input prompt and
    // the shortcut hint line under it carry nothing worth a notification.
    .filter((line) => line && !/^[·•\-–—_=.]+$/.test(line) && !/^[❯>]$/.test(line) && !/^⏵/.test(line));
  const tail = lines.slice(-maxLines).join("\n");
  return tail || undefined;
}

// ---------------------------------------------------------------- locking

// Several copies of this plugin run at once by design: one hook process per
// status change, plus the sweeper and the reply poller, all writing one state
// directory. Exclusion between them is the kernel's, through flock(2): a lock
// held by a process that dies — crash, kill -9, the machine going down — is
// released by the kernel when the file descriptor closes. There is no stale
// lock to detect, no pid to believe, and no reclaim protocol to get subtly
// wrong. That is the whole reason for it.
//
// Node has no flock binding, so the lock is held by a small shell child:
//
//   sh -c 'exec 9>"$1"; "$2" -w N 9 || { echo no > "$0"; exit 3; }
//          echo $$ > "$0"; read ignored'  <ready> <lockfile> <flock>
//
// It reports through the ready file whether it got the lock, then blocks
// reading a pipe this process holds open. Releasing closes that pipe; if this
// process dies without releasing, the pipe closes anyway and the kernel drops
// the lock with it. One extra process per lock, which is the price of a lock
// that cannot outlive its owner.
//
// This needs flock(1) from util-linux, so it needs Linux — `doctor` checks for
// it and says what stops working without it. Without it nothing here touches
// shared state at all: the queue, the message map and the background processes
// stop, the notification itself does not.

const FLOCK_CANDIDATES = ["/usr/bin/flock", "/bin/flock", "/usr/local/bin/flock"];

// How long a short critical section may wait for another process's, and how
// much longer than that to wait for the child to say which way it went.
const LOCK_WAIT_SECONDS = 10;
const LOCK_START_GRACE_MS = 5000;
const RELEASE_WAIT_MS = 1000;

// FLOCK_BIN_PATH names it outright, the way HERDR_BIN_PATH does. Pointed
// somewhere that is not there, the answer is "no flock" rather than one of the
// usual paths: an override that silently falls back to something else is how
// you end up testing the wrong binary.
export function flockBin() {
  const named = process.env.FLOCK_BIN_PATH;
  if (named) return existsSync(named) ? named : undefined;
  for (const candidate of FLOCK_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function flockAvailable() {
  return Boolean(flockBin());
}

// Everything here is synchronous — the callers are file readers and writers —
// so waiting cannot be done with a timer.
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Take the lock, or return undefined. `waitSeconds` 0 asks the kernel for it
// without waiting, which is what the "is anyone already doing this?" callers
// want; anything higher waits that long for the holder to finish.
export function holdFlock(path, { waitSeconds = 0 } = {}) {
  const bin = flockBin();
  if (!bin) return undefined;
  const ready = `${path}.${process.pid}.${randomUUID()}.ready`;
  let child;
  try {
    mkdirSync(dirname(path), { recursive: true });
    child = spawn(
      "sh",
      [
        "-c",
        'exec 9>"$1" || { echo no > "$0"; exit 3; }; ' +
          `"$2" ${waitSeconds > 0 ? `-w ${waitSeconds}` : "-n"} 9 || { echo no > "$0"; exit 3; }; ` +
          'echo "$$" > "$0"; read ignored',
        ready,
        path,
        bin,
      ],
      { stdio: ["pipe", "ignore", "ignore"] }
    );
    // Neither the child nor the pipe may keep this process alive: the pipe
    // closing is exactly how the lock is released when we go.
    child.unref();
    child.stdin.unref?.();
  } catch {
    return undefined;
  }

  // The child writes its pid on success and `no` on failure, either way within
  // waitSeconds. Past that something is wrong with the child rather than with
  // the lock, and giving up is the same answer as being refused.
  const deadline = Date.now() + waitSeconds * 1000 + LOCK_START_GRACE_MS;
  for (;;) {
    let marker;
    try {
      marker = readFileSync(ready, "utf8").trim();
    } catch {}
    if (marker) {
      try {
        unlinkSync(ready);
      } catch {}
      if (marker === "no") {
        try {
          child.kill("SIGKILL");
        } catch {}
        return undefined;
      }
      const release = () => {
        try {
          child.stdin.end();
        } catch {}
        try {
          child.kill("SIGKILL");
        } catch {}
        // The kernel frees the lock when the child actually dies, which is a
        // moment after the signal rather than at it. Without waiting for that,
        // release() is a lie: the caller looks again, or asks for the lock
        // again without waiting, and finds its own lock still held. Bounded,
        // because a waiter taking it the instant it comes free looks the same
        // from here and is just as good an answer.
        const until = Date.now() + RELEASE_WAIT_MS;
        while (Date.now() < until && flockHeld(path)) sleepSync(2);
      };
      release.pid = Number.parseInt(marker, 10);
      return release;
    }
    if (Date.now() > deadline) {
      try {
        child.kill("SIGKILL");
      } catch {}
      try {
        unlinkSync(ready);
      } catch {}
      console.error(`herdr-telegram-notify: gave up waiting for the lock on ${path}`);
      return undefined;
    }
    sleepSync(2);
  }
}

// Is someone holding it right now? Asked by `doctor`, and by the hook waiting
// for a background process it just started to take its own lock.
export function flockHeld(path) {
  const bin = flockBin();
  if (!bin || !existsSync(path)) return false;
  const res = spawnSync(bin, ["-n", path, "true"], { timeout: 4000 });
  // Only flock's own refusal is evidence of a holder. A probe that could not
  // run at all — spawn refused, killed, past the timeout on a loaded machine —
  // exits with no status, and reading that as "someone holds it" is the
  // expensive direction to be wrong in: the hook at ensureDaemon() takes it as
  // "the daemon is already running" and never starts one.
  if (res.error || res.status === null) return false;
  return res.status !== 0;
}

// Thrown rather than swallowed: a caller that cannot get the lock must not
// carry on and write anyway, and it is the caller that knows what to do with
// the news.
export class LockUnavailable extends Error {
  constructor(path) {
    super(
      flockAvailable()
        ? `could not lock ${path}`
        : `no flock(1) found, so ${path} cannot be locked — this plugin needs util-linux's flock`
    );
    this.path = path;
  }
}

// Short critical sections: read a file, change it, write it back. Held for
// microseconds, so waiting for one is waiting for another process's few
// syscalls.
export function withFileLock(path, fn, { waitSeconds = LOCK_WAIT_SECONDS } = {}) {
  const release = holdFlock(path, { waitSeconds });
  if (!release) throw new LockUnavailable(path);
  try {
    return fn();
  } finally {
    release();
  }
}

export function readLines(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

export function writeLines(path, entries) {
  mkdirSync(dirname(path), { recursive: true });
  if (!entries.length) {
    try {
      unlinkSync(path);
    } catch {}
    return;
  }
  // These lines hold what an agent said and what was on its screen, so they are
  // this user's to read. The mode is set on creation, and a file an older
  // version left behind is narrowed first — before the content goes in, not
  // after, and if that cannot be done it is not written at all.
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
}

// ------------------------------------------------------- recorded status

// One file per pane, written by the notifier on every status change. The poller
// reads them too, so the naming lives here rather than in either.
export function sanitizeKey(raw) {
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function readState(stateDir, key) {
  if (!stateDir) return {};
  try {
    return JSON.parse(readFileSync(join(stateDir, `state-${key}.json`), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(stateDir, key, state) {
  if (!stateDir) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `state-${key}.json`), JSON.stringify(state));
  } catch {}
}

// Which blocked stretch a pane is in: the moment it entered `blocked`, which is
// a new one every time it leaves and comes back. The screen cannot tell two of
// those apart — an agent that asks the same question twice draws the same
// pixels — so this is what keeps a notification answerable only inside the
// stretch it was sent from.
export function blockedEpisode(stateDir, paneId) {
  if (!paneId) return undefined;
  const state = readState(stateDir, sanitizeKey(paneId));
  return state?.status === "blocked" && state.updatedAt ? state.updatedAt : undefined;
}

// ------------------------------------------------------------------ mute

// One file in the state dir holding the moment the silence ends. The plugin's
// mute action writes it, the bot's /mute command writes it, the notifier and the
// doctor read it — so it lives here rather than in whichever wrote it first.
// Muted messages are dropped rather than queued: you asked not to be told, not
// to be told all at once in an hour.
export const MUTE_DEFAULT_MINUTES = 60;

// Longest a mute may run. A week is already "I am on holiday"; past that it is a
// typo, and a mute nobody remembers setting is worse than a missed message.
export const MUTE_MAX_MINUTES = 7 * 24 * 60;

export function mutedUntil(stateDir) {
  if (!stateDir) return 0;
  try {
    const until = JSON.parse(readFileSync(join(stateDir, "mute.json"), "utf8"))?.until;
    return Number.isFinite(until) && until > Date.now() ? until : 0;
  } catch {
    return 0;
  }
}

// Set, not toggled: the caller says what it wants and gets it, so repeating a
// command is not a coin flip. A falsy `until` clears the mute. Throws rather
// than swallowing, because a mute you believe in but that was never written is
// the bad way for this to fail.
export function setMute(stateDir, until) {
  const path = join(stateDir, "mute.json");
  if (!until) return rmSync(path, { force: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ until }));
}

// How long `/mute [minutes]` asks for: the argument when there is one, the
// configured default when there is not. A whole positive number of minutes
// inside the ceiling, or nothing — `/mute 30min`, `/mute -5` and `/mute 1e9` are
// typos, and taking a working number out of one would hide it behind a silence
// nobody chose. Anything past the first argument is a sentence, not a command.
export function muteMinutes(args, configured) {
  if (args.length > 1) return undefined;
  const minutes = args.length ? toInt(args[0], undefined) : toInt(configured, MUTE_DEFAULT_MINUTES);
  return minutes && minutes <= MUTE_MAX_MINUTES ? minutes : undefined;
}

// ------------------------------------------------------ replies from the chat

// How many notifications stay answerable, and for how long. A reply to something
// older than this has no pane left worth guessing at.
const MESSAGE_MAP_MAX = 300;
const MESSAGE_MAP_TTL = 24 * 60 * 60 * 1000;

function messageMapPath(stateDir) {
  return stateDir ? join(stateDir, "messages.jsonl") : undefined;
}

// The agent session a notification was about, as one comparable string. Herdr
// reports it as a transcript path or a session id, and the two never mean the
// same thing, so the kind is part of the key.
export function sessionKey(session) {
  return session?.value ? `${session.kind ?? "?"}:${session.value}` : undefined;
}

// The question a blocked agent is waiting on, as one comparable string: which
// blocked stretch it is in, and what is on its screen, hashed. The notifier
// records it with the notification, the poller checks it is still the question
// being asked before typing an answer into it. Both halves are needed and
// neither implies the other — a pane can walk on to a different question inside
// one stretch, and it can come back to an identical question in a later one.
// A fixed number of lines rather than SCREEN_LINES: the two ends have to crop
// the same screen the same way, and the config can be edited in between.
//
// Nothing here is recorded without the episode, so a pane whose transitions
// were never recorded is unanswerable rather than answerable by screen alone.
//
// ponytail: the whole screen tail is the question's identity, so a pane that
// redraws anything in those lines refuses the reply it was waiting for. Refusing
// is the safe half of the trade; narrow it to the prompt block if it fires in
// practice.
const QUESTION_LINES = 12;

// Recorded in place of the key when a blocked notification's question cannot be
// fingerprinted — an unrecorded transition, or a screen that does not read. It
// matches no question, which is the point: without it the notification is
// indistinguishable from one about a finished turn, and a reply to it would be
// delivered as a new turn once the agent walked on.
export const QUESTION_UNKNOWN = "blocked:unknown";

export function questionOnScreen(stateDir, paneId) {
  const episode = blockedEpisode(stateDir, paneId);
  const screen = episode ? screenTail(paneId, QUESTION_LINES) : undefined;
  return screen ? `${episode}:${createHash("sha256").update(screen).digest("hex").slice(0, 16)}` : undefined;
}

// Which pane each sent notification was about — which agent session was in it,
// since the pane alone is a moving target, and which question it was waiting on
// when it was one, since a session outlives the question too. Written by the
// notifier, read by the poller.
export function rememberMessage(stateDir, messageId, paneId, session, question, full) {
  const path = messageMapPath(stateDir);
  if (!path || !messageId || !paneId) return;
  const entry = {
    id: messageId,
    paneId,
    session: sessionKey(session),
    question,
    full: full ? String(full) : undefined,
    at: Date.now(),
  };
  // Read, add, write: a hook sending live and a sweeper draining a queue can
  // land here at the same moment, and whoever wrote second would drop the
  // other's message from the map — a notification in the chat that nobody can
  // answer. Under the lock that cannot happen; without one this is not done at
  // all, because a half-written map is worse than a missing entry.
  try {
    withFileLock(join(stateDir, "messages.lock"), () => {
      writeLines(path, [...readMessageMap(stateDir), entry].slice(-MESSAGE_MAP_MAX));
    });
  } catch (err) {
    console.error(
      `herdr-telegram-notify: message ${messageId} was sent but not recorded, so a reply to it cannot be routed: ${err.message}`
    );
  }
}

export function readMessageMap(stateDir) {
  const path = messageMapPath(stateDir);
  if (!path) return [];
  const cutoff = Date.now() - MESSAGE_MAP_TTL;
  return readLines(path).filter((entry) => entry?.id && entry.paneId && entry.at > cutoff);
}

// The pane a reply belongs to, with the session that was in it when the
// notification went out — the caller checks the second against what is running
// there now.
export function targetForMessage(stateDir, messageId) {
  return readMessageMap(stateDir).findLast((entry) => entry.id === messageId);
}

// Which updates are this plugin's to act on. The chat id is the first security
// boundary here: a bot's username is public, anyone can write to it, and what
// arrives goes to an agent's terminal. Only a reply counts, so text can only
// ever reach the pane whose notification it answers — never one of its choosing.
//
// In a group everyone in it is behind that boundary, so an optional allowlist of
// Telegram user ids narrows it to named people. With one set, a sender that
// cannot be named is refused: an anonymous admin or a channel post arrives as
// sender_chat, with either no `from` at all or Telegram's shared
// GroupAnonymousBot id, so there is no one to check against the list.
export function usableReply(update, chatId, allowedUserIds) {
  const message = update?.message;
  if (!message || String(message.chat?.id ?? "") !== String(chatId)) return undefined;
  const allowed = listMatches(allowedUserIds, message.from?.id);
  if (allowed === false || (allowed !== undefined && message.sender_chat)) return undefined;
  const text = String(message.text ?? "").trim();
  if (!text) return undefined;
  // The topic is carried so the answer goes back to the thread the command was
  // written in; in a group without topics there is none and Telegram wants none.
  return {
    text,
    messageId: message.message_id,
    replyTo: message.reply_to_message?.message_id,
    threadId: message.message_thread_id,
  };
}

// How the reply reaches the pane. A blocked agent is sitting at a prompt that
// wants a keystroke — `herdr agent prompt` refuses it outright with
// agent_blocked — so the text is typed in and entered. Anything else takes it as
// a new turn.
export function replyCommands(paneId, status, text) {
  if (status === "blocked") {
    return [
      ["pane", "send-text", paneId, text],
      ["pane", "send-keys", paneId, "Enter"],
    ];
  }
  return [["agent", "prompt", paneId, text]];
}

// The commands the bot takes: the only messages that do anything without being
// a reply, and the only text that is ever read as an instruction rather than
// handed to an agent. A fixed list, so a message that merely begins with a slash
// runs nothing — what is not on it falls through to the reply path as text.
// Telegram addresses a command to a named bot when several share a chat, and
// then only that bot should answer; an unaddressed one is for whoever is
// listening.
const COMMANDS = ["/status", "/mute", "/unmute", "/full"];

export function botCommand(text, botUsername) {
  const [first = "", ...args] = String(text ?? "").trim().split(/\s+/);
  const [command, addressed, ...extra] = first.toLowerCase().split("@");
  if (!COMMANDS.includes(command)) return undefined;
  // `mine` says whether to answer it, not whether it is one: a command with a
  // suffix — another bot's name, this bot's misspelt, or no name at all — is
  // addressed at a bot either way, and handing it to an agent as text is the one
  // thing it must not do.
  const mine = addressed === undefined || (!extra.length && Boolean(botUsername) && addressed === String(botUsername).toLowerCase());
  return { command, args, mine };
}

// Most agents one answer names — past this it stops being something you read on
// a phone, and the count says what was left out.
const STATUS_AGENTS_MAX = 20;
const STATUS_ORDER = ["blocked", "working", "done", "idle"];

// The herd on demand: what each agent is, where it is, what it is doing and the
// pane to reach it in. Blocked first, because the reason to ask is usually
// whether anyone is waiting on you.
export function herdStatusText(snap) {
  if (!snap) return "I cannot reach herdr right now.";
  const agents = (snap.agents ?? []).filter((a) => a.pane_id);
  if (!agents.length) return "No agents are running.";

  const labelOf = (a) =>
    (snap.workspaces ?? []).find((w) => w.workspace_id === a.workspace_id)?.label ?? a.workspace_id ?? "?";
  const rank = (a) => {
    const i = STATUS_ORDER.indexOf(a.agent_status);
    return i === -1 ? STATUS_ORDER.length : i;
  };

  const lines = [...agents]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, STATUS_AGENTS_MAX)
    .map((a) => {
      const status = String(firstDefined(a.agent_status, "unknown"));
      const name = clip(String(firstDefined(a.display_agent, a.agent, "agent")), 24);
      return `${statusEmoji(status)} ${name} · ${clip(String(labelOf(a)), 32)} · ${status} · ${a.pane_id}`;
    });
  const more = agents.length - lines.length;
  if (more > 0) lines.push(`… and ${more} more`);
  return lines.join("\n");
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
        // Claude writes `tool_use`, pi writes `toolCall`; the name is in the same
        // place either way. Counting only Claude's spelling left every pi turn
        // reporting no tools at all rather than reporting none.
        if ((block?.type === "tool_use" || block?.type === "toolCall") && block.name) {
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
