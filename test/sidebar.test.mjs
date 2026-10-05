// Metadata uses a fake CLI even when the test runs inside a live Herdr session.
// Its sequence gate models the server accepting late RPCs without applying them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULTS, SIDEBAR_TTL_MAX_MS, configProblems, reportSidebarToken } from "../lib.mjs";

function fixture(config = "") {
  const root = mkdtempSync(join(tmpdir(), "sidebar-test-"));
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  mkdirSync(stateDir);
  mkdirSync(configDir);
  writeFileSync(join(configDir, ".env"), `MUTE_MINUTES=2\n${config}`, { mode: 0o600 });
  const herdr = join(root, "herdr");
  const log = join(root, "argv.jsonl");
  const metadata = join(root, "metadata.json");
  writeFileSync(herdr, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const ok = () => console.log(JSON.stringify({ result: {} }));
if (args[0] === "api") {
  console.log(JSON.stringify({ result: { snapshot: { workspaces: [
    { workspace_id: "wA", label: "storefront" }, { workspace_id: "wB", label: "docs" }
  ] } } }));
} else if (args[1] === "report-metadata") {
  const seq = args[args.indexOf("--seq") + 1];
  const delayed = seq === "1" || seq === "3";
  setTimeout(() => {
    const path = ${JSON.stringify(metadata)};
    const state = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
    const key = args[0] + ":" + args[2];
    if (BigInt(seq) > BigInt(state[key]?.seq ?? -1)) {
      state[key] = { seq, value: args.includes("--token") ? args[args.indexOf("--token") + 1] : undefined };
      fs.writeFileSync(path, JSON.stringify(state));
    }
    ok();
  }, delayed ? 300 : 0);
} else ok();
`, { mode: 0o755 });
  return { root, herdr, stateDir, configDir,
    argv: () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
    metadata: () => JSON.parse(readFileSync(metadata, "utf8")) };
}

const cfg = (key) => DEFAULTS[key];

test("sidebar tokens default on, validate booleans and reject invalid settings", () => {
  assert.equal(DEFAULTS.SIDEBAR_TOKENS, "1");
  for (const value of ["1", "true", "YES", "on", "0", "false", "NO", "off"]) {
    assert.deepEqual(configProblems((key) => key === "SIDEBAR_TOKENS" ? value : DEFAULTS[key]), []);
  }
  const problems = configProblems((key) => key === "SIDEBAR_TOKENS" ? "sometimes" : DEFAULTS[key]);
  assert.deepEqual(problems.map((problem) => problem.key), ["SIDEBAR_TOKENS"]);
  assert.match(problems[0].detail, /sidebar reporting is off/);
});

test("sidebar RPCs are asynchronous and stale clears and sets cannot undo newer reports", async () => {
  const fx = fixture();
  const saved = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = fx.herdr;
  try {
    const oldClear = reportSidebarToken("pane", "wA:p1", undefined, { seq: "1", cfg });
    assert.ok(oldClear instanceof Promise);
    await Promise.all([oldClear, reportSidebarToken("pane", "wA:p1", "latest set", { seq: "2", cfg })]);
    await Promise.all([
      reportSidebarToken("pane", "wA:p2", "old set", { seq: "3", cfg }),
      reportSidebarToken("pane", "wA:p2", undefined, { seq: "4", cfg }),
    ]);
    assert.equal(fx.metadata()["pane:wA:p1"].value, "telegram=latest set");
    assert.equal(fx.metadata()["pane:wA:p2"].value, undefined);
    assert.equal(fx.argv().length, 4);
    await reportSidebarToken("pane", "wA:p3", "generated one", { cfg });
    await reportSidebarToken("pane", "wA:p3", "generated two", { cfg });
    const generated = fx.argv().slice(-2).map((a) => BigInt(a[a.indexOf("--seq") + 1]));
    assert.ok(generated[1] > generated[0]);
  } finally {
    if (saved === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = saved;
  }
});

test("the mute action reports and clears all snapshot workspaces, with supported TTLs", () => {
  const mute = fileURLToPath(new URL("../mute.mjs", import.meta.url));
  for (const config of ["", "MUTE_MINUTES=2880\n", "SIDEBAR_TOKENS=0\n", "DRY_RUN=1\n"]) {
    const fx = fixture(config);
    const run = () => spawnSync(process.execPath, [mute], { encoding: "utf8", timeout: 15_000, env: {
      ...process.env, SIDEBAR_TOKENS: undefined, DRY_RUN: undefined, DEBUG: undefined, MUTE_MINUTES: undefined,
      HERDR_BIN_PATH: fx.herdr, HERDR_PLUGIN_CONFIG_DIR: fx.configDir, HERDR_PLUGIN_STATE_DIR: fx.stateDir,
    } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const until = JSON.parse(readFileSync(join(fx.stateDir, "mute.json"), "utf8")).until;
    const sets = fx.argv().filter((a) => a[1] === "report-metadata");
    const disabled = config.includes("SIDEBAR_TOKENS=0") || config.includes("DRY_RUN=1");
    assert.equal(sets.length, disabled ? 0 : 2);
    for (const set of sets) {
      assert.match(set[set.indexOf("--token") + 1], /^telegram=🔕 until \d\d:\d\d$/);
      const ttl = Number(set[set.indexOf("--ttl-ms") + 1]);
      if (config.includes("2880")) assert.equal(ttl, SIDEBAR_TTL_MAX_MS);
      else assert.ok(ttl >= until - Date.now() && ttl <= 120_000);
    }
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    const clears = fx.argv().filter((a) => a[1] === "report-metadata" && a.includes("--clear-token"));
    assert.deepEqual(clears.map((a) => a[2]).sort(), disabled ? [] : ["wA", "wB"]);
    assert.ok(clears.every((a) => a[a.indexOf("--clear-token") + 1] === "telegram"));
  }
});
