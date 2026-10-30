// The notifier for herdr-core (`hc`, what the Herdr app runs on). Herdr TUI
// starts notify.mjs from its plugin hooks; herdr-core has no hooks, so this
// follows `hc events` and starts notify.mjs the same way on every status change
// and closed terminal. Everything after that — the message, the poller, the
// sweeper, the board — is the TUI plugin's own code, unchanged.
//
// Run it on the machine where the agents run, next to its core, as a service:
//   node daemon.mjs            (see docs/core.md for a systemd unit)
//   node daemon.mjs doctor     check the setup and send a test message
//   node daemon.mjs mute       mute for MUTE_MINUTES, or lift a mute

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

process.env.HERDR_BACKEND = "core";
process.env.HERDR_PLUGIN_CONFIG_DIR ||= join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr-telegram-notify");
process.env.HERDR_PLUGIN_STATE_DIR ||= join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr-telegram-notify");

const { applyEvent, coreMachines, hcBin, hookEvent, machineAllowed, machineOf, readSpaces, rpc, transitions, writeSpaces, writeTerminals } = await import("./core.mjs");
const { holdFlock, flockAvailable, loadConfig, isOn } = await import("./lib.mjs");

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const notify = fileURLToPath(new URL("notify.mjs", import.meta.url));
const cfg = loadConfig();
const debug = isOn(cfg("DEBUG"));
const machines = coreMachines(cfg("CORE_MACHINES"));
const log = (line) => console.log(`herdr-telegram-notify: ${line}`);

mkdirSync(stateDir, { recursive: true });
mkdirSync(process.env.HERDR_PLUGIN_CONFIG_DIR, { recursive: true });

// A hook per change, as Herdr TUI runs one: concurrently, each to its end. A
// blocked delay sleeps inside its hook and must not hold up the others.
function runHook(args, env = {}) {
  const child = spawn(process.execPath, [notify, ...args], {
    env: { ...process.env, HERDR_PLUGIN_CONTEXT_JSON: "{}", ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (err) => console.error(`herdr-telegram-notify: could not start notify.mjs: ${err.message}`));
}

// The space names a hook reads, once a fresh connection has read them: until
// then the copy can be missing or stale, and the first messages would say so.
let names = Promise.resolve();

function fire(change) {
  const { name, json } = hookEvent(change);
  if (debug) log(`${change.terminal.address}: ${name} ${json.data.agent_status ?? ""}`.trim());
  void names.then(() => runHook([], { HERDR_PLUGIN_EVENT: name, HERDR_PLUGIN_EVENT_JSON: JSON.stringify(json) }));
}

// Space and tab names live in the app's document of each watched machine. The
// hooks read the copy left in the state directory; a failed read keeps the last.
function watched() {
  if (!machines.all) return [...machines.names];
  // `*` names them by the terminals the stream already carries.
  return [...new Set([...terminals.keys()].map(machineOf).filter(Boolean))].sort();
}

async function refreshSpaces(only) {
  try {
    const current = readSpaces(stateDir);
    const next = {
      spaces: Array.isArray(current.spaces) ? current.spaces : [],
      machines: { ...(current.machines ?? {}) },
    };
    if (!only) {
      const { value } = await rpc("doc.get", { name: "herdr-app" });
      next.spaces = Array.isArray(value?.spaces) ? value.spaces : [];
    }
    for (const name of only ? [only] : watched()) {
      try {
        const { value } = await rpc("doc.get", { name: "herdr-app", on: name });
        next.machines[name] = value ?? {};
      } catch (err) {
        if (debug) log(`${name}: space names not refreshed: ${err.message}`);
      }
    }
    writeSpaces(stateDir, next);
  } catch (err) {
    if (debug) log(`space names not refreshed: ${err.message}`);
  }
}

let terminals = new Map();
let known = false;

// A fresh list: on the first connection it is only the starting point (what was
// already done before this started is not news), after a gap every difference
// is a change that happened while nobody was listening.
function adopt(list, announce) {
  const next = new Map((list ?? []).map((t) => [t.address, t]));
  const changes = announce
    ? [...new Set([...terminals.keys(), ...next.keys()])].flatMap((a) => transitions(terminals.get(a), next.get(a), machines))
    : [];
  terminals = next;
  save();
  for (const change of changes) fire(change);
}

// A fresh list, and the space names read after it (`*` finds its machines in
// the list): the hooks its changes start wait for those names.
function adoptNamed(list, announce) {
  let read;
  names = new Promise((resolve) => (read = resolve));
  adopt(list, announce);
  void refreshSpaces().then(read);
}

// Before any hook starts, so the one it starts reads the change that started it.
function save() {
  try {
    writeTerminals(stateDir, terminals.values());
  } catch (err) {
    console.error(`herdr-telegram-notify: could not save the terminal list: ${err.message}`);
  }
}

function follow() {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.HC_TERMINAL_ID;
    const child = spawn(hcBin(), ["events", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let first = true;
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", (e) => (err = e.message));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (first) {
        // The subscribe answer: {seq, terminals}.
        first = false;
        adoptNamed(msg.terminals, known);
        known = true;
        log(`following hc events (${terminals.size} terminal${terminals.size === 1 ? "" : "s"})`);
        return;
      }
      const p = msg.params ?? {};
      if (msg.method === "missed") {
        adoptNamed(p.terminals, true);
      } else if (msg.method === "event" && p.type === "doc") {
        if (p.data?.name === "herdr-app") {
          if (!p.machine) void refreshSpaces();
          else if (machineAllowed(p.machine, machines)) void refreshSpaces(p.machine);
        }
      } else if (msg.method === "event") {
        const { before, after } = applyEvent(terminals, p);
        const changes = transitions(before, after, machines);
        // Status, labels, a new or a gone terminal: what a hook or /status reads.
        // Not the size or the title ticking over.
        if (changes.length || ["created", "removed", "finished", "status", "labels", "restarted", "lost", "foreground"].includes(p.type)) save();
        for (const change of changes) fire(change);
      }
    });
    child.on("close", (code) => {
      lines.close();
      resolve({ code, err: err.trim() });
    });
  });
}

async function run() {
  // Two of these would send every message twice.
  if (flockAvailable() && !holdFlock(join(stateDir, "daemon.lock"))) {
    log("another daemon already follows this core; exiting");
    return;
  }

  // Startup: the reply poller and the sweeper, if configured, as Herdr's
  // startup hook would start them.
  runHook(["--startup"]);

  let delay = 1000;
  for (;;) {
    const started = Date.now();
    const { code, err } = await follow();
    // A core restart (an update, `hc server restart`) ends the stream; the next
    // one starts with a fresh snapshot, and the difference is replayed above.
    if (Date.now() - started > 60_000) delay = 1000;
    log(`hc events ended (${code ?? "signal"}${err ? `: ${err.split("\n").pop()}` : ""}); again in ${Math.round(delay / 1000)}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}

// The plugin's two actions, with this runtime's directories.
const action = process.argv[2];
if (action === "doctor" || action === "mute") await import(`./${action}.mjs`);
else if (action) {
  console.error("usage: node daemon.mjs [doctor | mute]");
  process.exitCode = 2;
} else await run();
