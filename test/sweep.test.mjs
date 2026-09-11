// The sweeper: `notify.mjs --sweep`, the periodic half of the hook. Run rather
// than imported, the way CI runs the hook — a real process, a fake herdr on
// HERDR_BIN_PATH and a fake Telegram on TELEGRAM_API_BASE, so what is under test
// is the loop and not a stub of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HERE = new URL(".", import.meta.url).pathname;
const NOTIFY = join(HERE, "..", "notify.mjs");

// Collects every sendMessage the sweeper makes, and answers as Telegram does.
async function fakeTelegram() {
  const sent = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sent.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { sent, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// `herdr api snapshot` and nothing else: p1 is still blocked, p2 has answered.
function fakeHerdr(dir) {
  const snapshot = {
    result: {
      snapshot: {
        workspaces: [{ workspace_id: "wA", label: "storefront" }],
        panes: [],
        agents: [
          { pane_id: "wA:p1", workspace_id: "wA", agent: "claude", agent_status: "blocked" },
          { pane_id: "wA:p2", workspace_id: "wA", agent: "claude", agent_status: "working" },
        ],
      },
    },
  };
  const path = join(dir, "herdr");
  writeFileSync(path, `#!/bin/sh\n[ "$1" = api ] || exit 1\ncat <<'JSON'\n${JSON.stringify(snapshot)}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixture({ sweepMinutes } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sweep-test-"));
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  mkdirSync(stateDir);
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=123456789:AAtesttesttesttesttesttesttest",
      "TELEGRAM_CHAT_ID=42",
      ...(sweepMinutes === undefined ? [] : [`SWEEP_MINUTES=${sweepMinutes}`]),
      "BLOCKED_REMINDER_MINUTES=1",
      "SHOW_SCREEN_ON_BLOCKED=0",
      "SHOW_HERD=0",
    ].join("\n")
  );
  chmodSync(join(configDir, ".env"), 0o600);
  return { root, stateDir, configDir, herdr: fakeHerdr(root) };
}

const blocked = (paneId, minutesAgo) =>
  JSON.stringify({ status: "blocked", updatedAt: Date.now() - minutesAgo * 60 * 1000, paneId });

// Waits for the sweeper's first pass rather than for a fixed sleep.
function runSweeper(fx, base, { until, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NOTIFY, "--sweep"], {
      env: {
        ...process.env,
        HERDR_PLUGIN_STATE_DIR: fx.stateDir,
        HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
        HERDR_BIN_PATH: fx.herdr,
        TELEGRAM_API_BASE: base,
      },
    });
    let out = "";
    const done = (err) => {
      clearInterval(poll);
      clearTimeout(bomb);
      child.kill();
      err ? reject(err) : resolve(out);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", () => done());
    const poll = setInterval(() => until() && done(), 50);
    const bomb = setTimeout(() => done(new Error(`sweeper timed out; output:\n${out}`)), timeoutMs);
  });
}

test("the sweeper flushes the queue and nudges, with no status event at all", async () => {
  const tg = await fakeTelegram();
  const fx = fixture({ sweepMinutes: 1 });
  try {
    // One message the network was down for, and one that aged out while it was.
    writeFileSync(
      join(fx.stateDir, "pending.jsonl"),
      [
        JSON.stringify({ at: Date.now() - 60_000, parts: { emoji: "✅", agent: "claude", statusLabel: "done" } }),
        JSON.stringify({ at: Date.now() - 9 * 60 * 60 * 1000, parts: { emoji: "✅", agent: "claude", statusLabel: "stale" } }),
      ].join("\n") + "\n"
    );
    // Blocked long enough to be due; p2 said so too but has since answered.
    writeFileSync(join(fx.stateDir, "state-wA_p1.json"), blocked("wA:p1", 30));
    writeFileSync(join(fx.stateDir, "state-wA_p2.json"), blocked("wA:p2", 30));

    await runSweeper(fx, tg.base, { until: () => tg.sent.length >= 2 });

    const texts = tg.sent.map((m) => m.text);
    assert.equal(texts.length, 2, `expected the queued message and one nudge, got:\n${texts.join("\n---\n")}`);
    assert.match(texts[0], /delayed/); // the queue goes first, marked late
    assert.match(texts[1], /still blocked/);
    assert.match(texts[1], /wA:p1/);
    // The one that answered is not nagged, and a six-hour-old `done` is history.
    assert.ok(!texts.join("\n").includes("wA:p2"));
    assert.ok(!texts.join("\n").includes("stale"));
  } finally {
    tg.close();
  }
});

test("nothing sweeps in the background until SWEEP_MINUTES says so", async () => {
  const tg = await fakeTelegram();
  const fx = fixture(); // the key unset, as an untouched .env has it
  try {
    const hook = spawn(process.execPath, [NOTIFY], {
      env: {
        ...process.env,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { pane_id: "wA:p1", agent_status: "done", agent: "claude" } }),
        HERDR_PLUGIN_CONTEXT_JSON: "{}",
        HERDR_PLUGIN_STATE_DIR: fx.stateDir,
        HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
        HERDR_BIN_PATH: fx.herdr,
        TELEGRAM_API_BASE: tg.base,
      },
    });
    let out = "";
    hook.stdout.on("data", (d) => (out += d));
    hook.stderr.on("data", (d) => (out += d));
    await new Promise((resolve) => hook.on("exit", resolve));

    assert.ok(!out.includes("started the reminder sweeper"), out);
    assert.ok(!existsSync(join(fx.stateDir, "sweep.lock")), "a sweeper was started without being asked for");
    assert.equal(tg.sent.length, 1); // the event's own message, and nothing else
  } finally {
    tg.close();
  }
});

test("SWEEP_MINUTES=0 stops the sweeper", async () => {
  const tg = await fakeTelegram();
  const fx = fixture({ sweepMinutes: 0 });
  try {
    const out = await runSweeper(fx, tg.base, { until: () => false, timeoutMs: 10000 });
    assert.match(out, /stopping the sweeper/);
    assert.equal(tg.sent.length, 0);
  } finally {
    tg.close();
  }
});
