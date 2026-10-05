# herdr-telegram-notify

A Herdr plugin that messages you on Telegram when an agent finishes or needs
input, and lets you answer that agent from the chat.

## Features

- [Notifications](docs/guide.md#the-message): title, prompt, changes, timing, usage and the last response from Claude Code, Codex or pi.
- [Replies and buttons](docs/guide.md#replies-and-commands): answer the notified agent, with session and stale-question checks.
- [Files and photos](docs/guide.md#files-and-photos) and [voice](docs/guide.md#voice-messages): send attachments or locally transcribed speech.
- [Remote commands](docs/guide.md#commands): stop work, read a screen or diff, download a response, or start an agent in a tab or worktree.
- [A current chat](docs/guide.md#keeping-the-chat-current): resolved notifications and an optional pinned herd board.
- [Sidebar state](docs/guide.md#sidebar-tokens): notification, phone-input and mute badges at the desk.
- [Noise control](docs/guide.md#noise-control): quiet hours, short-turn filtering, blocked delays, workspace filters and muting.
- [Best-effort secret masking](docs/guide.md#secret-masking), [retries and reminders](docs/guide.md#failed-sends-and-the-sweeper), and [doctor](docs/guide.md#doctor).

## Requirements

Herdr 0.8+, Node 18+, Linux or macOS; the launcher finds Node outside the shell's PATH.
Linux: util-linux's `flock`. macOS: `brew install util-linux` (or `brew install flock`).

## Install

```sh
herdr plugin install naturalmoods/herdr-telegram-notify --yes
```

For a local checkout, run `herdr plugin link .` instead.

## Setup

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and keep the token private.
2. Open your new bot, press Start and send a message. Read the chat id with your token:

   ```sh
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
   ```

   For groups and forum topics, see [setup](docs/guide.md#configure).
3. Find the plugin's config directory:

   ```sh
   herdr plugin config-dir naturalmoods.herdr-telegram-notify
   ```

   Create `.env` there with:

   ```dotenv
   TELEGRAM_BOT_TOKEN=<your bot token>
   TELEGRAM_CHAT_ID=<your chat id>
   ```

4. Restrict access and check the setup:

   ```sh
   chmod 600 "$(herdr plugin config-dir naturalmoods.herdr-telegram-notify)/.env"
   herdr plugin action invoke doctor --plugin naturalmoods.herdr-telegram-notify
   ```

Doctor sends a silent test message; its report is in `herdr plugin log list`.
All other settings are optional: see [`.env.example`](.env.example) and the
[complete guide](docs/guide.md). Telegram bot chats are not end-to-end encrypted;
secret masking is not a guarantee.

## Turn on replies

Set `REPLIES=1` in `.env`, then reply to a notification in Telegram. The poller
starts when Herdr starts or on the next agent status change, and registers the
commands menu automatically. A blocked agent gets typed input and Enter;
other agents get a new turn. [Reply rules and limits](docs/guide.md#replies-and-commands).

- Only the configured `TELEGRAM_CHAT_ID` is listened to.
- In groups, set `REPLY_ALLOWED_USER_IDS` to trusted Telegram user ids; otherwise every member can control agents, including starting them and creating worktrees.
- Use one bot per machine with replies enabled. Send-only machines may share a bot.

## Commands

All commands need `REPLIES=1` and use the chat and sender allowlist above.
`/full`, `/stop`, `/screen` and `/diff` must reply to a notification.

| Command | Result |
| --- | --- |
| `/status` | List agents and their states. |
| `/mute [minutes]` | Mute for the configured duration (default 60), or the supplied minutes. |
| `/unmute` | Turn notifications back on. |
| `/full` | Download the saved response before message truncation. |
| `/stop` | Send Esc to a working or blocked agent, without quitting it. |
| `/screen` | Read up to 40 cropped lines of the agent's current screen. |
| `/diff` | Download staged and unstaged changes; list untracked names only. |
| `/new <workspace>[@<branch>] <kind> [prompt]` | Start an agent in a background tab, or its own Git worktree. |

[Command details, safety checks and limits](docs/guide.md#commands).

## Sidebar

Run `herdr plugin action invoke sidebar --plugin naturalmoods.herdr-telegram-notify`.
Then reload config from the Herdr menu (or your `reload_config` key).
Over SSH, run it where the Herdr window runs: the layout belongs to the **client machine's config**, not the server's. [Details](docs/guide.md#sidebar-tokens).

## Upgrading

Reinstall with the install command above, or `git pull` in a linked checkout.
Stop the old poller and sweeper so they load the new code:

```sh
pkill -f replies.mjs
pkill -f 'notify.mjs --sweep'
```

They restart on the next status change or Herdr start when enabled.
[Upgrade details](docs/guide.md#upgrading).

## Full reference

[docs/guide.md](docs/guide.md) covers every setting, limitation and example,
including topics, attachment and voice setup, the sweeper, troubleshooting and testing.
The repo also includes a [setup skill](.claude/skills/herdr-telegram-notify/SKILL.md).

## Uninstall

```sh
herdr plugin uninstall naturalmoods.herdr-telegram-notify
```
