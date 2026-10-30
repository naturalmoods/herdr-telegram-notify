// herdr-core: the translation from hc's records to the TUI's shapes (no
// processes), then the daemon and the poller against a fake `hc` on HC_BIN_PATH
// and a fake Telegram — the whole path from an hc event to a message, and from
// a reply to the hc command that delivers it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { applyEvent, coreSession, guessTranscript, hookEvent, toSnapshot, transitions } from "../core.mjs";
import { DEFAULTS, questionOnScreen, reportSidebarToken, transcriptPath } from "../lib.mjs";
import { telegramEntries } from "../contrib/herdr-app/telegram/entries.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DAEMON = join(HERE, "..", "daemon.mjs");
const REPLIES = join(HERE, "..", "replies.mjs");
const CHAT = 42;

const terminal = (address, extra = {}) => ({
  address,
  state: "live",
  argv: ["claude"],
  cwd: "/work/storefront",
  created_ms: 1000,
  labels: {},
  pid: 100,
  ...extra,
});
const agent = (address, state, extra = {}) =>
  terminal(address, { status: { state, app: "claude", title: "Fix the login" }, reported: true, ...extra });

// ------------------------------------------------------------ translation

test("toSnapshot names spaces and tabs the way the app does, and leaves helpers and other machines out", () => {
  const snap = toSnapshot(
    [
      agent("t1", "done", { labels: { "herdr.space": "s1", "herdr.tab": "a" }, foreground: { pid: 4242, cwd: "/work/storefront/web", name: "claude", argv: ["claude"] } }),
      agent("t2", "working", { labels: { "herdr.space": "s2", "herdr.tab": "b" }, cwd: "/work/notes" }),
      agent("t3", "working", { parent: "t1" }),
      agent("box/t4", "blocked"),
      terminal("t5", { labels: { "herdr.space": "s1" } }), // a shell: a pane, not an agent
      agent("t6", "done", { state: "finished" }),
    ],
    {
      spaces: [
        { id: "s1", name: "Storefront", folder: "/work/storefront", tabs: [{ id: "a", name: "" }, { id: "x", name: "fix login" }] },
        { id: "s2", name: "", folder: "/work/notes", tabs: [{ id: "b", name: "" }] },
      ],
    }
  );
  assert.deepEqual(snap.agents.map((a) => a.pane_id), ["t1", "t2"]);
  assert.deepEqual(snap.panes.map((p) => p.pane_id), ["t1", "t2", "t5"]);
  const t1 = snap.agents[0];
  assert.equal(t1.agent_status, "done");
  assert.equal(t1.display_agent, "claude");
  assert.equal(t1.cwd, "/work/storefront/web");
  assert.equal(t1.terminal_title_stripped, "Fix the login");
  assert.deepEqual(t1.agent_session, { kind: "proc", value: "t1:4242", agent: "claude", cwd: "/work/storefront/web", since: 1000, shared: false });
  assert.deepEqual(snap.workspaces.map((w) => [w.workspace_id, w.label]), [["s1", "Storefront"], ["s2", "notes"]]);
  assert.deepEqual(snap.tabs.map((t) => [t.tab_id, t.label]), [["a", "1"], ["x", "fix login"], ["b", "1"]]);
});

test("a space the document does not know yet still has a name", () => {
  const snap = toSnapshot([agent("t1", "done", { labels: { "herdr.space": "s9" } })], {});
  assert.deepEqual(snap.workspaces, [{ workspace_id: "s9", label: "storefront", folder: "/work/storefront" }]);
});

test("the session is the program in the terminal, and two of a kind in one folder share no transcript", () => {
  const a = agent("t1", "done", { pid: 7 });
  const b = agent("t2", "idle", { pid: 8 });
  assert.equal(coreSession(a, [a]).shared, false);
  assert.equal(coreSession(a, [a, b]).shared, true);
  assert.equal(coreSession(a, [a, { ...b, cwd: "/elsewhere" }]).shared, false);
  assert.equal(coreSession({ ...a, foreground: { pid: 9, cwd: a.cwd } }).value, "t1:9");
});

test("a Claude label from this process is the session, one from an earlier process is not", () => {
  const id = "aaaaaaaa-1111-2222-3333-444444444444";
  const t = agent("t1", "done", { pid: 100, labels: { "claude.session": `100:${id}` } });
  assert.deepEqual(coreSession(t, [t]), { kind: "id", value: id, agent: "claude", cwd: "/work/storefront", since: 1000 });
  // The label is read against the program in the pane now, so a leftover from
  // the one before it falls back to the proc session.
  const stale = { ...t, labels: { "claude.session": `999:${id}` } };
  assert.deepEqual(coreSession(stale, [stale]), {
    kind: "proc",
    value: "t1:100",
    agent: "claude",
    cwd: "/work/storefront",
    since: 1000,
    shared: false,
  });
  // Only Claude Code sets it; another agent's terminal keeps its proc session.
  const codex = { ...agent("t2", "done"), status: { state: "done", app: "codex" }, labels: { "claude.session": "100:" + id } };
  assert.equal(coreSession(codex, [codex]).kind, "proc");
  // An id that is not a session id is not a transcript file name either.
  const odd = { ...t, labels: { "claude.session": "100:../../etc/passwd" } };
  assert.equal(coreSession(odd, [odd]).kind, "proc");
});

test("two Claude agents in one folder keep their own transcript when each is labelled", () => {
  const root = mkdtempSync(join(tmpdir(), "core-labelled-"));
  const dir = join(root, "projects", "-work-storefront");
  mkdirSync(dir, { recursive: true });
  const first = join(dir, "aaaaaaaa-1111-2222-3333-444444444444.jsonl");
  const second = join(dir, "bbbbbbbb-5555-6666-7777-888888888888.jsonl");
  writeFileSync(first, "{}\n");
  writeFileSync(second, "{}\n");
  const a = agent("t1", "done", { foreground: { pid: 70, cwd: "/work/storefront" }, labels: { "claude.session": "70:aaaaaaaa-1111-2222-3333-444444444444" } });
  const b = agent("t2", "idle", { foreground: { pid: 80, cwd: "/work/storefront" }, labels: { "claude.session": "80:bbbbbbbb-5555-6666-7777-888888888888" } });
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    assert.equal(coreSession(a, [a, b]).shared, undefined, "a real id is not ambiguous");
    assert.equal(transcriptPath(coreSession(a, [a, b])), first);
    assert.equal(transcriptPath(coreSession(b, [a, b])), second);
    // Unlabelled, the pair is ambiguous and gets no transcript rather than the wrong one.
    const plain = [a, b].map((t) => ({ ...t, labels: {} }));
    assert.equal(transcriptPath(coreSession(plain[0], plain)), undefined);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("events become one hook per status change and one closure, whichever way the terminal goes", () => {
  const map = new Map();
  const hooks = [];
  const apply = (ev) => {
    const { before, after } = applyEvent(map, ev);
    hooks.push(...transitions(before, after).map((c) => `${c.type}${c.type === "status" ? `:${c.terminal.status.state}` : ""}`));
  };
  apply({ type: "created", terminal: "t1", data: terminal("t1") });
  apply({ type: "status", terminal: "t1", data: { status: { state: "working", app: "claude" }, records: {}, reported: true } });
  apply({ type: "title", terminal: "t1", data: { title: "x" } });
  apply({ type: "status", terminal: "t1", data: { status: { state: "working", app: "claude", msg: "still" }, records: {}, reported: true } });
  apply({ type: "status", terminal: "t1", data: { status: { state: "done", app: "claude" }, records: {}, reported: true } });
  // The turn's `state` is the word it ended on; the terminal stays live.
  apply({ type: "turn", terminal: "t1", data: { turn: 1, state: "done" } });
  assert.equal(map.get("t1").state, "live");
  assert.equal(map.get("t1").turn, 1);
  // hc clears the status just before it says the program finished.
  apply({ type: "status", terminal: "t1", data: { status: null, records: {}, reported: true } });
  apply({ type: "finished", terminal: "t1", data: { reason: "exited", exit_code: 0, signal: null, finished_ms: 5 } });
  apply({ type: "removed", terminal: "t1", data: {} });
  assert.deepEqual(hooks, ["status:working", "status:done", "closed"]);
  assert.equal(map.size, 0);

  // Removed while still reporting: closed all the same.
  apply({ type: "created", terminal: "t2", data: agent("t2", "blocked") });
  apply({ type: "removed", terminal: "t2", data: {} });
  assert.deepEqual(hooks.slice(3), ["status:blocked", "closed"]);

  // The Claude session hook labels the terminal; a label is not a status change.
  apply({ type: "created", terminal: "t3", data: agent("t3", "working") });
  apply({ type: "labels", terminal: "t3", data: { labels: { "claude.session": "9:aaaaaaaa-1111" } } });
  assert.equal(map.get("t3").labels["claude.session"], "9:aaaaaaaa-1111");
  assert.deepEqual(hooks.slice(5), ["status:working"]);
});

test("a hook gets the TUI's event shape, with the blocked kind as its label", () => {
  const { name, json } = hookEvent({
    type: "status",
    terminal: agent("t1", "blocked", { labels: { "herdr.space": "s1" }, status: { state: "blocked", app: "codex", kind: "permission" } }),
  });
  assert.equal(name, "pane.agent_status_changed");
  assert.deepEqual(json.data, {
    pane_id: "t1",
    workspace_id: "s1",
    agent_status: "blocked",
    agent: "codex",
    display_agent: "codex",
    title: undefined,
    state_labels: { blocked: "blocked (permission)" },
  });
  assert.deepEqual(hookEvent({ type: "closed", terminal: agent("t1", "done") }).json, { event: "pane_closed", data: { pane_id: "t1", workspace_id: undefined } });
});

test("guessTranscript takes Claude's newest file for that folder written since the terminal started", () => {
  const root = mkdtempSync(join(tmpdir(), "core-transcript-"));
  const dir = join(root, "projects", "-work-storefront");
  mkdirSync(dir, { recursive: true });
  const old = join(dir, "old.jsonl");
  const fresh = join(dir, "fresh.jsonl");
  writeFileSync(old, "{}\n");
  writeFileSync(fresh, "{}\n");
  utimesSync(old, 1, 1);
  utimesSync(fresh, 3, 3);
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const session = { agent: "claude", cwd: "/work/storefront", since: 2000 };
    assert.equal(guessTranscript(session), fresh);
    assert.equal(guessTranscript({ ...session, since: 4000 }), undefined, "nothing written since it started");
    assert.equal(guessTranscript({ ...session, shared: true }), undefined);
    assert.equal(guessTranscript({ ...session, agent: "pi" }), undefined);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("guessTranscript finds a Codex rollout by the folder it names", () => {
  const root = mkdtempSync(join(tmpdir(), "core-codex-"));
  const d = new Date();
  const dir = join(root, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const mine = join(dir, "rollout-a-1.jsonl");
  writeFileSync(mine, JSON.stringify({ type: "session_meta", payload: { cwd: "/work/storefront" } }) + "\n");
  writeFileSync(join(dir, "rollout-b-2.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: "/work/other" } }) + "\n");
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    assert.equal(guessTranscript({ agent: "codex", cwd: "/work/storefront", since: 0 }), mine);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

test("the session hook labels this terminal, and stays quiet otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "core-hook-"));
  const fake = join(dir, "hc");
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "hc-argv.jsonl"))}, JSON.stringify(args) + "\\n");
if (args[0] === "get") console.log(JSON.stringify({ address: args[1], foreground: { pid: Number(process.env.FAKE_FOREGROUND_PID) } }));
else console.log("{}");
`
  );
  chmodSync(fake, 0o755);
  const hook = join(HERE, "..", "contrib", "claude-session-hook.sh");
  const id = "aaaaaaaa-1111-2222-3333-444444444444";
  const base = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    HC_TERMINAL_ID: "t3",
    // The test process started the hook, so it is the program in the pane.
    FAKE_FOREGROUND_PID: String(process.pid),
  };
  const runHook = (env) =>
    new Promise((resolve) => {
      const child = spawn(hook, [], { env });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
      child.stdin.end(JSON.stringify({ session_id: id, transcript_path: "/work/storefront/x.jsonl", source: "clear" }));
    });
  const argv = () =>
    existsSync(join(dir, "hc-argv.jsonl"))
      ? readFileSync(join(dir, "hc-argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      : [];

  const labelled = await runHook(base);
  assert.equal(labelled.code, 0);
  assert.equal(labelled.out, "", "the hook prints nothing on stdout");
  assert.deepEqual(argv(), [
    ["get", "t3", "--json"],
    ["label", "t3", `claude.session=${process.pid}:${id}`],
  ]);

  // The foreground pid is not this hook's ancestor: another program's session.
  const before = argv().length;
  const stale = await runHook({ ...base, FAKE_FOREGROUND_PID: "1" });
  assert.equal(stale.code, 0);
  assert.equal(stale.out, "");
  assert.deepEqual(argv().slice(before), [["get", "t3", "--json"]]);

  // Outside an hc terminal there is nothing to label, and nothing to say.
  const outside = { ...base };
  delete outside.HC_TERMINAL_ID;
  const beforeOutside = argv().length;
  const quiet = await runHook(outside);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.out, "");
  assert.equal(argv().length, beforeOutside, "no hc call without HC_TERMINAL_ID");
});

// ------------------------------------------------------------ the app mod

test("the app's band shows an agent's token and the mute once, and drops what expired or is no agent's", () => {
  const now = 1_800_000_000_000;
  const entries = telegramEntries(
    [
      { address: "t1", status: "done", where: "api / 1", labels: { telegram: "📨 07:12", "telegram.expires": String(now + 60_000) } },
      { address: "t2", status: "blocked", where: "api / 2", labels: { telegram: "📱 07:13" } },
      { address: "t3", status: "working", where: "api / 3", labels: { telegram: "📨 07:14", "telegram.expires": String(now - 1) } },
      { address: "t4", status: "done", parent: "t1", where: "api / 1", labels: { telegram: "📨 07:15" } },
      { address: "t5", where: "api / 1", labels: { telegram: "📨 07:16" } },
      { address: "t6", status: "idle", where: "api / 2", labels: { telegram: "📨 07:17", "telegram.mute": "🔕 until 15:00", "telegram.mute.expires": String(now + 60_000) } },
      { address: "t7", status: "idle", where: "api / 3", labels: { "telegram.mute": "🔕 until 15:00" } },
    ],
    now
  );
  assert.deepEqual(entries, [
    { text: "🔕 until 15:00" },
    { address: "t1", text: "📨 07:12", where: "api / 1" },
    { address: "t2", text: "📱 07:13", where: "api / 2" },
    { address: "t6", text: "📨 07:17", where: "api / 2" },
  ]);
  // Without a where, the address is what a click goes to.
  assert.deepEqual(telegramEntries([{ address: "t8", status: "done", labels: { telegram: "📨 07:18" } }], now), [
    { address: "t8", text: "📨 07:18", where: "t8" },
  ]);
  // A full core record keeps the place in its labels; only hc ls's summary is top-level.
  assert.deepEqual(telegramEntries([{ address: "t9", status: "done", labels: { telegram: "📨 07:19", where: "notes / 2" } }], now), [
    { address: "t9", text: "📨 07:19", where: "notes / 2" },
  ]);
});

// --------------------------------------------------------------- fakes

// `hc events` hands out its snapshot, waits a moment (as a real core would
// before anything changes), then the events it was given, and stays open.
// `hc connect` answers doc.get. Every other call is logged as JSON argv and
// answered from the records file, which a test can rewrite as things change.
function fakeHc(dir, { terminals = [], events = [], doc = {}, screens = {} } = {}) {
  const records = join(dir, "records.json");
  writeFileSync(records, JSON.stringify(terminals));
  const path = join(dir, "hc");
  writeFileSync(path, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "hc-argv.jsonl"))}, JSON.stringify(args) + "\\n");
const records = JSON.parse(fs.readFileSync(${JSON.stringify(records)}, "utf8"));
const screens = ${JSON.stringify(screens)};
const out = (v) => console.log(JSON.stringify(v));
const target = args.filter((a) => /^t\\d+$/.test(a)).pop();
if (args[0] === "events") {
  out({ seq: 0, terminals: records });
  setTimeout(() => {
    for (const [i, ev] of ${JSON.stringify(events)}.entries()) out({ jsonrpc: "2.0", method: "event", params: { seq: i + 1, ...ev } });
  }, 600);
  setInterval(() => {}, 1000);
} else if (args[0] === "connect") {
  process.stdin.once("data", (d) => {
    const req = JSON.parse(String(d).split("\\n")[0]);
    out({ jsonrpc: "2.0", id: req.id, result: { value: ${JSON.stringify(doc)}, version: 1 } });
  });
} else if (args[0] === "get") {
  const t = records.find((r) => r.address === target);
  if (!t) { console.error(JSON.stringify({ error: { kind: "not_found", message: "no terminal " + target } })); process.exit(3); }
  out(t);
} else if (args[0] === "read") {
  out({ text: screens[target] ?? "", complete: true, how: "screen" });
} else if (args[0] === "run") {
  out({ address: "t9", state: "live" });
} else if (args[0] === "server") {
  out({ version: "0.1.14", core: { name: "fake" } });
} else out({});
`);
  chmodSync(path, 0o755);
  return {
    path,
    argv: () => {
      if (!existsSync(join(dir, "hc-argv.jsonl"))) return [];
      // A call being appended right now can be read half-written; it is not one yet.
      return readFileSync(join(dir, "hc-argv.jsonl"), "utf8")
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })
        .filter(Boolean);
    },
    set: (next) => writeFileSync(records, JSON.stringify(next)),
  };
}

function dirs(env = []) {
  const root = mkdtempSync(join(tmpdir(), "core-test-"));
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  mkdirSync(stateDir);
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, ".env"),
    ["TELEGRAM_BOT_TOKEN=123456789:AAtesttesttesttesttesttesttest", `TELEGRAM_CHAT_ID=${CHAT}`, ...env].join("\n")
  );
  chmodSync(join(configDir, ".env"), 0o600);
  return { root, stateDir, configDir };
}

async function fakeTelegram(batches = []) {
  const sent = [];
  const waiting = new Set();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = req.url.split("/").pop();
      const payload = JSON.parse(body || "{}");
      const answer = (json) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (method === "getMe") return answer({ ok: true, result: { username: "herdbot" } });
      if (method === "setMyCommands") return answer({ ok: true, result: true });
      if (method === "getUpdates") {
        const batch = batches.shift();
        if (batch) return answer({ ok: true, result: batch });
        waiting.add(res);
        return;
      }
      sent.push({ method, ...payload });
      answer({ ok: true, result: { message_id: 1000 + sent.length } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    sent,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const res of waiting) res.destroy();
      server.close();
    },
  };
}

function run(script, args, env, { until, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let out = "";
    const done = (err) => {
      clearInterval(poll);
      clearTimeout(bomb);
      child.kill("SIGKILL");
      err ? reject(err) : resolve(out);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const poll = setInterval(() => until(out) && done(), 50);
    const bomb = setTimeout(() => done(new Error(`timed out; output:\n${out}`)), timeoutMs);
  });
}

// ---------------------------------------------------------- sidebar labels

const cfg = (key) => DEFAULTS[key];

// The daemon's copy is what a workspace report reads, so it is written here.
function coreTerminals(fx, terminals) {
  writeFileSync(join(fx.stateDir, "core-terminals.json"), JSON.stringify({ terminals }));
}

async function withCore(hc, fx, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BACKEND: "core", HC_BIN_PATH: hc.path, HERDR_PLUGIN_STATE_DIR: fx.stateDir });
  try {
    return await fn();
  } finally {
    for (const key of ["HERDR_BACKEND", "HC_BIN_PATH", "HERDR_PLUGIN_STATE_DIR"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("the core reports sidebar tokens as terminal labels, and clears both", async () => {
  const fx = dirs();
  const hc = fakeHc(fx.root);
  coreTerminals(fx, [agent("t1", "done"), agent("t2", "blocked"), agent("t3", "working", { parent: "t1" }), terminal("t5"), agent("box/t6", "done")]);
  await withCore(hc, fx, async () => {
    const labels = () => hc.argv().filter((a) => a[0] === "label");

    await reportSidebarToken("pane", "t1", "📨 07:12", { ttlMs: 60_000, cfg });
    const set = labels().at(-1);
    assert.deepEqual(set.slice(0, 3), ["label", "t1", "telegram=📨 07:12"]);
    const expires = Number(set[3].split("=")[1]);
    assert.ok(expires >= Date.now() && expires <= Date.now() + 60_000, set[3]);

    await reportSidebarToken("pane", "t1", undefined, { cfg });
    assert.deepEqual(labels().at(-1), ["label", "t1", "telegram=", "telegram.expires="]);

    // The mute is a workspace's: every agent of the daemon's copy, nothing else.
    const until = Date.now() + 3_600_000;
    await reportSidebarToken("workspace", undefined, "🔕 until 15:00", { expiresAt: until, cfg });
    const mutes = labels().slice(-2);
    assert.deepEqual(mutes.map((a) => a[1]), ["t1", "t2"]);
    for (const mute of mutes) {
      assert.deepEqual(mute.slice(2), ["telegram.mute=🔕 until 15:00", `telegram.mute.expires=${until}`]);
    }

    await reportSidebarToken("workspace", undefined, undefined, { cfg });
    assert.deepEqual(labels().slice(-2).map((a) => a.slice(1)), [
      ["t1", "telegram.mute=", "telegram.mute.expires="],
      ["t2", "telegram.mute=", "telegram.mute.expires="],
    ]);
  });
});

test("SIDEBAR_TOKENS=0 and DRY_RUN=1 leave the core's terminal labels alone", async () => {
  const fx = dirs();
  const hc = fakeHc(fx.root);
  coreTerminals(fx, [agent("t1", "done")]);
  await withCore(hc, fx, async () => {
    for (const [key, value] of [["SIDEBAR_TOKENS", "0"], ["DRY_RUN", "1"]]) {
      const off = (name) => (name === key ? value : DEFAULTS[name]);
      await reportSidebarToken("pane", "t1", "📨 07:12", { ttlMs: 60_000, cfg: off });
      await reportSidebarToken("workspace", undefined, "🔕 until 15:00", { expiresAt: Date.now() + 60_000, cfg: off });
    }
    assert.deepEqual(hc.argv(), []);
  });
});

// ------------------------------------------------------------- end to end

test("the daemon turns an hc status event into the TUI plugin's message, with the space's name and the transcript", async () => {
  const fx = dirs();
  const claude = join(fx.root, "claude");
  const cwd = join(fx.root, "storefront");
  mkdirSync(cwd);
  const projects = join(claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(projects, "s.jsonl"),
    [
      JSON.stringify({ type: "user", timestamp: "2026-09-22T10:00:00Z", message: { role: "user", content: "fix the login" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-09-22T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "Login fixed, tests pass." }] } }),
    ].join("\n") + "\n"
  );
  const t3 = agent("t3", "working", { cwd, created_ms: 0, labels: { "herdr.space": "s1", "herdr.tab": "a" } });
  const hc = fakeHc(fx.root, {
    terminals: [t3],
    doc: { spaces: [{ id: "s1", name: "Storefront", folder: cwd, tabs: [{ id: "a", name: "login" }] }] },
    events: [
      { type: "status", terminal: "t3", data: { status: { state: "done", app: "claude", title: "Fix the login" }, records: {}, reported: true } },
    ],
  });
  const out = await run(DAEMON, [], {
    HC_BIN_PATH: hc.path,
    HERDR_PLUGIN_STATE_DIR: fx.stateDir,
    HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
    CLAUDE_CONFIG_DIR: claude,
    DRY_RUN: "1",
  }, { until: (o) => o.includes("--- plain-text fallback ---") });
  assert.match(out, /claude · done/);
  assert.match(out, /Storefront/);
  assert.match(out, /tab login/);
  assert.match(out, /hc attach t3/);
  assert.match(out, /Login fixed, tests pass\./);
  assert.match(out, /fix the login/);
  const terminals = JSON.parse(readFileSync(join(fx.stateDir, "core-terminals.json"), "utf8")).terminals;
  assert.equal(terminals[0].status.state, "done");
});

test("the daemon does not report what was already done before it started, and refuses a second copy", async () => {
  const fx = dirs();
  const hc = fakeHc(fx.root, { terminals: [agent("t1", "done")] });
  const env = { HC_BIN_PATH: hc.path, HERDR_PLUGIN_STATE_DIR: fx.stateDir, HERDR_PLUGIN_CONFIG_DIR: fx.configDir, DRY_RUN: "1" };
  const first = spawn(process.execPath, [DAEMON], { env: { ...process.env, ...env } });
  try {
    let out = "";
    first.stdout.on("data", (d) => (out += d));
    await new Promise((r) => {
      const poll = setInterval(() => out.includes("following hc events") && (clearInterval(poll), r()), 50);
    });
    await new Promise((r) => setTimeout(r, 1200));
    assert.doesNotMatch(out, /sent as HTML/);
    const second = await run(DAEMON, [], env, { until: (o) => /exiting/.test(o) });
    assert.match(second, /another daemon already follows this core/);
  } finally {
    first.kill("SIGKILL");
  }
});

test("replies reach the agent through hc: send for a new turn, interrupt for /stop", async () => {
  const fx = dirs(["REPLIES=1"]);
  // Working, so the reply is a new turn and /stop has something to stop.
  const t3 = agent("t3", "working", { foreground: { pid: 4242, cwd: "/work/storefront", name: "claude", argv: ["claude"] } });
  const hc = fakeHc(fx.root, { terminals: [t3], screens: { t3: "Do you want to proceed?\n❯ 1. Yes\n  2. No" } });
  const session = "proc:t3:4242";
  writeFileSync(
    join(fx.stateDir, "messages.jsonl"),
    [{ id: 500, paneId: "t3", session, at: Date.now() }].map((m) => JSON.stringify(m)).join("\n") + "\n"
  );
  const update = (id, text, replyTo) => ({
    update_id: id,
    message: { message_id: id * 10, chat: { id: CHAT }, from: { id: 7 }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) },
  });
  const tg = await fakeTelegram([[update(1, "-v carry on", 500)], [update(2, "/stop", 500)]]);
  try {
    const env = {
      HERDR_BACKEND: "core",
      HC_BIN_PATH: hc.path,
      HERDR_PLUGIN_STATE_DIR: fx.stateDir,
      HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
      TELEGRAM_API_BASE: tg.base,
    };
    await run(REPLIES, [], env, { until: () => hc.argv().some((a) => a[0] === "interrupt") });
    const argv = hc.argv();
    assert.deepEqual(argv.find((a) => a[0] === "send"), ["send", "--", "t3", "-v carry on"]);
    assert.deepEqual(argv.find((a) => a[0] === "interrupt"), ["interrupt", "t3"]);
  } finally {
    tg.close();
  }
});

test("/new starts the agent in a new tab of that space, from its folder, and tells it the prompt once it is ready", async () => {
  const fx = dirs(["REPLIES=1"]);
  writeFileSync(join(fx.stateDir, "core-spaces.json"), JSON.stringify({ spaces: [{ id: "s1", name: "Storefront", folder: "/work/storefront", tabs: [] }] }));
  writeFileSync(join(fx.stateDir, "core-terminals.json"), JSON.stringify({ terminals: [] }));
  const hc = fakeHc(fx.root, { terminals: [agent("t9", "idle", { foreground: { pid: 9, cwd: "/work/storefront", name: "claude", argv: ["claude"] } })] });
  const update = (id, text) => ({ update_id: id, message: { message_id: id * 10, chat: { id: CHAT }, from: { id: 7 }, text } });
  const tg = await fakeTelegram([[update(1, "/new storefront claude Review notes.md"), update(2, "/new storefront rm now")]]);
  try {
    await run(REPLIES, [], {
      HERDR_BACKEND: "core",
      HC_BIN_PATH: hc.path,
      HERDR_PLUGIN_STATE_DIR: fx.stateDir,
      HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
      TELEGRAM_API_BASE: tg.base,
    }, { until: () => tg.sent.length >= 2 });
    const argv = hc.argv();
    const started = argv.find((a) => a[0] === "run");
    assert.deepEqual(started.slice(0, 5), ["run", "--bg", "--keep", "--no-parent", "--name"]);
    assert.match(started[5], /^claude-[a-z0-9]{4}$/);
    assert.ok(started.includes("herdr.space=s1"));
    assert.ok(started.some((a) => /^herdr\.tab=t[0-9a-f]{32}$/.test(a)));
    assert.deepEqual(started.slice(-4), ["--cwd", "/work/storefront", "--json", "claude"]);
    assert.deepEqual(argv.find((a) => a[0] === "wait"), ["wait", "--timeout", "60", "t9"]);
    assert.deepEqual(argv.find((a) => a[0] === "send"), ["send", "--", "t9", "Review notes.md"]);
    assert.equal(tg.sent[0].text, "▶ started claude in Storefront · t9");
    assert.match(tg.sent[1].text, /rm is not one of CORE_AGENT_KINDS/);
    assert.equal(argv.filter((a) => a[0] === "run").length, 1);
  } finally {
    tg.close();
  }
});

test("an answer to a blocked agent's question is typed into it with a forced send", async () => {
  const fx = dirs(["REPLIES=1"]);
  const t3 = agent("t3", "blocked", { foreground: { pid: 4242, cwd: "/work/storefront", name: "claude", argv: ["claude"] } });
  const hc = fakeHc(fx.root, { terminals: [t3], screens: { t3: "Do you want to proceed?\n❯ 1. Yes\n  2. No" } });
  // What the notifier records when the agent blocks, and the question it read.
  writeFileSync(join(fx.stateDir, "state-t3.json"), JSON.stringify({ status: "blocked", updatedAt: Date.now(), paneId: "t3" }));
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BACKEND: "core", HC_BIN_PATH: hc.path });
  let question;
  try {
    question = questionOnScreen(fx.stateDir, "t3");
  } finally {
    for (const key of ["HERDR_BACKEND", "HC_BIN_PATH"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  assert.ok(question, "no question read from the fake screen");
  writeFileSync(join(fx.stateDir, "messages.jsonl"), JSON.stringify({ id: 500, paneId: "t3", session: "proc:t3:4242", question, at: Date.now() }) + "\n");
  const tg = await fakeTelegram([[{ update_id: 1, message: { message_id: 10, chat: { id: CHAT }, from: { id: 7 }, text: "2", reply_to_message: { message_id: 500 } } }]]);
  try {
    await run(REPLIES, [], {
      HERDR_BACKEND: "core",
      HC_BIN_PATH: hc.path,
      HERDR_PLUGIN_STATE_DIR: fx.stateDir,
      HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
      TELEGRAM_API_BASE: tg.base,
    }, { until: () => hc.argv().some((a) => a[0] === "send") });
    assert.deepEqual(hc.argv().find((a) => a[0] === "send"), ["send", "--force", "--", "t3", "2"]);
  } finally {
    tg.close();
  }
});
