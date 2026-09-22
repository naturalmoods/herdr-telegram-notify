# herdr-telegram-notify

A Herdr plugin that sends a Telegram message when an agent finishes (`done`)
or needs input (`blocked`). Each message tells you which agent it was, what it
worked on, and what it said.

You can also reply from Telegram, check agent status with `/status`, mute
notifications with `/mute`, and download a notification's saved response with
`/full`. Set `REPLIES=1` to enable replies and commands; they are off by default.
See [Replying from the chat](#replying-from-the-chat) and [Commands](#commands).

Requires Herdr 0.8 or newer, Node 18+, and Linux. Herdr's server does not inherit
your shell's PATH, so `run.sh` locates Node itself, including nvm, fnm, volta and
mise installs.

Linux is required for `flock(1)` from util-linux. Hook processes, the reply
poller and the sweeper share a state directory and use kernel locks to protect
it. These locks are released when a process dies. Without `flock`, notifications
still send, but failed messages are not queued, replies cannot be routed, and
neither background process starts. `doctor` checks for it.

## Install

```
herdr plugin install naturalmoods/herdr-telegram-notify --yes
```

### Letting Claude Code do it

The repo includes a setup skill. From a clone, copy it into your skills directory
and ask your agent to set up the plugin:

```
cp -r .claude/skills/herdr-telegram-notify ~/.claude/skills/
```

If you installed the plugin instead, `herdr plugin list` prints its directory.
The skill is under `.claude/skills/herdr-telegram-notify` there too.

The skill covers the token, chat id, `doctor`, reply poller and reply
troubleshooting. The manual steps follow below.

## Configure

```
herdr plugin config-dir naturalmoods.herdr-telegram-notify
```

Create a `.env` file in that directory (see `.env.example`) with:

```
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat id>
```

All other settings are optional. `.env` is gitignored; keep the token in the
config directory, not in this repo.

Your default umask determines the file's permissions, which may allow other
users to read it. Anyone with the token can post as your bot. Restrict access:

```
chmod 600 "$(herdr plugin config-dir naturalmoods.herdr-telegram-notify)/.env"
```

The plugin warns on stderr whenever it reads a `.env` that other users can read.
You can find the warning in `herdr plugin log list`.

### Getting a bot token and a chat id

1. Create the bot. In Telegram, open [@BotFather](https://t.me/BotFather) and
   send `/newbot`. Choose a display name and a username ending in `bot`.
   BotFather returns a token like `123456789:AAG…`. Use it as
   `TELEGRAM_BOT_TOKEN` and treat it as a password.
2. Open your new bot and press Start, or send it a message. Without this step,
   sends fail with `403: bot can't initiate conversation with a user`.
3. Read the chat id using your token:

   ```
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
   ```

   Use the returned number as `TELEGRAM_CHAT_ID`. It is positive for a private
   chat and negative for a group (often starting with `-100`). If `getUpdates`
   returns `{"ok":true,"result":[]}`, send the bot a fresh message and try
   again. Telegram drops pending updates after about 24 hours.

For a group, add the bot and send `/start@yourbotname` there. Group privacy mode
hides ordinary messages from bots; an addressed command makes the chat appear
in `getUpdates`.

### A topic per workspace

In a group with Topics enabled, use `TELEGRAM_TOPICS` to send each workspace's
notifications to a separate thread:

```
TELEGRAM_TOPICS=storefront:12,billing-service:15,wB:15
TELEGRAM_TOPIC_ID=7
```

Each pair is `label-or-id:topic`. `TELEGRAM_TOPIC_ID` is the fallback for unlisted
workspaces. With neither setting, messages go to the group's General topic.
To find a topic's id, open it in Telegram Web and read the number at the end of
the URL.

## Replying from the chat

Set `REPLIES=1` in `.env`, then reply to a notification in Telegram to send text
to that agent.

```
⚠️ claude · blocked
▸ bump the dependencies and see if anything breaks
📁 storefront · main · ~/projects/storefront

  Do you want to make this edit?
  ❯ 1. Yes
    2. No, tell Claude what to do differently

      ↳  you: 1
      ↳  bot: → typed into wC:p4
```

For a blocked agent, the plugin types the reply and presses Enter, so `1` picks
the first option. Other agents receive the reply as a new turn.

Reply routing has these restrictions:

- Messages must come from `TELEGRAM_CHAT_ID`. The plugin ignores other chats
  without answering.
- Text must reply to a notification less than a day old. You cannot choose a
  target pane by typing its id into the chat. The bot explains when a message
  is not a reply or the notification has expired.
- The original agent session must still be running in that pane. The plugin
  refuses replies if the session has changed, the agent has left, or the
  notification predates session tracking.
- Blocked replies must match the recorded waiting episode and screen. The
  plugin refuses them if the question changes, the agent leaves that waiting
  episode, or the screen could not be recorded. This also prevents an old
  approval from becoming a new turn after the agent moves on. Screen redraws
  can cause a refusal even if the question looks unchanged.

  Checking and typing are separate operations. Answering at the keyboard
  between those steps can still send the Telegram reply to the next prompt.
- `REPLY_ALLOWED_USER_IDS` optionally limits replies to a comma-separated list
  of Telegram user ids. By default, anyone in the configured chat can reply.
  Set this in groups if only certain members should control agents.
  With an allowlist, anonymous group admins and channel posts are also refused:
  they arrive as `sender_chat`, without an identifiable user id.
  `@userinfobot` can tell you your id.

The bot confirms which pane received a reply or explains why Herdr refused it.
Messages from the wrong chat or outside the allowlist get no answer.

The reply poller runs in a separate process. It starts on the next status change
after you enable `REPLIES` and stops on the next poll after you disable it.
It rereads `REPLIES`, `TELEGRAM_CHAT_ID` and `REPLY_ALLOWED_USER_IDS` once
before each poll and again when the poll returns, so removing someone from the
allowlist takes their access away without a restart, even mid-poll. Turning
`REPLIES` off during a poll drops what that poll returns rather than delivering
it at the next start.
A lock allows only one poller at a time. Check it with
`herdr plugin action invoke doctor`; its log is `replies.log` in the state
directory.

Use a separate bot for each machine that has `REPLIES=1`. Telegram hands each
update to only one reader of a bot, and each machine records only its own
notifications, so with a shared bot a reply can reach the machine that did not
send the notification and be refused. `replies.log` shows the conflict as a
`409` from `getUpdates`. Machines that only send notifications can share a bot.

### Commands

Commands require `REPLIES=1` and use the same chat and user allowlist as replies.
Responses return to the forum topic where you asked.

| Command | Result |
| --- | --- |
| `/status` | List agents with their workspace, state and pane id. |
| `/mute` | Mute notifications for `MUTE_MINUTES` (default 60). |
| `/mute 30` | Mute notifications for 30 minutes. |
| `/unmute` | Turn notifications back on. |
| `/full` | Reply to a notification to download its saved response as a text file. |

Only `/mute` accepts an argument. Extra arguments on the other commands produce
a usage message without changing anything. In groups, you can address your bot
with `/status@yourbot`; the same syntax works for the other commands. Supported
commands addressed to another bot, or with a malformed suffix, are ignored.
Other text follows the normal notification-reply rules.

`/status` lists blocked agents first, followed by working agents and the rest:

```
⚠️ pi · api · blocked · wB:p2
⏳ claude · storefront · working · wA:p1
💤 claude · docs · idle · wA:p3
```

The list shows up to 20 agents and reports how many were omitted. It does not
control any panes and reports an error if Herdr cannot be reached.

`/full` sends the response saved before `LAST_MESSAGE_CHARS` and Telegram's
message limit shortened it. It uses the text captured for that notification,
including queued notifications, so later turns do not replace it. The command
never reaches an agent or reads a live pane.

Saved responses are available for up to 24 hours, within the last 300
notifications. Older notifications, reminders and blocked-screen notifications
may have no saved response; the bot explains when nothing is available.
Notification and queue files are stored with owner-only permissions.

## Muting it

From Telegram, use `/mute` for the configured duration or `/mute 30` for thirty
minutes. Explicit durations must be whole numbers from 1 to 10080 (one week).
Invalid values leave the current mute unchanged.

Repeating `/mute 30` starts a fresh thirty-minute mute; it never toggles
notifications back on. Use `/unmute` to end it early. Command confirmations and
replies to agents still work while notifications are muted.

At the keyboard, the mute action toggles notifications instead, so one key
handles both mute and unmute:

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "naturalmoods.herdr-telegram-notify.mute"
description = "mute/unmute Telegram notifications"
```

You can also run `herdr plugin action invoke mute`. A Herdr notification confirms
the change. `MUTE_MINUTES` sets the duration, one hour by default. The action and
the commands share one mute: `/unmute` lifts one set from the keyboard, and the
action lifts one set from the chat.

Muted notifications are dropped, not queued for later. The plugin still records
status changes so it can calculate turn durations after the mute ends.

## The message

```
✅ claude · done
Fix the flaky checkout test
▸ run it fifty times and tell me if it is actually green
📁 storefront · main · ~/projects/storefront
✎ 3 files · +142 −38 · 1 new
⏱ ran 4m 12s · 18k out · 143k ctx
🖥 workbench · tab API · herdr agent focus wC:p4
🐑 working: billing-service · 2 idle

Green now, 50 runs in a row. The test asserted on cart order, which the new
batch write no longer guarantees — it sorts before comparing instead …
```

Each optional part has a setting:

| Part | Source | Setting |
| --- | --- | --- |
| Status header | Event's agent and status | Always shown |
| Session title | Agent's pane title | `SHOW_TITLE` |
| Turn's prompt | Starting prompt in the transcript | `SHOW_PROMPT`, `PROMPT_CHARS` |
| Workspace, branch, cwd | Session snapshot and `.git/HEAD` | `SHOW_PROJECT`, `SHOW_BRANCH` |
| Uncommitted changes | `git diff --shortstat HEAD` and untracked files in that cwd | `SHOW_CHANGES` |
| Duration | Recorded `working` → stop interval, or transcript turn | `SHOW_DURATION` |
| Tools (off by default) | Four most-used tools from the turn's `tool_use` blocks | `SHOW_TOOLS` |
| Tokens and cost | Assistant `usage` records summed over the turn | `SHOW_TOKENS` |
| Clock time (off by default) | Time of the status change | `SHOW_TIMESTAMP` |
| Host, pane and focus command | Session snapshot | `SHOW_PANE`, `SHOW_HOST` |
| Other agents' status | Session snapshot | `SHOW_HERD` |
| Last message | Agent transcript (`~/.claude/projects/*.jsonl`, pi's session file) | `SHOW_LAST_MESSAGE`, `LAST_MESSAGE_CHARS` |
| Screen tail (blocked only) | `herdr pane read`, cropped to one column | `SHOW_SCREEN_ON_BLOCKED`, `SCREEN_LINES` |

For split panes, the screen tail includes the column containing the question,
or the wider column if no question is detected. The plugin detects panel edges
by text starting at the same column on successive lines. Without a detected
edge, it leaves the screen uncropped.

The `✎` line shows the current working tree, including changes from before this
turn. It is omitted for clean trees and non-Git directories.

The `▸` line shows this turn's prompt. The title above it describes the session
and may refer to earlier work. Turns started by slash commands show the command.

The `🖥` line includes a command you can run to return to the pane.
`herdr agent focus` requires a raw pane id such as `wC:p4` (pane 4 in workspace
wC), rather than a workspace label or tab name. Use `herdr pane list` to map
ids to the labels and numbers shown in the UI.

Messages use Telegram HTML, preserving the agent's `**bold**` and `` `code` ``.
If Telegram rejects the markup, the plugin retries as plain text.

Long last messages appear in collapsed quotes with Telegram's “show more”
control. `LAST_MESSAGE_CHARS` defaults to 1200. To stay within Telegram's
4096-character limit, the plugin shortens the body and renders it again,
keeping the markup intact. Higher `LAST_MESSAGE_CHARS` or `SCREEN_LINES` values
may still result in a truncated body.

### Failed sends

The plugin tries a send up to three times, with an eight-second timeout per
request. It retries dropped connections, 5xx responses and rate limits, waiting
for Telegram's `retry_after` value when provided, or one second then two seconds
otherwise. Retries are bounded so a failing hook finishes within about half a
minute. Rejected tokens and chat ids are not retried or queued.

Other failed sends go into the state directory. The next status change on any
pane retries them, even if that event does not send a notification of its own.
Delivered messages show how late they are. The queue keeps the twenty most
recent messages for up to six hours.

Set `SWEEP_MINUTES` to retry on a timer too; otherwise, the queue waits for
another status change.

## Behavior

- Listens for Herdr's `pane.agent_status_changed` event. It sends only for
  `NOTIFY_STATUSES` (default `done,blocked`) but records every transition to
  calculate durations.
- Herdr reports `idle` when an agent is ready for input and its tab has been
  seen in the focused UI. It reports `done` when the same state is reached
  while the work was unseen. A turn you watched therefore stays silent by
  default. Add `idle` to `NOTIFY_STATUSES` to receive those notifications too,
  including short turns in the pane you are looking at.
- `BLOCKED_REMINDER_MINUTES` sends one reminder per blocked stretch, including
  the elapsed time and current screen. The plugin checks the live session
  before sending to confirm the agent is still blocked. Off by default.
- `SWEEP_MINUTES` sets the background interval for queue retries and blocked
  reminders. It defaults to `0` (off), so both otherwise wait for a status
  change on any pane. Set it to `5` to check every five minutes, including when
  all agents are waiting and no new events arrive.

  The sweeper starts on the next status change after you enable it. After you
  set it back to `0`, it stops on its next pass, up to one interval later.
  To stop it immediately, kill the pid in `sweep.lock`. A lock allows only one
  sweeper at a time. `herdr plugin action invoke doctor` reports its status;
  `sweep.log` in the state directory contains its log.
- `MIN_DURATION_SECONDS` skips turns shorter than the threshold. Off by
  default; try `60` to filter short turns. It never applies to `blocked`.
- `NOTIFY_WORKSPACES` and `IGNORE_WORKSPACES` filter workspaces by label or id,
  using comma-separated lists. An empty allowlist permits all workspaces;
  the denylist takes precedence.
- `QUIET_HOURS=23:00-07:00` sends notifications silently during that window in
  local time. Windows can cross midnight. Queued messages delivered during
  quiet hours are silent too.
- Duplicate notifications are suppressed when a pane is already in the
  reported status, or when two panes report the same turn from one agent
  session. The latter can happen with resumed or adopted sessions; the
  transcript's last record identifies the turn.
- Duration uses the pane's recorded `working` → stop interval when it is under
  six hours. Longer intervals use the transcript's turn duration instead,
  since suspension can delay a status change until the machine wakes.
- On each event, the plugin removes state for panes untouched for a week and
  files left by earlier versions. Undelivered messages live in `pending.jsonl`.
- Without the `herdr` CLI, messages use the event and focused-pane context
  instead of a session snapshot. An unreadable transcript omits the body.

## Checking the setup

```
herdr plugin action invoke doctor
```

`doctor` checks Node, the `herdr`, `git` and `flock` binaries, config permissions,
active settings, the state directory and bot credentials. It sends one silent
test message to verify the token and chat id together. The report appears in
`herdr plugin log list`, with a verdict in a Herdr notification. You can bind it
to a key like the mute action.

It validates settings using the notifier's parsing rules and reports invalid
values, including:

- Unknown statuses such as `blocke`.
- Quiet hours outside the `HH:MM-HH:MM` format.
- Counts with units, such as `SWEEP_MINUTES=5min`.
- Zero or negative values where a positive size is required.
- Non-numeric topic or Telegram user ids.
- `TELEGRAM_TOPICS` entries that are not `workspace:topic` pairs.

Invalid values fall back to defaults at runtime. `doctor` reports each invalid
key as an error rather than also marking it OK. It exits with `2` for config
errors and `1` for other failures. Values are printed as written, except the
bot token, which is never printed.

## When nothing arrives

Many events do not send a notification: the status may be excluded, or the pane
may already be in that state. Set `DEBUG=1` in `.env` to log these decisions,
then check `herdr plugin log list`:

```
herdr-telegram-notify: working is not in NOTIFY_STATUSES (done, blocked)
herdr-telegram-notify: wA:p7 was already done
herdr-telegram-notify: no transcript found for {"kind":"id","value":"…"}
```

Warnings appear even without debug logging, including readable `.env` files,
unknown config keys and failed sends with retry details.

## Testing a change

`DRY_RUN=1` prints the message without sending it. Environment variables override
`.env` settings for a single run:

```
HERDR_PLUGIN_EVENT_JSON='{"event":"pane_agent_status_changed","data":{"pane_id":"wC:p4","workspace_id":"wC","agent_status":"done","agent":"claude"}}' \
HERDR_PLUGIN_CONTEXT_JSON='{}' DRY_RUN=1 node notify.mjs
```

Use a real `pane_id` from `herdr pane list` so the plugin can find its snapshot
and transcript.

Run the tests with:

```
node --test test/*.test.mjs
```

`lib.test.mjs` covers formatting, config resolution and transcript reading. The
other files run the real scripts against a fake `herdr` and a local stand-in for
Telegram: sending and retries, the queue sweeper, the reply poller, locking and
`doctor`. CI runs them on Node 18, 20, 22 and 24, plus a hook run with no
configuration to check that missing settings do not crash the plugin.

## Uninstall

```
herdr plugin uninstall naturalmoods.herdr-telegram-notify
```
