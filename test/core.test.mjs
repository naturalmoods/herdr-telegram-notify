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
import { questionOnScreen } from "../lib.mjs";

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
    argv: () =>
      existsSync(join(dir, "hc-argv.jsonl"))
        ? readFileSync(join(dir, "hc-argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
        : [],
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
