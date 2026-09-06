// Plumbing the notifier, the mute action and the doctor all share: what the
// config keys are, how a value is resolved from them, where herdr's binary is,
// and how not to print a bot token. One copy, so a fix to any of it reaches all
// three. The message itself is built in notify.mjs.

import { readFileSync, existsSync, statSync } from "node:fs";
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
