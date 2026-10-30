# herdr-core (the Herdr app)

The Herdr app runs its agents in [herdr-core](https://herdr.dev/core/) (`hc`),
not in Herdr TUI's server. herdr-core has no plugin hooks, so the plugin
cannot be installed into it. `daemon.mjs` stands in for the hooks: it follows
`hc events` and runs the same notifier on every status change and closed
terminal. The message, replies, commands, the sweeper and the board are the
same code as under Herdr TUI.

The two runtimes don't share agents. If you use both, run the TUI plugin for
Herdr TUI and the daemon for the app.

## Where it runs

On the machine where the agents run, next to its core. When the app window is
on another computer (say Windows) and the agents run on a Linux box added as a
machine, run the daemon on the Linux box. It keeps notifying while the window
is closed or that computer is off, because herdr-core keeps running.

It follows only this machine's terminals. Terminals on machines this core
added (`box/t7`) belong to the daemon running there. Helpers an agent started
with `hc run` (terminals with a parent) are left out.

## Setup

Requirements: herdr-core, Node 18+, Linux or macOS, `flock` (util-linux).

```sh
git clone https://github.com/naturalmoods/herdr-telegram-notify ~/.local/share/herdr-telegram-notify
mkdir -p ~/.config/herdr-telegram-notify
cp ~/.local/share/herdr-telegram-notify/.env.example ~/.config/herdr-telegram-notify/.env
chmod 600 ~/.config/herdr-telegram-notify/.env
```

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in that `.env`, as in the
README. Then check it:

```sh
node ~/.local/share/herdr-telegram-notify/daemon.mjs doctor
```

### As a systemd user service

`contrib/herdr-telegram-notify.service`:

```sh
mkdir -p ~/.config/systemd/user
cp ~/.local/share/herdr-telegram-notify/contrib/herdr-telegram-notify.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now herdr-telegram-notify
journalctl --user -u herdr-telegram-notify -f
```

To keep it running after you log out: `loginctl enable-linger $USER`.
Edit the unit if `node` or `hc` is not on the service's PATH, or set
`HC_BIN_PATH` there.

### Claude Code sessions

herdr-core reports no agent session, so the daemon can only take the program in
the terminal for the session. Claude Code can tell it the real one: add
`contrib/claude-session-hook.sh` to `SessionStart` in `~/.claude/settings.json`,
merging it into what is already there.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          { "type": "command", "command": "~/.local/share/herdr-telegram-notify/contrib/claude-session-hook.sh" }
        ]
      }
    ]
  }
}
```

The hook labels the terminal `claude.session=<pid>:<session id>` and does
nothing without `HC_TERMINAL_ID` or `hc`, so it is harmless under Herdr TUI.
With the label, replies stay with the conversation across `/clear`, and two
Claude agents in one folder keep their own transcript.

## Directories

| What | Default | Override |
|---|---|---|
| config (`.env`) | `~/.config/herdr-telegram-notify` | `HERDR_PLUGIN_CONFIG_DIR` |
| state | `~/.local/state/herdr-telegram-notify` | `HERDR_PLUGIN_STATE_DIR` |
| `hc` | `~/.local/bin/hc`, `/usr/local/bin/hc`, PATH | `HC_BIN_PATH` |

## What is different from Herdr TUI

- **Names.** Spaces and tabs come from the app's document on this core. A
  space nobody named is called after its repo, as in the app.
- **Status.** herdr-core reports `error` as well. Add it to `NOTIFY_STATUSES`
  to hear about it. A blocked agent that says why shows it:
  `blocked (permission)`.
- **Where to find it.** The 🖥 line says `hc attach t3`.
- **Sessions.** herdr-core reports no agent session. With the
  [Claude Code hook](#claude-code-sessions), Claude Code's own session id is
  the session: a `/clear` starts a new one, and a label left by an earlier
  program in the pane is ignored. Without the hook, the program running in the
  terminal is the session: a reply goes to the agent the notification was
  about, and is refused once that program has quit and another started, but a
  `/clear` inside the same agent is not noticed.
- **Transcripts.** Found where the agent keeps them: Claude Code by the
  folder or by the id the [hook](#claude-code-sessions) labels it with, Codex
  by the folder its rollout names. Only files written since the terminal
  started count. Two Claude agents in one folder share one transcript folder:
  without the hook neither gets a transcript (no last message, duration or
  cost), rather than the wrong one; with it, each has its own id and its own
  transcript. pi transcripts are not found yet.
- **/new** starts the program in a new tab of the space, from the space's
  folder. Only names in `CORE_AGENT_KINDS` are started. `@branch` worktrees
  are not supported yet.
- **/stop** uses `hc interrupt` (Esc for agents that report status).
- **Mute.** `node daemon.mjs mute`, or `/mute` from the chat.

## Sidebar

The app has no sidebar tokens of its own, so the daemon publishes the same
state as terminal labels and a mod draws them: a one-line band at the bottom of
the window with the latest 📨 notification, 📱 input from the phone, and 🔕 mute.

Install it on the computer where the app window runs, from the clone:

```sh
mkdir -p ~/.config/herdr-app/mods
cp -r ~/.local/share/herdr-telegram-notify/contrib/herdr-app/telegram ~/.config/herdr-app/mods/telegram
herdr-app check ~/.config/herdr-app/mods/telegram
```

The app docks a new mod where its `mod.json` says: bottom, 28 px. A click on
an agent's entry focuses its terminal.

The labels are `telegram` and `telegram.expires` (epoch ms) on a pane, and
`telegram.mute` and `telegram.mute.expires` on every agent while muted;
clearing removes them. `SIDEBAR_TOKENS=0` turns the reporting off here too, and
the band drops an entry whose expiry has passed even if its label is still set.

## Telegram bots

One bot per machine with replies on, as under Herdr TUI: two pollers on one
bot take each other's updates. If the same machine also runs the TUI plugin
with `REPLIES=1`, give the daemon its own bot.
