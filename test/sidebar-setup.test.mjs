// Config edits are tested as text and against a fake CLI, never the live client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hasSidebarToken, herdrConfigPath, setupSidebar } from "../sidebar.mjs";

const action = fileURLToPath(new URL("../sidebar.mjs", import.meta.url));
const agents = '[ui.sidebar.agents]\nrows = [["state_icon", "machine", "workspace", "tab"], ["$telegram"], ["agent"]]\n';
const spaces = '[ui.sidebar.spaces]\nrows = [["state_icon", "workspace"], ["$telegram"], ["branch", "git_status"]]\n';
const baseSpaces = '[ui.sidebar.spaces]\nrows = [["state_icon", "workspace"], ["branch", "git_status"]]\n';

function changed(source, expected) {
  const result = setupSidebar(source);
  assert.equal(result.changed, true);
  assert.equal(result.text, expected);
  assert.deepEqual(result.notes, []);
  assert.equal(setupSidebar(result.text).changed, false);
}

test("sidebar config paths follow Herdr's override, XDG and HOME precedence", () => {
  const home = join(tmpdir(), "example-home");
  const xdg = join(tmpdir(), "example-xdg");
  const override = join(tmpdir(), "example-override.toml");
  assert.equal(herdrConfigPath({ HOME: home }), join(home, ".config", "herdr", "config.toml"));
  assert.equal(herdrConfigPath({ HOME: home, XDG_CONFIG_HOME: xdg }), join(xdg, "herdr", "config.toml"));
  assert.equal(herdrConfigPath({ HOME: home, XDG_CONFIG_HOME: xdg, HERDR_CONFIG_PATH: override }), override);
  assert.equal(herdrConfigPath({}), join(tmpdir(), "herdr", "config.toml"));
  assert.equal(herdrConfigPath({ HERDR_CONFIG_PATH: "" }), "");
});

test("no file, an empty file and unrelated tables get complete default layouts without losing bytes", () => {
  changed(undefined, agents + "\n" + spaces);
  changed("", agents + "\n" + spaces);
  const unrelated = '# Keep this comment.\n[theme]\nname = "terminal" # a retained suffix';
  changed(unrelated, unrelated + "\n\n" + agents + "\n" + spaces);
  const quoted = '[ui]\nwindow_title = """\n[ui.sidebar.agents]\nrows = [["not a header"]]\n"""\n';
  changed(quoted, quoted + "\n" + agents + "\n" + spaces);
});

test("single-line and multiline rows get a separate token row after the first and keep trailing markers", () => {
  const single = '[ui.sidebar.agents]\nrows = [["state_icon", "tab"], ["agent"]] # some-plugin-managed-row\n';
  changed(single + baseSpaces, single.replace('["state_icon", "tab"]', '["state_icon", "tab"], ["$telegram"]') + spaces);
  const multi = '[ui.sidebar.agents]\nrows = [\n  ["state_icon", "tab"], # first row\n  [\'agent\'],\n] # another retained marker\n';
  changed(multi + baseSpaces, multi.replace('["state_icon", "tab"]', '["state_icon", "tab"], ["$telegram"]') + spaces);
});

test("the first row scanner respects nested rule arrays, escapes, literal strings and comments", () => {
  const first = '["state_icon", { token = "tab", rules = [{ contains = "a ] and # and \\\" quote", fg = "#abc" }] }, \'workspace ]\']';
  const source = '[ui.sidebar.agents]\nrows = [\n  ' + first + ', # ] is only a comment\n  ["agent"],\n]\n';
  changed(source + baseSpaces, source.replace(first, first + ', ["$telegram"]') + spaces);
});

test("missing rows are added below their headers, and missing spaces are appended", () => {
  const source = '[ui.sidebar.agents] # header marker\nrow_gap = 1\n[ui.sidebar.spaces]\nrow_gap = 0\n';
  changed(source, source.replace(' # header marker\n', ' # header marker\n' + agents.split("\n")[1] + '\n')
    .replace('[ui.sidebar.spaces]\n', spaces));
  changed('[ui.sidebar.agents]', agents + "\n" + spaces);
  const crlf = '[ui.sidebar.agents]\r\nrow_gap = 1\r\n';
  changed(crlf, agents.replace(/\n/g, "\r\n") + 'row_gap = 1\r\n\r\n' + spaces.replace(/\n/g, "\r\n"));
});

test("all rows_by_agent layouts get a token row, including quoted keys and multiline values", () => {
  const source = '[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"], ["tab"]] # keep\n"codex" = [\n  ["workspace"],\n  ["agent"],\n]\npi = [[\'tab\']]\n';
  changed(source, source.replace('["agent"], ["tab"]', '["agent"], ["$telegram"], ["tab"]')
    .replace('["workspace"],\n', '["workspace"], ["$telegram"],\n')
    .replace("[['tab']]", "[['tab'], [\"$telegram\"]]") + "\n" + agents + "\n" + spaces);
});

test("an existing token in any sidebar rows value leaves every byte alone", () => {
  for (const source of [
    agents,
    spaces,
    '[ui.sidebar.agents.rows_by_agent]\nclaude = [["$telegram"]]\n',
    '[ui.sidebar.agents]\nrows = [[{ token = "$telegram", bold = true }]]\n',
    '[ui.sidebar.agents]\nrows = [[\'$telegram\']]\n',
    '[ui.sidebar.agents]\nrows = [["\\u0024telegram"]]\n',
  ]) {
    assert.equal(hasSidebarToken(source), true);
    const result = setupSidebar(source);
    assert.equal(result.changed, false);
    assert.equal(result.text, source);
    assert.match(result.notes.join("\n"), /already set up/);
  }
  assert.equal(hasSidebarToken('# rows = [["$telegram"]]\n[theme]\nname = "$telegram"\n'), false);
});

test("unparseable or mixed rows stay entirely untouched and give the exact manual row", () => {
  for (const value of ['"not an array"', '["agent"]', '[]', '[["agent"], "tab"]', '[["agent"]', '[["agent"]] extra']) {
    const source = `[ui.sidebar.agents]\nrows = ${value}\n`;
    const result = setupSidebar(source);
    assert.equal(result.text, source, value);
    assert.equal(result.changed, false, value);
    assert.ok(result.notes.some((note) => note.includes('["$telegram"]')), value);
  }
});

function runAction({ fails = false, source = '# Original config.\n[theme]\nname = "terminal"\n', symlink = false, missing = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sidebar-setup-test-"));
  const client = join(root, "client");
  mkdirSync(client);
  const config = join(client, "config.toml");
  const target = symlink ? join(client, "layout.toml") : config;
  if (!missing) {
    writeFileSync(target, source);
    chmodSync(target, 0o640);
  }
  if (symlink) symlinkSync("layout.toml", config);
  const log = join(root, "argv.jsonl");
  const herdr = join(root, "herdr");
  writeFileSync(herdr, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "config" && args[1] === "check") {
  const file = process.env.HERDR_CONFIG_PATH;
  if (!fs.readFileSync(file, "utf8").includes('["$telegram"]')) process.exit(2);
  if (!fs.readdirSync(${JSON.stringify(client)}).some((name) => name.startsWith("config.toml.bak-"))) process.exit(3);
  process.exit(${fails ? 1 : 0});
}
if (args[0] !== "notification") process.exit(4);
console.log(JSON.stringify({ result: {} }));
`, { mode: 0o755 });
  const entry = symlink ? join(root, "sidebar.mjs") : action;
  if (symlink) symlinkSync(action, entry);
  const result = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 15000, env: {
    ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), HERDR_CONFIG_PATH: config, HERDR_BIN_PATH: herdr,
  } });
  const backups = readdirSync(client).filter((name) => name.startsWith("config.toml.bak-"));
  return { ...result, source, config, target, client, backups,
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [] };
}

test("the sidebar action backs up, preserves mode and validates before announcing a client reload", () => {
  for (const symlink of [false, true]) {
    const fx = runAction({ symlink });
    assert.equal(fx.status, 0, fx.stdout + fx.stderr);
    assert.equal(readFileSync(fx.config, "utf8"), setupSidebar(fx.source).text);
    assert.equal(fx.backups.length, 1);
    assert.equal(readFileSync(join(fx.client, fx.backups[0]), "utf8"), fx.source);
    assert.equal(statSync(fx.config).mode & 0o777, 0o640);
    assert.equal(statSync(join(fx.client, fx.backups[0])).mode & 0o777, 0o640);
    if (symlink) assert.equal(lstatSync(fx.config).isSymbolicLink(), true);
    assert.deepEqual(fx.calls[0], ["config", "check"]);
    const notification = fx.calls.find((args) => args[0] === "notification");
    for (const text of [fx.stdout, notification.join(" ")]) {
      assert.match(text, /reload config from the Herdr menu \(or your reload_config key\)/);
      assert.match(text, /client machine's config/);
    }
    assert.equal(readdirSync(fx.client).some((name) => name.includes(".tmp-")), false);
  }
});

test("a failed config check restores the backup, keeps its mode and reports the failure", () => {
  const fx = runAction({ fails: true });
  assert.equal(fx.status, 1, fx.stdout + fx.stderr);
  assert.equal(readFileSync(fx.config, "utf8"), fx.source);
  assert.equal(statSync(fx.config).mode & 0o777, 0o640);
  assert.equal(fx.backups.length, 1);
  assert.equal(readFileSync(join(fx.client, fx.backups[0]), "utf8"), fx.source);
  assert.match(fx.stdout, /config check failed; restored the previous config/);
  assert.match(fx.calls.at(-1).join(" "), /config check failed; restored/);
  assert.equal(readdirSync(fx.client).some((name) => name.includes(".tmp-")), false);
});

test("an absent config gets safe defaults, and a failed check restores its absence", () => {
  for (const fails of [false, true]) {
    const fx = runAction({ missing: true, fails });
    assert.equal(fx.status, fails ? 1 : 0, fx.stdout + fx.stderr);
    assert.equal(fx.backups.length, 1);
    assert.equal(readFileSync(join(fx.client, fx.backups[0]), "utf8"), "");
    assert.equal(existsSync(fx.config), !fails);
    if (!fails) {
      assert.equal(readFileSync(fx.config, "utf8"), setupSidebar().text);
      assert.equal(statSync(fx.config).mode & 0o777, 0o600);
    }
  }
});

test("an already configured action only announces and writes no backup", () => {
  const fx = runAction({ source: agents });
  assert.equal(fx.status, 0, fx.stdout + fx.stderr);
  assert.equal(readFileSync(fx.config, "utf8"), agents);
  assert.deepEqual(fx.backups, []);
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0][0], "notification");
  assert.match(fx.stdout, /already set up/);
});
