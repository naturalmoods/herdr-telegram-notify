#!/usr/bin/env node
// Entry point for herdr-plugin.toml's `mute` action: silences the notifier for a
// while, or lifts the silence if it is already on. Plugin actions take no
// arguments, so one action toggles and MUTE_MINUTES in the config .env decides
// how long — see .env.example. The bot's /mute command says a length instead and
// writes the same file; see replies.mjs.

import { MUTE_DEFAULT_MINUTES, clockTime, loadConfig, mutedUntil, reportSidebarToken, setMute, showNotification, toInt } from "./lib.mjs";

// An action fired from the UI needs its answer in the UI, not in a log file.
const announce = showNotification;

const config = loadConfig();
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
if (!stateDir) {
  announce("Telegram notify", "no state directory, so muting has nowhere to be recorded");
  process.exitCode = 1;
} else if (mutedUntil(stateDir)) {
  try {
    setMute(stateDir, 0);
    void reportSidebarToken("workspace", undefined, undefined, { cfg: config });
    announce("🔔 Telegram notify on", "messages are going out again");
  } catch (err) {
    announce("Telegram notify", `could not be unmuted: ${err.message}`);
    process.exitCode = 1;
  }
} else {
  const ends = Date.now() + toInt(config("MUTE_MINUTES"), MUTE_DEFAULT_MINUTES) * 60 * 1000;
  try {
    setMute(stateDir, ends);
    void reportSidebarToken("workspace", undefined, `🔕 until ${clockTime(new Date(ends))}`, { expiresAt: ends, cfg: config });
    announce("🔕 Telegram notify muted", `until ${clockTime(new Date(ends))} — run the action again to lift it`);
  } catch (err) {
    announce("Telegram notify", `could not be muted: ${err.message}`);
    process.exitCode = 1;
  }
}
