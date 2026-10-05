#!/usr/bin/env node
// Sidebar layouts belong to the client, not the server running the plugin.
// Keep this action local and preserve handwritten config rather than reformat it.
import { chmodSync, closeSync, copyFileSync, constants, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { herdrBin } from "./lib.mjs";

const layouts = {
  "ui.sidebar.agents": 'rows = [["state_icon", "machine", "workspace", "tab"], ["$telegram"], ["agent"]]',
  "ui.sidebar.spaces": 'rows = [["state_icon", "workspace"], ["$telegram"], ["branch", "git_status"]]',
};
const overrides = "ui.sidebar.agents.rows_by_agent";

export function herdrConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME ?? (env.HOME === undefined ? tmpdir() : join(env.HOME, ".config"));
  return env.HERDR_CONFIG_PATH ?? join(base, "herdr", "config.toml");
}

// Split only at top-level newlines. Brackets inside strings, comments and
// nested style/rule tables must not look like the end of a sidebar row.
function statements(text) {
  const result = [];
  let tokens = [], stack = [], i = 0;
  const finish = (end) => {
    if (tokens.length) result.push({ tokens, end });
    tokens = [];
  };
  while (i < text.length) {
    const begin = i, c = text[i];
    if (c === "\n") {
      if (!stack.length) finish(i + 1);
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === '"' || c === "'") {
      const width = text.slice(i, i + 3) === c.repeat(3) ? 3 : 1;
      i += width;
      let closed = false;
      while (i < text.length) {
        if (c === '"' && text[i] === "\\") { i += 2; continue; }
        if (text.slice(i, i + width) === c.repeat(width)) {
          i += width;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return undefined;
      const raw = text.slice(begin, i);
      let value;
      if (c === "'") value = raw.slice(width, -width);
      else if (width === 1) {
        try { value = JSON.parse(raw); } catch { return undefined; }
      } else value = raw.slice(width, -width).replace(/^\r?\n/, "");
      tokens.push({ kind: "string", value, start: begin, end: i });
    } else if ("[]{}=,.".includes(c)) {
      if (c === "[" || c === "{") stack.push(c);
      if (c === "]" || c === "}") {
        if (stack.pop() !== (c === "]" ? "[" : "{")) return undefined;
      }
      tokens.push({ kind: c, start: i, end: ++i });
    } else {
      while (i < text.length && !/[\s\[\]{}=,.#"']/.test(text[i])) i++;
      tokens.push({ kind: "bare", value: text.slice(begin, i), start: begin, end: i });
    }
  }
  if (stack.length) return undefined;
  finish(i);
  return result;
}

function keyPath(tokens) {
  if (!tokens.length || tokens.length % 2 === 0) return undefined;
  if (!tokens.every((t, i) => i % 2 ? t.kind === "." : ["bare", "string"].includes(t.kind) && /^[A-Za-z0-9_-]+$/.test(t.value))) return undefined;
  return tokens.filter((_, i) => i % 2 === 0).map((t) => t.value).join(".");
}

function sidebarRows(text) {
  const scanned = statements(text);
  if (!scanned) return undefined;
  const headers = {}, rows = [];
  let section = "";
  for (const statement of scanned) {
    const t = statement.tokens;
    if (t[0].kind === "[") {
      section = t.at(-1).kind === "]" ? keyPath(t.slice(1, -1)) : "";
      if (Object.hasOwn(layouts, section)) {
        if (headers[section]) return undefined;
        headers[section] = statement;
      }
      continue;
    }
    const equal = t.findIndex((token) => token.kind === "=");
    if (equal < 0) continue;
    const key = keyPath(t.slice(0, equal));
    if (section === overrides && !key) return undefined;
    if ((Object.hasOwn(layouts, section) && key === "rows") || (section === overrides && key)) {
      rows.push({ section, key, tokens: t.slice(equal + 1) });
    }
  }
  return { headers, rows };
}

// Validate the whole outer shape before using the first row's closing bracket.
// An empty array or mixed row types needs a human decision, not a guessed edit.
function firstRowEnd(tokens) {
  if (tokens[0]?.kind !== "[" || tokens.at(-1)?.kind !== "]") return undefined;
  let i = 1, first;
  while (i < tokens.length - 1) {
    if (tokens[i].kind !== "[") return undefined;
    let depth = 1;
    while (++i < tokens.length && depth) {
      if (tokens[i].kind === "[") depth++;
      if (tokens[i].kind === "]") depth--;
    }
    if (depth) return undefined;
    first ??= tokens[i - 1].end;
    if (i === tokens.length - 1) break;
    if (tokens[i++].kind !== ",") return undefined;
  }
  return i === tokens.length - 1 ? first : undefined;
}

export function hasSidebarToken(text = "") {
  return sidebarRows(text)?.rows.some((row) => row.tokens.some((t) => t.kind === "string" && t.value === "$telegram")) ?? false;
}

export function setupSidebar(text = "") {
  const parsed = sidebarRows(text);
  const manual = (where) => `Could not safely edit ${where}; add ["$telegram"] as a separate row after its first row by hand.`;
  if (!parsed) return { text, changed: false, notes: [manual("[ui.sidebar.agents] / [ui.sidebar.spaces] rows (including agent overrides)")] };
  if (hasSidebarToken(text)) return { text, changed: false, notes: ["$telegram is already set up in the sidebar rows."] };
  const edits = [], notes = [], seen = new Set();
  for (const row of parsed.rows) {
    const name = `[${row.section}] ${row.key}`;
    const at = firstRowEnd(row.tokens);
    if (at === undefined || seen.has(name)) notes.push(manual(name));
    else edits.push({ at, value: ', ["$telegram"]' });
    seen.add(name);
  }
  // A partial setup is harder to diagnose; leave everything alone if any
  // existing rows value is not one this deliberately small scanner understands.
  if (notes.length) return { text, changed: false, notes };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [section, defaults] of Object.entries(layouts)) {
    const header = parsed.headers[section];
    if (header && !seen.has(`[${section}] rows`)) {
      edits.push({ at: header.end, value: `${text[header.end - 1] === "\n" ? "" : eol}${defaults}${eol}` });
    }
  }
  for (const edit of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, edit.at) + edit.value + text.slice(edit.at);
  for (const [section, defaults] of Object.entries(layouts)) {
    if (!parsed.headers[section]) text += `${text && !text.endsWith("\n") ? eol : ""}${text ? eol : ""}[${section}]${eol}${defaults}${eol}`;
  }
  return { text, changed: true, notes: [] };
}

function announce(body) {
  const title = "Telegram sidebar";
  console.log(`herdr-telegram-notify: ${title} — ${body}`);
  spawnSync(herdrBin(), ["notification", "show", title, "--body", body, "--sound", "none"], { encoding: "utf8", timeout: 4000 });
}

// Open exclusively before claiming the temporary file, so cleanup cannot
// delete someone else's file if a previous run left that name behind.
function atomicWrite(path, contents, mode) {
  const temporary = `${path}.tmp-${process.pid}`;
  const fd = openSync(temporary, "wx", mode);
  try {
    try {
      writeFileSync(fd, contents);
      fchmodSync(fd, mode);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function main() {
  const path = resolve(herdrConfigPath());
  const guidance = "reload config from the Herdr menu (or your reload_config key). Over SSH, the client machine's config is what matters; run this where the Herdr window runs.";
  try {
    const existed = existsSync(path);
    const original = existed ? readFileSync(path) : Buffer.alloc(0);
    const source = original.toString("utf8");
    if (!original.equals(Buffer.from(source, "utf8"))) throw new Error("config.toml is not UTF-8; left it untouched");
    const result = setupSidebar(source);
    if (!result.changed) {
      if (!hasSidebarToken(source)) process.exitCode = 1;
      announce(`${result.notes.join("\n")} ${guidance}`);
      return;
    }
    const target = existed ? realpathSync(path) : path;
    const mode = existed ? statSync(target).mode & 0o7777 : 0o600;
    mkdirSync(dirname(path), { recursive: true });
    const backup = `${path}.bak-${Date.now()}`;
    if (existed) copyFileSync(path, backup, constants.COPYFILE_EXCL);
    else writeFileSync(backup, original, { flag: "wx", mode });
    chmodSync(backup, mode);
    if (!readFileSync(backup).equals(original)) throw new Error(`config changed while backing it up; left it untouched. Backup: ${backup}`);
    atomicWrite(target, result.text, mode);
    const checked = spawnSync(herdrBin(), ["config", "check"], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, HERDR_CONFIG_PATH: path },
    });
    if (checked.error || checked.status !== 0) {
      // Do not restore over a user's edit made while config check was running.
      if (!readFileSync(target).equals(Buffer.from(result.text))) throw new Error(`config check failed, but the file changed during validation; left that edit untouched. Backup: ${backup}`);
      if (existed) atomicWrite(target, readFileSync(backup), mode);
      else unlinkSync(target);
      process.exitCode = 1;
      announce(`Herdr config check failed; restored the previous config from ${backup}. ${guidance}`);
    } else announce(`Added a separate $telegram row in ${path}. Backup: ${backup}. ${guidance}`);
  } catch (err) {
    process.exitCode = 1;
    announce(`Could not set up sidebar: ${err.message}. ${guidance}`);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
