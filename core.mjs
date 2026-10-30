// herdr-core (`hc`): the terminal runtime the Herdr app is built on. Herdr TUI
// runs this plugin from its own hooks and hands it a snapshot in its own shape;
// herdr-core has neither, so daemon.mjs follows `hc events` and runs the same
// hooks, and this file turns what hc says into what the rest of the plugin
// already reads. Deciding stays apart from IO: toSnapshot() and transitions()
// take plain records and are tested without a core.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// Set by daemon.mjs for itself and every process it starts.
export const isCore = () => process.env.HERDR_BACKEND === "core";

export function hcBin() {
  const candidates = [
    process.env.HC_BIN_PATH,
    join(homedir(), ".local", "bin", "hc"),
    "/usr/local/bin/hc",
    "/usr/bin/hc",
    "/opt/homebrew/bin/hc",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "hc";
}

// Inside an hc terminal, HC_TERMINAL_ID makes hc treat the caller as a parent:
// an agent started from /new would then end when this process does. Nothing
// here is anyone's child.
function hcEnv() {
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID;
  return env;
}

// One CLI call. hc puts a structured error on stderr and exits non-zero; its
// message reads as an answer ("no terminal t9"), the JSON it arrives in does not.
export function hcRun(args, timeout = 10_000) {
  let res;
  try {
    res = spawnSync(hcBin(), args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, env: hcEnv() });
  } catch (err) {
    return { ok: false, why: err.message };
  }
  if (res.error) return { ok: false, why: res.error.message };
  if (res.status !== 0) {
    const raw = (res.stderr || res.stdout || `exit ${res.status}`).trim();
    let error;
    try {
      error = JSON.parse(raw)?.error;
    } catch {}
    return { ok: false, why: error?.message ?? raw.slice(0, 200), kind: error?.kind };
  }
  return { ok: true, out: res.stdout };
}

export function hcJson(args, timeout) {
  const res = hcRun([...args, "--json"], timeout);
  if (!res.ok) return undefined;
  try {
    return JSON.parse(res.out);
  } catch {
    return undefined;
  }
}

// One JSON-RPC call over `hc connect`, for the methods hc has no CLI verb for
// (doc.get). The connection stays open until the answer is in: it is the same
// socket the CLI uses, and closing our side first could lose the reply.
export function rpc(method, params = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(hcBin(), ["connect"], { env: hcEnv(), stdio: ["pipe", "pipe", "ignore"] });
    let buffered = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${method}: no answer from hc in ${timeout} ms`)), timeout);
    child.on("error", (err) => finish(err));
    child.on("exit", () => finish(new Error(`${method}: hc connect ended without an answer`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 1) continue;
        if (msg.error) finish(new Error(`${method}: ${msg.error.message ?? "failed"}`));
        else finish(undefined, msg.result);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
  });
}

// ------------------------------------------------------------ spaces and tabs

// Two things the CLI cannot give a hook: the whole terminal records (`hc ls`
// prints a summary without labels or status details) and the app's document of
// spaces and tabs (API only). The daemon follows both and leaves copies here,
// written before any hook that could read them is started; the hooks and the
// poller only ever read.
export const TERMINALS_FILE = "core-terminals.json";
export const SPACES_FILE = "core-spaces.json";

function readJson(stateDir, name) {
  if (!stateDir) return undefined;
  try {
    return JSON.parse(readFileSync(join(stateDir, name), "utf8")) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeJson(stateDir, name, value) {
  const path = join(stateDir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export const readSpaces = (stateDir = process.env.HERDR_PLUGIN_STATE_DIR) => readJson(stateDir, SPACES_FILE) ?? {};
export const writeSpaces = (stateDir, doc) => writeJson(stateDir, SPACES_FILE, doc ?? {});
export const readTerminals = (stateDir = process.env.HERDR_PLUGIN_STATE_DIR) => readJson(stateDir, TERMINALS_FILE)?.terminals;
export const writeTerminals = (stateDir, terminals) => writeJson(stateDir, TERMINALS_FILE, { terminals: [...terminals] });

// What the app calls a space nobody named: the repo its first terminal is in,
// else that folder.
function repoName(cwd) {
  let dir = cwd;
  while (dir && dir !== dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return basename(dir);
    dir = dirname(dir);
  }
  return cwd ? basename(cwd) || cwd : undefined;
}

// ---------------------------------------------------------------- machines

// A remote terminal's address carries its machine: `box/t7`.
export function machineOf(address) {
  const text = String(address ?? "");
  const at = text.indexOf("/");
  return at === -1 ? undefined : text.slice(0, at);
}

// CORE_MACHINES: which added machines this daemon also speaks for. Empty is
// this machine only, `*` is every added machine, otherwise the names `hc
// machine ls` prints. A machine that runs its own daemon on this bot stays out,
// or every message comes twice.
export function coreMachines(spec = "") {
  const items = String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { all: items.includes("*"), names: new Set(items.filter((s) => s !== "*")) };
}

export function machineAllowed(machine, machines) {
  return Boolean(machines?.all || machines?.names?.has(machine));
}

export function machineIncluded(address, machines) {
  const machine = machineOf(address);
  return !machine || machineAllowed(machine, machines);
}

// ------------------------------------------------------------------- agents

// Agents are terminals whose program reports a status. Helpers an agent
// started (`parent`) are its business, not the phone's, and another machine's
// terminals belong to the notifier running there unless CORE_MACHINES says
// this daemon speaks for that machine too.
export function isAgent(t, machines) {
  return Boolean(t && t.state === "live" && t.status?.state && !t.parent && machineIncluded(t.address, machines));
}

const cwdOf = (t) => t.foreground?.cwd || t.cwd;
const appOf = (t) => t.status?.app || t.foreground?.name || basename(String(t.argv?.[0] ?? "")) || "agent";

// The Claude Code session contrib/claude-session-hook.sh announced, if it is
// this process's: the label carries the foreground pid it was set for, so one
// left behind by a previous program in the pane cannot claim the next one.
function labelledSession(t, pid) {
  const [labelPid, id] = String(t.labels?.["claude.session"] ?? "").split(":");
  if (!id || Number(labelPid) !== Number(pid)) return undefined;
  return /^[A-Za-z0-9-]+$/.test(id) ? id : undefined;
}

// Which agent session is in the terminal now. Claude Code labels its terminal
// with its own session id (see contrib/claude-session-hook.sh), so the session is
// the real one: a /clear brings a new id, and it is not guessed from the folder.
// hc reports no session id for anything else, so the program is the session: the
// foreground process, in this terminal. A pane that outlives its agent (quit,
// started again) gets a new pid and so a new session, which is what keeps a reply
// out of a conversation it was not about.
export function coreSession(t, terminals = []) {
  const pid = t.foreground?.pid ?? t.pid;
  if (!pid) return undefined;
  const app = appOf(t);
  const cwd = cwdOf(t);
  const machine = machineOf(t.address);
  const id = app.toLowerCase().includes("claude") ? labelledSession(t, pid) : undefined;
  // A real id names one conversation, so another agent in the folder cannot be
  // behind the transcript it finds; the shared check is only about guessing.
  if (id) return { kind: "id", value: id, agent: app, cwd, since: t.created_ms, ...(machine ? { machine } : {}) };
  // Two agents of one kind in one folder write to one transcript folder, and
  // the newest file there could be either's; no transcript beats the wrong one.
  const shared = terminals.some((o) => o.address !== t.address && isAgent(o) && appOf(o) === app && cwdOf(o) === cwd);
  return { kind: "proc", value: `${t.address}:${pid}`, agent: app, cwd, since: t.created_ms, shared, ...(machine ? { machine } : {}) };
}

// The TUI's snapshot shape, which notify.mjs, replies.mjs and the board read.
// A remote terminal's space and tab ids are local to its machine, so they
// carry the same `machine/` prefix as its address.
export function toSnapshot(terminals = [], doc = {}, machines) {
  const live = terminals.filter((t) => t.state === "live");
  const panes = live
    .filter((t) => !t.parent && machineIncluded(t.address, machines))
    .map((t) => {
      const machine = machineOf(t.address);
      const prefix = machine ? `${machine}/` : "";
      return {
        pane_id: t.address,
        name: t.name ?? undefined,
        workspace_id: t.labels?.["herdr.space"] ? `${prefix}${t.labels["herdr.space"]}` : undefined,
        tab_id: t.labels?.["herdr.tab"] ? `${prefix}${t.labels["herdr.tab"]}` : undefined,
        cwd: cwdOf(t),
        terminal_title_stripped: t.status?.title || t.title || undefined,
        ...(t.status?.state
          ? {
              agent: appOf(t),
              display_agent: appOf(t),
              agent_status: t.status.state,
              agent_kind: t.status.kind ?? undefined,
              agent_session: coreSession(t, live),
            }
          : {}),
      };
    });
  const agents = panes.filter((p) => p.agent_status);

  // This machine's document, then each included machine's, all with the ids the
  // app shows. A copy from before this setting has no `machines` at all.
  const machineDocs = doc.machines && typeof doc.machines === "object" ? doc.machines : {};
  const names = machines?.all ? Object.keys(machineDocs).sort() : [...(machines?.names ?? [])];
  const docs = [{ prefix: "", doc }, ...names.map((name) => ({ prefix: `${name}/`, doc: machineDocs[name] ?? {} }))];

  const firstCwd = (spaceId) => panes.find((p) => p.workspace_id === spaceId)?.cwd;
  const workspaces = docs.flatMap(({ prefix, doc: d }) =>
    (Array.isArray(d.spaces) ? d.spaces : []).map((s) => {
      const id = `${prefix}${s.id}`;
      return {
        workspace_id: id,
        label: s.name || repoName(firstCwd(id) || s.folder) || id,
        folder: s.folder || firstCwd(id),
      };
    })
  );
  // A labelled terminal whose space the copy of the document does not know yet.
  for (const id of new Set(panes.map((p) => p.workspace_id).filter(Boolean))) {
    if (!workspaces.some((w) => w.workspace_id === id)) {
      workspaces.push({ workspace_id: id, label: repoName(firstCwd(id)) || id, folder: firstCwd(id) });
    }
  }
  const tabs = docs.flatMap(({ prefix, doc: d }) =>
    (Array.isArray(d.spaces) ? d.spaces : []).flatMap((s) =>
      (Array.isArray(s.tabs) ? s.tabs : []).map((tab, i) => ({
        tab_id: `${prefix}${tab.id}`,
        workspace_id: `${prefix}${s.id}`,
        label: tab.name || String(i + 1),
      }))
    )
  );
  return { workspaces, tabs, panes, agents };
}

// Undefined without the daemon's copy: a snapshot missing its spaces and its
// statuses would say "no agents" with confidence.
export function loadCoreSnapshot(stateDir = process.env.HERDR_PLUGIN_STATE_DIR, machines) {
  const terminals = readTerminals(stateDir);
  if (!Array.isArray(terminals)) return undefined;
  return toSnapshot(terminals, readSpaces(stateDir), machines);
}

// One terminal as `herdr agent get` would have described it.
export function coreAgent(paneId, machines) {
  const t = hcJson(["get", paneId]);
  if (!t?.address) return undefined;
  return toSnapshot([t], {}, machines).panes[0];
}

// ---------------------------------------------------------------- transcript

function newestFile(dir, accept, since = 0) {
  let best;
  try {
    for (const name of readdirSync(dir)) {
      if (!accept(name)) continue;
      const path = join(dir, name);
      const mtime = statSync(path).mtimeMs;
      if (mtime >= since && (!best || mtime > best.mtime)) best = { path, mtime };
    }
  } catch {}
  return best?.path;
}

function firstLine(path, bytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8").split("\n")[0];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A remote agent's transcript is not on this disk, and the folder it keeps is
// no help from here: only an id names one. The Claude Code hook labels remote
// terminals too, so with it the file is found on that machine and read through
// hc.
export function remoteTranscript(session) {
  if (session?.kind !== "id" || !session.machine) return undefined;
  // The id is validated by coreSession(), so it is a file name and nothing else.
  // The tail only, as readTail() takes locally: a long session outgrows what
  // one hc call can carry whole.
  const tail = hcRun(
    [
      "exec", "--on", session.machine, "sh", "-c",
      `f=$(ls -t ~/.claude/projects/*/${session.value}.jsonl 2>/dev/null | head -1) && [ -n "$f" ] && tail -c 4194304 "$f"`,
    ],
    30_000
  );
  return tail.ok ? tail.out : undefined;
}

// Herdr TUI is told each agent's session; herdr-core is not, so the transcript
// is found where the agent keeps it: Claude Code by folder, Codex by the folder
// its rollout names. Only files written since the terminal started, and none at
// all when two agents of a kind share the folder.
export function guessTranscript(session) {
  if (!session?.cwd || session.shared) return undefined;
  const since = Number(session.since) || 0;
  const app = String(session.agent ?? "").toLowerCase();
  if (app.includes("claude")) {
    const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    return newestFile(join(projects, session.cwd.replace(/[^A-Za-z0-9]/g, "-")), (n) => n.endsWith(".jsonl"), since);
  }
  if (app.includes("codex")) {
    const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
    const days = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(Date.now() - i * 86_400_000);
      days.push(join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")));
    }
    let best;
    for (const dir of days) {
      try {
        for (const name of readdirSync(dir)) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
          const path = join(dir, name);
          const mtime = statSync(path).mtimeMs;
          if (mtime < since || (best && mtime <= best.mtime)) continue;
          let meta;
          try {
            meta = JSON.parse(firstLine(path) ?? "");
          } catch {}
          if ((meta?.payload?.cwd ?? meta?.cwd) === session.cwd) best = { path, mtime };
        }
      } catch {}
    }
    return best?.path;
  }
  return undefined;
}

// ------------------------------------------------------------------ events

// What a change to one terminal means for the hooks: a new status, a terminal
// that is gone, or nothing. `before` and `after` are whole records (undefined
// when the terminal was not known, or is removed).
export function transitions(before, after, machines) {
  const was = isAgent(before, machines) ? before.status.state : undefined;
  const now = isAgent(after, machines) ? after.status.state : undefined;
  if (now && now !== was) return [{ type: "status", terminal: after }];
  // Gone: removed, finished (hc clears the status just before), or the agent
  // quit and left its shell. A terminal that was never one has nothing to close.
  if (was && !now) return [{ type: "closed", terminal: before }];
  return [];
}

// One event applied to the records, as the schema README says to.
export function applyEvent(terminals, ev) {
  const id = ev.terminal;
  if (!id) return { before: undefined, after: undefined };
  const before = terminals.get(id);
  const data = ev.data ?? {};
  let after = before ? { ...before } : undefined;
  switch (ev.type) {
    case "created":
    case "restarted":
      after = { ...data };
      break;
    case "removed":
      after = undefined;
      break;
    case "finished":
      if (after) Object.assign(after, data, { state: "finished", foreground: null });
      break;
    case "lost":
      if (after) Object.assign(after, data, { pid: null, foreground: null });
      break;
    case "status":
      if (after) Object.assign(after, { status: data.status ?? null, records: data.records ?? {}, reported: data.reported });
      break;
    case "labels":
      if (data.record) after = { ...data.record };
      else if (after) after.labels = data.labels ?? {};
      break;
    case "foreground":
      if (after) after.foreground = data ?? null;
      break;
    case "turn":
      // Its `state` is the word the turn ended on, not the terminal's state.
      if (after) after.turn = data.turn;
      break;
    default:
      // title, keep, size: the field of the same name.
      if (after) Object.assign(after, data);
  }
  if (after) terminals.set(id, after);
  else terminals.delete(id);
  return { before, after };
}

// What notify.mjs gets, in the shape Herdr TUI's hooks hand it.
export function hookEvent(change) {
  const t = change.terminal;
  const machine = machineOf(t.address);
  const space = t.labels?.["herdr.space"];
  const data = {
    pane_id: t.address,
    workspace_id: space ? `${machine ? `${machine}/` : ""}${space}` : undefined,
  };
  if (change.type === "closed") return { name: "pane.closed", json: { event: "pane_closed", data } };
  const state = t.status.state;
  const kind = t.status.kind;
  return {
    name: "pane.agent_status_changed",
    json: {
      event: "pane_agent_status_changed",
      data: {
        ...data,
        agent_status: state,
        agent: appOf(t),
        display_agent: appOf(t),
        title: t.status.title || t.title || undefined,
        // permission, question or auth: worth the extra word on a blocked one.
        ...(kind ? { state_labels: { [state]: `${state} (${kind})` } } : {}),
      },
    },
  };
}

// ------------------------------------------------------------------- /new

// A tab id the app has not seen: it adopts the terminal into a new tab there.
export const freshTabId = () => `t${randomBytes(16).toString("hex")}`;

// Likewise a space: a terminal labelled with it gets a space of its own.
export const freshSpaceId = () => `sp${randomBytes(16).toString("hex")}`;

// The app's New worktree: checkouts go to <home>/.herdr/worktrees/<repo>/
// <branch, slashes as dashes>, so the app's spaces sidebar nests it under its
// repo. The slug is the app's.
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// One git call. argv only: the branch is chat input and never reaches a shell.
function gitRun(cwd, args, timeout = 60_000) {
  let res;
  try {
    res = spawnSync("git", args, { cwd, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  } catch (err) {
    return { ok: false, why: err.message };
  }
  if (res.error) return { ok: false, why: res.error.message };
  const out = (res.stdout ?? "").trim();
  if (res.status !== 0) {
    return { ok: false, why: (res.stderr || res.stdout || `git exited ${res.status}`).trim().slice(0, 300) };
  }
  return { ok: true, out };
}

// A checkout of a branch, as the app's New worktree makes it: from the space's
// folder, in its repo. An existing branch is checked out, a new one starts from
// HEAD. Returns the path, or why there is nothing to start in.
export function createWorktree(folder, branch) {
  const top = gitRun(folder, ["rev-parse", "--show-toplevel"]);
  const common = gitRun(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !common.ok) return { ok: false, why: `${folder} is not in a git repository` };
  // The main checkout is the common dir without its trailing /.git; the repo is
  // named after it, as the app names it.
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  const path = join(homedir(), ".herdr", "worktrees", basename(main), slug(branch));
  if (existsSync(path)) return { ok: false, why: `${path} is already there` };
  const exists = gitRun(top.out, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  const added = gitRun(top.out, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (!added.ok) return { ok: false, why: added.why };
  return { ok: true, path };
}
