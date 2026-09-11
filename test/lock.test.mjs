// Several copies of the plugin run at once by design — one hook process per
// status change, plus the sweeper and the reply poller — so the interesting
// failures only happen between processes. Everything here starts real ones and
// races them on purpose; a stub of the lock would test nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { flockAvailable, flockHeld, holdFlock, readLines } from "../lib.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const NOTIFY = join(HERE, "..", "notify.mjs");
const LIB = join(HERE, "..", "lib.mjs");

// A Telegram that answers, and remembers everything it was told.
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

function fakeHerdr(dir, panes = []) {
  const snapshot = {
    result: {
      snapshot: {
        workspaces: [],
        panes,
        agents: panes.map((p) => ({ ...p, agent: "claude", agent_status: "done" })),
      },
    },
  };
  const path = join(dir, "herdr");
  writeFileSync(path, `#!/bin/sh\n[ "$1" = api ] || exit 1\ncat <<'JSON'\n${JSON.stringify(snapshot)}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixture(extraEnv = [], panes = []) {
  const root = mkdtempSync(join(tmpdir(), "lock-test-"));
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  mkdirSync(stateDir);
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=123456789:AAtesttesttesttesttesttesttest",
      "TELEGRAM_CHAT_ID=42",
      // Nothing that would need a real herd or a transcript.
      "SHOW_PROJECT=0",
      "SHOW_BRANCH=0",
      "SHOW_CHANGES=0",
      "SHOW_HERD=0",
      "SHOW_LAST_MESSAGE=0",
      "SHOW_TOKENS=0",
      "SHOW_DURATION=0",
      "SHOW_PROMPT=0",
      "SHOW_TITLE=0",
      ...extraEnv,
    ].join("\n")
  );
  chmodSync(join(configDir, ".env"), 0o600);
  return { root, stateDir, configDir, herdr: fakeHerdr(root, panes) };
}

// One hook run, as herdr fires it: a status change on its own pane.
function hook(fx, base, paneId, { wait = true, env = {} } = {}) {
  const child = spawn(process.execPath, [NOTIFY], {
    env: {
      ...process.env,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        data: { pane_id: paneId, agent_status: "done", agent: "claude" },
      }),
      HERDR_PLUGIN_CONTEXT_JSON: "{}",
      HERDR_PLUGIN_STATE_DIR: fx.stateDir,
      HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
      HERDR_BIN_PATH: fx.herdr,
      TELEGRAM_API_BASE: base,
      ...env,
    },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise((resolve) => child.on("exit", () => resolve(out)));
  return wait ? done : { child, done };
}

const lines = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

// ------------------------------------------------------------- the primitive

// A process that takes the lock and then sits on it, for as long as it is told.
function slowHolder(path, holdMs) {
  const child = spawn(process.execPath, [
    "-e",
    `import(${JSON.stringify(LIB)}).then((m) => {
       const release = m.holdFlock(${JSON.stringify(path)});
       if (!release) process.exit(3);
       console.log("held");
       setTimeout(() => { release(); process.exit(0); }, ${holdMs});
     })`,
  ]);
  const held = new Promise((resolve, reject) => {
    child.stdout.on("data", resolve);
    child.on("exit", (code) => reject(new Error(`the holder exited with ${code} before taking the lock`)));
  });
  return { child, held };
}

test("the lock is the kernel's: exclusive while held, gone when the holder dies", async () => {
  assert.ok(flockAvailable(), "these tests need flock(1)");
  const dir = mkdtempSync(join(tmpdir(), "lock-prim-"));
  const path = join(dir, "thing.lock");

  const holder = slowHolder(path, 60_000);
  await holder.held;

  assert.equal(holdFlock(path), undefined, "took a lock another process holds");
  assert.equal(flockHeld(path), true);

  // Killed with no chance to clean up — the crash case. Nobody unlocks
  // anything here; the kernel closes the descriptor and that is the release.
  holder.child.kill("SIGKILL");
  await new Promise((resolve) => holder.child.on("exit", resolve));

  const release = holdFlock(path);
  assert.ok(release, "a lock whose holder was killed was never released");
  assert.equal(flockHeld(path), true);
  release();
  assert.equal(flockHeld(path), false);
});

// Nothing here has a timeout that hands out a lock, and nothing decides a
// holder has had it long enough: a slow holder is still a holder.
test("a live holder that is slow keeps its lock however long it takes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-slow-"));
  const path = join(dir, "slow.lock");
  const holder = slowHolder(path, 40_000);
  await holder.held;

  try {
    const until = Date.now() + 33_000;
    while (Date.now() < until) {
      assert.equal(holdFlock(path), undefined, "took a live holder's lock");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(holder.child.exitCode, null, "the holder was gone; the test proved nothing");
  } finally {
    holder.child.kill("SIGKILL");
  }
});

// The other side of it: a waiter does get the lock, the moment it is free.
test("a waiter gets the lock as soon as the holder lets go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-wait-"));
  const path = join(dir, "wait.lock");
  const holder = slowHolder(path, 1500);
  await holder.held;

  const started = Date.now();
  const release = holdFlock(path, { waitSeconds: 10 });
  const waited = Date.now() - started;
  assert.ok(release, "waiting for a lock that was released got nothing");
  assert.ok(waited > 500, `did not actually wait for the holder (${waited}ms)`);
  release();
  holder.child.kill("SIGKILL");
});

// ------------------------------------------------------------ the queue

test("hooks queueing at the same moment lose nothing", async () => {
  const fx = fixture();
  // Nothing listening on that port: every send fails, so every hook queues.
  const dead = "http://127.0.0.1:1";
  const runs = await Promise.all([...Array(8)].map((_, i) => hook(fx, dead, `wA:p${i}`)));

  const queued = lines(join(fx.stateDir, "pending.jsonl"));
  assert.equal(
    queued.length,
    8,
    `expected all eight messages kept, got ${queued.length}:\n${runs.join("\n").slice(0, 2000)}`
  );
  assert.equal(new Set(queued.map((e) => e.paneId)).size, 8);
});

test("the queue is drained exactly once when several sweeps race", async () => {
  const tg = await fakeTelegram();
  const fx = fixture();
  try {
    writeFileSync(
      join(fx.stateDir, "pending.jsonl"),
      [0, 1, 2]
        .map((i) =>
          JSON.stringify({
            id: `queued-${i}`,
            at: Date.now() - 60_000,
            parts: { emoji: "✅", agent: "claude", statusLabel: `queued-${i}` },
          })
        )
        .join("\n") + "\n"
    );

    // Every one of these flushes the queue before sending its own message.
    await Promise.all([...Array(5)].map((_, i) => hook(fx, tg.base, `wB:p${i}`)));

    const texts = tg.sent.map((m) => m.text);
    for (const i of [0, 1, 2]) {
      const copies = texts.filter((t) => t.includes(`queued-${i}`)).length;
      assert.equal(copies, 1, `queued-${i} was sent ${copies} times:\n${texts.join("\n---\n")}`);
    }
    assert.deepEqual(lines(join(fx.stateDir, "pending.jsonl")), [], "something was left in the queue after it drained");
    // And the five events themselves still all arrived.
    assert.equal(texts.length, 8, texts.join("\n---\n"));
  } finally {
    tg.close();
  }
});

// ------------------------------------------------------- the message map

test("concurrent writers all end up in the message map", async () => {
  const fx = fixture();
  const writers = 6;
  const each = 10;
  await Promise.all(
    [...Array(writers)].map(
      (_, w) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [
            "-e",
            `import(${JSON.stringify(LIB)}).then((m) => {
               for (let i = 0; i < ${each}; i++) {
                 m.rememberMessage(${JSON.stringify(fx.stateDir)}, 1000 + ${w} * 100 + i, "wA:p${w}", { kind: "id", value: "s${w}" });
               }
             })`,
          ]);
          child.on("exit", resolve);
        })
    )
  );

  const map = lines(join(fx.stateDir, "messages.jsonl"));
  assert.equal(map.length, writers * each, `lost ${writers * each - map.length} entries to a lost update`);
  assert.equal(new Set(map.map((e) => e.id)).size, writers * each);
});


// ------------------------------------------------------- nothing runs unlocked

test("a hook that cannot get the sweep lock defers instead of working without it", async () => {
  const tg = await fakeTelegram();
  const fx = fixture();
  const lockPath = join(fx.stateDir, "sweep-run.lock");
  const holder = slowHolder(lockPath, 20_000);
  try {
    await holder.held;
    writeFileSync(
      join(fx.stateDir, "pending.jsonl"),
      JSON.stringify({
        id: "queued-held",
        at: Date.now() - 60_000,
        parts: { emoji: "✅", agent: "claude", statusLabel: "queued-held" },
      }) + "\n"
    );

    const out = await hook(fx, tg.base, "wD:p1");

    // The queue belongs to whoever holds the lock; this run left it alone.
    const texts = tg.sent.map((m) => m.text);
    assert.ok(!texts.join("\n").includes("queued-held"), `the queue was drained without the lock:\n${out}`);
    const log = lines(join(fx.stateDir, "pending.jsonl"));
    assert.deepEqual(log.map((e) => e.id), ["queued-held"], "the queue was rewritten without the lock");
    assert.equal(flockHeld(lockPath), true, "the sweep lock was released by someone who did not hold it");
    // Its own message still goes: being unable to sweep is not being unable to
    // notify, and nothing was silently dropped.
    assert.equal(texts.length, 1, texts.join("\n---\n"));
  } finally {
    holder.child.kill("SIGKILL");
    tg.close();
  }
});

test("a hook that cannot reach Telegram keeps its message, lock or no lock", async () => {
  const fx = fixture();
  const holder = slowHolder(join(fx.stateDir, "sweep-run.lock"), 20_000);
  try {
    await holder.held;
    await hook(fx, "http://127.0.0.1:1", "wD:p2");
    const live = lines(join(fx.stateDir, "pending.jsonl"));
    assert.equal(live.length, 1, "the message was lost rather than kept for later");
    assert.equal(live[0].paneId, "wD:p2");
  } finally {
    holder.child.kill("SIGKILL");
  }
});

// --------------------------------------------------- one session, two panes

test("two panes reporting one session send one message", async () => {
  const tg = await fakeTelegram();
  const session = { kind: "id", value: "session-abc" };
  const fx = fixture([], [
    { pane_id: "wE:p1", workspace_id: "wE", agent_session: session },
    { pane_id: "wE:p2", workspace_id: "wE", agent_session: session },
  ]);
  try {
    const runs = await Promise.all([hook(fx, tg.base, "wE:p1"), hook(fx, tg.base, "wE:p2")]);
    assert.equal(
      tg.sent.length,
      1,
      `one turn was reported twice:\n${runs.join("\n")}\n${tg.sent.map((m) => m.text).join("\n---\n")}`
    );
    assert.equal((runs.join("").match(/already sent for this session/g) ?? []).length, 1);
  } finally {
    tg.close();
  }
});



// ------------------------------------------------------------ without flock

// flock(1) is util-linux, so a machine without it has no way to keep these
// processes off each other's files. The rule then is that nothing shared is
// written at all — not that it is written unlocked.
test("with no flock the notification still goes and nothing shared is written", async () => {
  const tg = await fakeTelegram();
  const fx = fixture(["SWEEP_MINUTES=1", "REPLIES=1"]);
  try {
    const out = await hook(fx, tg.base, "wF:p1", { env: { FLOCK_BIN_PATH: "/nonexistent/flock" } });

    assert.equal(tg.sent.length, 1, `the notification itself was lost:\n${out}`);
    assert.ok(!existsSync(join(fx.stateDir, "messages.jsonl")), "the message map was written without a lock");
    assert.match(out, /not recorded/);
    assert.match(out, /no flock/);
    assert.ok(!out.includes("started the"), "a background process was started with no way to lock it");
  } finally {
    tg.close();
  }
});

test("with no flock a message that cannot be sent is reported, not half-written", async () => {
  const fx = fixture();
  const out = await hook(fx, "http://127.0.0.1:1", "wF:p2", { env: { FLOCK_BIN_PATH: "/nonexistent/flock" } });
  assert.ok(!existsSync(join(fx.stateDir, "pending.jsonl")), "the queue was written without a lock");
  assert.match(out, /could not be kept for later/);
});

// ---------------------------------------------------------- the daemons

test("hooks racing to start the sweeper start exactly one", async () => {
  const tg = await fakeTelegram();
  const fx = fixture(["SWEEP_MINUTES=1", "BLOCKED_REMINDER_MINUTES=0"]);
  const sweepLog = () => {
    try {
      return readFileSync(join(fx.stateDir, "sweep.log"), "utf8");
    } catch {
      return "";
    }
  };
  try {
    const runs = await Promise.all([...Array(6)].map((_, i) => hook(fx, tg.base, `wC:p${i}`)));

    const started = runs.join("").match(/started the reminder sweeper/g) ?? [];
    assert.equal(started.length, 1, `${started.length} hooks started a sweeper`);

    // What the log says is what actually ran, however many were spawned.
    assert.equal(
      (sweepLog().match(/sweeping \(pid/g) ?? []).length,
      1,
      `two sweepers are running:\n${sweepLog()}`
    );
    assert.equal(flockHeld(join(fx.stateDir, "sweep.lock")), true, "the one sweeper is not holding the lock");
  } finally {
    // It says its own pid on the way in; that is how this test stops it,
    // whether or not the assertions above got that far.
    for (const [, pid] of sweepLog().matchAll(/sweeping \(pid (\d+)\)/g)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    tg.close();
  }
});

test("a sweeper started by hand refuses to be the second one", async () => {
  const tg = await fakeTelegram();
  const fx = fixture(["SWEEP_MINUTES=1"]);
  const env = {
    ...process.env,
    HERDR_PLUGIN_STATE_DIR: fx.stateDir,
    HERDR_PLUGIN_CONFIG_DIR: fx.configDir,
    HERDR_BIN_PATH: fx.herdr,
    TELEGRAM_API_BASE: tg.base,
  };
  const first = spawn(process.execPath, [NOTIFY, "--sweep"], { env });
  try {
    await new Promise((resolve, reject) => {
      let out = "";
      first.stdout.on("data", (d) => {
        out += d;
        if (out.includes("sweeping (pid")) resolve();
      });
      setTimeout(() => reject(new Error(`the first sweeper never started:\n${out}`)), 10_000);
    });

    const second = spawn(process.execPath, [NOTIFY, "--sweep"], { env });
    let out = "";
    second.stdout.on("data", (d) => (out += d));
    // It has to give up on its own; a second sweeper that settles in and starts
    // polling is the failure, so waiting for ever on it is not an option.
    await new Promise((resolve, reject) => {
      const bomb = setTimeout(() => {
        second.kill("SIGKILL");
        reject(new Error(`the second sweeper kept running:\n${out}`));
      }, 10_000);
      second.on("exit", () => {
        clearTimeout(bomb);
        resolve();
      });
    });
    assert.match(out, /already running/);
    assert.ok(first.exitCode === null, "the second sweeper stopped the first one");

    // The one that is running holds the lock, and the kernel takes it back the
    // moment it is gone — no cleanup on the way out, nothing left to reclaim.
    assert.equal(flockHeld(join(fx.stateDir, "sweep.lock")), true);
    first.kill("SIGKILL");
    await new Promise((resolve) => first.on("exit", resolve));
    assert.equal(flockHeld(join(fx.stateDir, "sweep.lock")), false, "a dead sweeper's lock was not released");
  } finally {
    first.kill("SIGKILL");
    tg.close();
  }
});
