#!/usr/bin/env node
// Entry point for herdr-plugin.toml's `mute` action: silences the notifier for a
// while, or lifts the silence if it is already on. Plugin actions take no
// arguments, so one action toggles and MUTE_MINUTES in the config .env decides
// how long — see .env.example.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { herdrBin, loadConfig, toInt } from "./lib.mjs";

const DEFAULT_MINUTES = 60;

// An action fired from the UI needs its answer in the UI, not in a log file.
function announce(title, body) {
  console.log(`herdr-telegram-notify: ${title}${body ? ` — ${body}` : ""}`);
  spawnSync(herdrBin(), ["notification", "show", title, ...(body ? ["--body", body] : []), "--sound", "none"], {
    encoding: "utf8",
    timeout: 4000,
  });
}

const config = loadConfig();
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
if (!stateDir) {
  announce("Telegram notify", "no state directory, so muting has nowhere to be recorded");
  process.exitCode = 1;
} else {
  const path = join(stateDir, "mute.json");
  let until = 0;
  try {
    until = JSON.parse(readFileSync(path, "utf8"))?.until ?? 0;
  } catch {}

  if (until > Date.now()) {
    try {
      unlinkSync(path);
    } catch {}
    announce("🔔 Telegram notify on", "messages are going out again");
  } else {
    const minutes = toInt(config("MUTE_MINUTES"), DEFAULT_MINUTES);
    const ends = Date.now() + minutes * 60 * 1000;
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path, JSON.stringify({ until: ends }));
    } catch (err) {
      announce("Telegram notify", `could not be muted: ${err.message}`);
      process.exitCode = 1;
    }
    if (!process.exitCode) {
      const clock = new Date(ends);
      const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
      announce("🔕 Telegram notify muted", `until ${hhmm} — run the action again to lift it`);
    }
  }
}
