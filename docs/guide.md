# herdr-telegram-notify guide

A Herdr plugin that messages you on Telegram when an agent finishes (`done`) or
needs input (`blocked`), and lets you answer that agent from the chat.

This is the complete reference. For a quick start, see the [README](../README.md).
Defaults and per-setting comments are in [`.env.example`](../.env.example).

- [Setup](#setup)
- [The message](#the-message)
- [Replies and commands](#replies-and-commands)
- [Keeping the chat current](#keeping-the-chat-current)
- [Sidebar tokens](#sidebar-tokens)
- [Noise control](#noise-control)
- [Secret masking](#secret-masking)
- [Failed sends and the sweeper](#failed-sends-and-the-sweeper)
- [Behaviour details](#behaviour-details)
- [Doctor](#doctor)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Uninstall](#uninstall)

## Setup

### Requirements

Herdr 0.8 or newer, Node 18+, and Linux or macOS. Herdr's server does not inherit
your shell's PATH, so `run.sh` locates Node itself, including Homebrew, nvm, fnm,
volta and mise installs.

Linux needs `flock(1)` from util-linux. On macOS, install it with
`brew install util-linux`; the plugin finds the keg-only binary on Apple silicon
and Intel without changing PATH or linking the keg. `brew install flock` is
also supported through its linked Homebrew binary.

Hook processes, the reply poller and the sweeper share a state directory and
use kernel locks to protect it. These locks are released when a process dies.
Without `flock`, notifications still send, but failed messages are not queued,
replies cannot be routed, and neither background process starts. `doctor` checks
for it.

### Install

```
herdr plugin install naturalmoods/herdr-telegram-notify --yes
```

For a local checkout, run `herdr plugin link .` from the repository directory.

#### Letting Claude Code do it

The repo includes a setup skill. From a clone, copy it into your skills directory
and ask your agent to set up the plugin:

```
cp -r .claude/skills/herdr-telegram-notify ~/.claude/skills/
```

If you installed the plugin instead, `herdr plugin list` prints its directory.
The skill is under `.claude/skills/herdr-telegram-notify` there too.

The skill covers the token, chat id, `doctor`, reply poller and reply
troubleshooting. The manual steps follow below.

### Configure

```
herdr plugin config-dir naturalmoods.herdr-telegram-notify
```

Create a `.env` file in that directory (see [`.env.example`](../.env.example)) with:

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

#### Getting a bot token and a chat id

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

#### A topic per workspace

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

### Upgrading

Run the [install command](#install) again to upgrade. A reply poller or sweeper
that is already running keeps the old code until it stops: `pkill -f replies.mjs` (and
`pkill -f 'notify.mjs --sweep'`), and the next status change or Herdr start
brings up the new one.

For a linked checkout, use `git pull` instead of reinstalling, then stop the old
poller and sweeper as above.

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
| Turn's prompt | Claude/pi prompt, or Codex user-message event (not injected context) | `SHOW_PROMPT`, `PROMPT_CHARS` |
| Workspace, branch, cwd | Session snapshot and `.git/HEAD` | `SHOW_PROJECT`, `SHOW_BRANCH` |
| Uncommitted changes | `git diff --shortstat HEAD` and untracked files in that cwd | `SHOW_CHANGES` |
| Duration | Recorded `working` → stop interval, or transcript turn (Codex task start/complete) | `SHOW_DURATION` |
| Tools (off by default) | Four most-used Claude `tool_use`, pi `toolCall` or Codex function/custom-tool calls | `SHOW_TOOLS` |
| Tokens and cost | Claude/pi assistant `usage`, or Codex `token_count` records (no cost) | `SHOW_TOKENS` |
| Clock time (off by default) | Time of the status change | `SHOW_TIMESTAMP` |
| Agent metadata (off by default) | Other plugins' display values in the snapshot agent's `tokens` | `SHOW_AGENT_TOKENS` |
| Host, pane and focus command | Session snapshot | `SHOW_PANE`, `SHOW_HOST` |
| Other agents' status | Session snapshot | `SHOW_HERD` |
| Last message | Claude transcript, pi session file or Codex rollout's last agent message | `SHOW_LAST_MESSAGE`, `LAST_MESSAGE_CHARS` |
| Screen tail (blocked only) | `herdr pane read`, cropped to one column | `SHOW_SCREEN_ON_BLOCKED`, `SCREEN_LINES` |

`SHOW_AGENT_TOKENS=model,context,quota_5h_*` adds a line after the ⏱ line
when those tokens exist, for example:

```text
📊 Model Cedar · context 13% · 5h 25% 59m
```

Names are case-sensitive. List order is display order; a trailing `*` selects
names with that prefix, sorted by name (`*` alone selects all). Overlapping
matches appear once, empty values are skipped, and the plugin's own `telegram`
token is never included. The line is masked and clipped to 200 characters.
Empty `SHOW_AGENT_TOKENS` leaves messages unchanged. Queued messages keep the
captured values; blocked reminders read current values from their snapshot.
This is separate from `SHOW_TOKENS`, which reports transcript usage and cost.

Claude session ids resolve under `~/.claude/projects/<project>/` (or
`CLAUDE_CONFIG_DIR/projects`); pi supplies its session-file path. A session
reported as `agent: "codex", kind: "id"` resolves to the rollout ending in that
id under `$CODEX_HOME/sessions/YYYY/MM/DD/`, defaulting to `~/.codex/sessions`.
The newest day directories are searched first, stopping at the first match.
`CODEX_HOME` must be in Herdr's environment, not the plugin's `.env`.

Codex prompts come only from `user_message` events or `UserMessage` items;
user-role response items containing AGENTS.md and other injected context are
ignored. Output tokens cover only the current turn's calls, while context is
from its last token-count record, with cached input already included. Codex
records no cost, so none is estimated or shown.

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

## Replies and commands

Replies are off by default. Set `REPLIES=1` in `.env`, then reply to a
notification in Telegram to send text to that agent. Buttons, files, voice
and commands use the same setting.

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

The reply poller runs in a separate process. With `REPLIES` enabled, it starts
when Herdr starts, or on the next status change after you turn it on. It stops
on the next poll after you disable it.
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

### Buttons

When the blocked screen shows a menu, the notification carries one button per
option. A tap sends that option's number exactly as a typed reply would,
through the same checks. A menu is numbered lines starting at `1.`, one of them
marked as selected (`❯`, `›`, `>`); a numbered list in the agent's prose has no
marker and gets no buttons. Buttons are read from the screen, so they need
`SHOW_SCREEN_ON_BLOCKED`. They disappear once the question is answered.

### Files and photos

A photo or a file sent as a reply goes to the agent as a new turn: the caption,
then `Attached file: <path>`. Photos and `jpg`, `png`, `gif`, `webp`, `md`,
`txt`, `pdf` and `docx` files are accepted, up to Telegram's 20 MB limit for
bots. Anything else is refused before it is downloaded.

Files are saved under `files/` in the state directory with owner-only
permissions and deleted after a day. The file is outside the agent's project,
so the agent may ask for permission to read it. A blocked agent does not accept
files, since the path would be typed into its prompt; answer the question
first.

### Voice messages

A voice message sent as a reply is transcribed and sent as a new turn. The bot
answers with what it heard:

```
🎙 “run the tests again”
→ sent to wA:p1
```

Transcription needs a local whisper CLI and `ffmpeg`. Either of these works:

```
pipx install openai-whisper
uv tool install whisper-ctranslate2 --with 'av<19'
```

`whisper-ctranslate2` needs the `av<19` pin because faster-whisper 1.2 cannot
open files with PyAV 19.

The plugin looks for the CLI on PATH and in `~/.local/bin`, or uses
`WHISPER_BIN` if set. `WHISPER_MODEL` picks the model, `small` by default.
`WHISPER_LANGUAGE` names the language you speak (`hu`, `en`, `de`); without
it, whisper guesses per message, and a short Hungarian note can come back
transcribed as Turkish. The
first voice message downloads the model, which can take a while.
Transcription always runs on the CPU. Without a whisper CLI, the bot refuses
voice messages and says why; `doctor` reports which CLI it found. Like files,
voice messages are not delivered to a blocked agent.

### Commands

Commands use the same chat and user allowlist as replies.
Responses return to the forum topic where you asked.

The commands appear in Telegram's `/` menu once the reply poller has started;
nothing needs registering in BotFather. Registration is tried once per start.
If it fails, `replies.log` records the failure, replies still work, and the next
poller start tries again.

| Command | Result |
| --- | --- |
| `/status` | List agents with their workspace, state and pane id. |
| `/mute` | Mute notifications for `MUTE_MINUTES` (default 60). |
| `/mute 30` | Mute notifications for 30 minutes. |
| `/unmute` | Turn notifications back on. |
| `/full` | Reply to a notification to download its saved response as a text file. |
| `/stop` | Reply to a notification to send Esc to that agent. |
| `/screen` | Reply to a notification to read that agent's current screen. |
| `/diff` | Reply to a notification to download its current uncommitted changes as a `.diff` file. |
| `/new <workspace> <kind> [prompt]` | Start a real agent in a new background tab, optionally giving it a prompt. |
| `/new <workspace>@<branch> <kind> [prompt]` | Start it in a new Git worktree workspace labelled with the branch. |

Only `/mute` and `/new` accept arguments. Extra arguments on the other commands
produce a usage message without changing anything. In groups, you can address your bot
with `/status@yourbot`; the same syntax works for the other commands. Supported
commands addressed to another bot, or with a malformed suffix, are ignored.
Other text follows the normal notification-reply rules.

`/status` lists blocked agents first, followed by working agents and the rest:

```
⚠️ pi · api · blocked since 14:20 · wB:p2
⏳ claude · storefront · working since 14:31 · wA:p1
💤 claude · docs · idle · wA:p3
```

The time appears when the plugin recorded that agent's change of state.

The list shows up to 20 agents and reports how many were omitted. It does not
control any panes and reports an error if Herdr cannot be reached.

`/new storefront claude Review notes.md.` starts a real agent in a new tab,
without moving the desktop focus. It does not need a notification reply; if
sent as a reply, that reply target is ignored. The workspace must already
exist: use its exact id or a complete, case-insensitive label. Use an id for
labels containing spaces or shared by multiple workspaces. Usage errors list
the known labels and ids. Workspaces excluded by `NOTIFY_WORKSPACES` or
`IGNORE_WORKSPACES` are refused, since their notifications would never reach you.

`/new storefront@fix-login claude Review notes.md.` gives the agent its own
Git checkout instead of sharing the parent workspace's checkout. Herdr opens
it as a workspace labelled `fix-login`, grouped with `storefront`, without
moving focus. An existing local branch is checked out; otherwise Herdr creates
it from `HEAD`. The selector splits at the last `@`.

Branch names must be 1–100 characters from `[A-Za-z0-9._/-]`, not start with
`-` or `.`, contain `..` or `//`, or end with `/`, `.` or `.lock`. Git and Herdr
validate the rest, including repository ownership; no trust bypass, path or
base option is passed. Both the parent workspace and the new branch label must
pass `NOTIFY_WORKSPACES` and `IGNORE_WORKSPACES` before anything is created.
An allowlist containing only the parent id therefore needs the branch label
added too. Start without `@branch` to keep using the existing checkout.

The kind must be 1–32 lowercase letters, digits, `_` or `-`, starting with a
letter. Herdr decides which kinds are supported. Without `@branch`, the tab
is labelled with the kind. The agent gets a generated unique name in either
case. Worktree creation and agent startup each have a 60-second command timeout.
A failed plain-tab start closes only the tab this command created. A failed
worktree start leaves its checkout and workspace intact and reports the
workspace id, branch and `herdr worktree remove --workspace <id>` for manual
removal; it never closes or removes the worktree for you.

The optional prompt keeps its newlines and is capped at 4,000 characters, like
reply text. It is passed as one text argument, without a shell, `--wait` or
native agent options after `--`. If the prompt fails, the agent remains running
and the confirmation says why it was not delivered.

Reply to the start confirmation with text, `/stop`, `/screen` or `/diff` as you
would to a notification; the same session checks apply. If Herdr has not yet
reported its session, the confirmation says to use its first notification for
replies instead. Commands and confirmations use the same chat, sender allowlist
and forum-topic routing as existing replies. Turn on `REPLIES` only for people
you trust to start agents as well as type into them.

`/stop` sends Esc to the agent from the notification you reply to, only if the
same recorded session is still running and is `working` or `blocked`. It
interrupts work or dismisses the current question without quitting the agent;
it never sends Ctrl+C. Idle or done agents have nothing to stop; unknown states
get no key either. Use `/stop` as the reply text, with no arguments.

`/screen` must be a reply to a notification. It shows up to 40 lines from the
pane's current screen, cropped to one column, with the agent, status and pane
above it. The recorded session must still match; it never sends input. The
screen is a preformatted block, with older lines dropped from the top if needed
to fit one message. An empty or unreadable screen gets an explanation. Use
`/screen` with no arguments; `SCREEN_LINES` does not change its fixed limit.

`/diff` must be a reply with no arguments, and the recorded agent session must
still match. It reads the live agent's working directory and sends `git diff
HEAD` as a `.diff` file named after the pane, including staged and unstaged
changes. It never sends pane input. The caption has the ✎ summary and untracked
filenames; their contents are not included. A long filename list is shortened
to fit Telegram's caption limit. Untracked-only work gets a note in the file
saying there are no tracked changes.

A directory outside a git repo, a repo with no commits, or a completely clean
working tree gets a plain explanation instead. Diffs over 5 MB (5,242,880 bytes)
get their size and ✎ summary instead of a file. Git runs without a shell, with
optional locks disabled and external diff drivers and textconv disabled. The
file and caption go through `MASK_SECRETS`; masking can make the file unsuitable
for applying as a patch, so treat it as a review copy.

`/full` sends the response saved before `LAST_MESSAGE_CHARS` and Telegram's
message limit shortened it. It uses the text captured for that notification,
including queued notifications, so later turns do not replace it. The command
never reaches an agent or reads a live pane.

Saved responses are available for up to 24 hours, within the last 300 recorded
notifications and start confirmations. Older notifications, reminders and
blocked-screen notifications may have no saved response; the bot explains when
nothing is available. Notification and queue files are stored with owner-only
permissions.

## Keeping the chat current

With `MARK_RESOLVED=1` (the default), a notification is edited once the
agent's next status change or pane closure overtakes it. What still looks
like a notification in the chat is what is still waiting on you:

| Notification | Next event | Marked |
| --- | --- | --- |
| Blocked, or its reminder | `working` | `✓ answered · 14:32` |
| Blocked, or its reminder | any other status | `✓ no longer waiting · 14:32` |
| Any other | `idle` (seen in the focused UI) | `👀 seen at the desk · 14:32` |
| Any other | `working` | `↷ on to the next turn · 14:32` |
| Any | pane closed | `✕ pane closed · 14:32` |

The line goes above the header. A blocked notification also loses its screen
and its buttons, because that question is no longer being asked. Replies to a
marked notification follow the usual rules, so an answered question still
refuses them. Each notification is edited at most once, and only while it is in
the reply map (24 hours, the last 300).

`BOARD=1` keeps one pinned message listing the herd, like `/status`, with the
time each agent entered its state:

```
🐑 workbench · updated 14:32
⚠️ pi · api · blocked since 14:20 · wB:p2
⏳ claude · storefront · working since 14:31 · wA:p1
```

It is edited in place on every status change and pane closure, so it never
rings, and it goes to `TELEGRAM_TOPIC_ID`'s topic when set. If you delete it, the
next change sends and pins a new one. In a group the bot needs admin rights to
pin; without them the board still updates, unpinned. Closed panes disappear
without needing the sweeper. `SWEEP_MINUTES` can also refresh the board on a
timer. Off by default.

## Sidebar tokens

`SIDEBAR_TOKENS=1` (the default) reports display-only `telegram` metadata under
`naturalmoods.herdr-telegram-notify`. Nothing appears until `$telegram` is in
the sidebar rows of the config on the machine where the Herdr window runs.
Herdr draws the sidebar from the client's config, so when you watch agents on
another machine over SSH, the rows belong in your local config, not the
server's.

Run `herdr plugin action invoke sidebar --plugin naturalmoods.herdr-telegram-notify`
**where the Herdr window runs**, not on an SSH server. It uses `HERDR_CONFIG_PATH`,
then `XDG_CONFIG_HOME/herdr/config.toml`, then the default above; backs up to
`config.toml.bak-<timestamp>`; and restores the backup if `herdr config check`
fails. Reload config from the Herdr menu (or your `reload_config` key);
`herdr server reload-config` alone does not reload the client. Unrecognized
rows are left untouched with manual instructions; existing `$telegram` rows
are left as they are. For manual setup, use a separate row to avoid truncation:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["$telegram"],
  ["agent"],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["$telegram"],
  ["branch", "git_status"],
]
```

- `📨 HH:MM`: a notification was actually sent for that pane, including a queue
  delivery or reminder. Resolution clears it when `MARK_RESOLVED=1`.
- `📱 HH:MM`: phone input reached the pane, including replies, buttons, files,
  voice, `/stop` and a `/new` prompt. It expires after 30 minutes.
- `🔕 until HH:MM`: notifications are muted. The action and `/mute` report this
  on every workspace in the snapshot; `/unmute` or the action clears it.

The latest pane update replaces the previous value. Reports use sequence
numbers to reject stale arrivals, run asynchronously with a one-second timeout,
and never fail delivery; only `DEBUG=1` logs failures. `DRY_RUN=1` never reports.
`SIDEBAR_TOKENS=0` stops reports without clearing older values; remove the token
from your rows to hide those. These rows affect the expanded desktop sidebar
only; an empty `["$telegram"]` row disappears. The setup action also covers
agent-specific `[ui.sidebar.agents.rows_by_agent]` overrides.

A workspace created during a mute does not get its badge automatically.
Mute badges use the remaining mute time as their TTL, capped at Herdr's
24-hour limit. Longer mutes remain in force, but their badge expires after
24 hours unless another mute command refreshes it.

## Noise control

### Muting it

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

### Short turns and quiet hours

`MIN_DURATION_SECONDS` skips turns shorter than the threshold. Off by
default; try `60` to filter short turns. It never applies to `blocked`.

`QUIET_HOURS=23:00-07:00` sends notifications silently during that window in
local time. Windows can cross midnight. Queued messages delivered during
quiet hours are silent too.

### Blocked delay

`BLOCKED_DELAY_SECONDS` waits before sending a blocked notification, so a
question answered at the desk need not ring the phone. It defaults to `0`
(send at once); try `15`. Whole seconds only, capped at `120`. After the wait,
both the recorded episode and the live agent must still be blocked; an answer,
closure or new blocked stretch drops the old notification. The screen and
buttons are read after the wait. `DRY_RUN` previews skip the delay.

### Workspace filters

`NOTIFY_WORKSPACES` and `IGNORE_WORKSPACES` filter workspaces by label or id,
using comma-separated lists. An empty allowlist permits all workspaces;
the denylist takes precedence.

For separate notification threads, see [a topic per workspace](#a-topic-per-workspace).

## Secret masking

Telegram bot chats are not end-to-end encrypted. `MASK_SECRETS=1` (the default)
masks recognizable credentials before captured text is clipped or formatted:
last messages, prompts, titles, blocked screens and reminders, button labels,
and `/full`, `/screen` and `/diff` output. Queued text and saved responses are
checked against the current setting too. Replies sent to an agent are not changed.

It recognizes common Anthropic, OpenAI, GitHub, AWS, Slack, Google, Stripe and
Telegram key shapes, Bearer tokens, JWTs, PEM private-key blocks and assignments
whose names contain `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`
or `PRIVATE_KEY`. Matches keep a short identifying prefix, such as
`ghp_…[masked]`; assignments keep their names and mask the value. Assignment
values shorter than 8 characters are left alone.

This is best-effort pattern matching, not a guarantee. Unrecognized or partly
visible secrets can still reach the chat. Set `MASK_SECRETS=0` if a false
positive gets in the way; this allows unmasked text through and does not restore
text that was already masked. Do not rely on it to make a sensitive session safe
to share.

## Failed sends and the sweeper

The plugin tries a send up to three times, with an eight-second timeout per
request. It retries dropped connections, 5xx responses and rate limits, waiting
for Telegram's `retry_after` value when provided, or one second then two seconds
otherwise. Retries are bounded so a failing hook finishes within about half a
minute. Rejected tokens and chat ids are not retried or queued.

Other failed sends go into the state directory. The next status change or pane
closure retries them, even if that event does not send a notification of its own.
Delivered messages show how late they are. The queue keeps the twenty most
recent messages for up to six hours.

### Blocked reminders

`BLOCKED_REMINDER_MINUTES` sends one reminder per blocked stretch, including
the elapsed time and current screen. The plugin checks the live session
before sending to confirm the agent is still blocked. Off by default. Its
clock starts when the agent became blocked, not when a delayed message sent.

### Sweeper

`SWEEP_MINUTES` sets the background interval for queue retries and blocked
reminders. It defaults to `0` (off), so both otherwise wait for a status
change or pane closure. Set it to `5` to check every five minutes, including
when all agents are waiting and no new events arrive.

With `SWEEP_MINUTES` enabled, the sweeper starts when Herdr starts, or on the
next status change after you turn it on. After you set it back to `0`, it
stops on its next pass, up to one interval later.
To stop it immediately, kill the pid in `sweep.lock`. A lock allows only one
sweeper at a time. `herdr plugin action invoke doctor` reports its status;
`sweep.log` in the state directory contains its log.

## Behaviour details

- Listens for Herdr's `pane.agent_status_changed` event. It sends only for
  `NOTIFY_STATUSES` (default `done,blocked`) but records every transition to
  calculate durations.
- `pane.closed` removes the pane's recorded state. Its open notifications are
  marked closed when `MARK_RESOLVED=1`, and the board refreshes when `BOARD=1`.
  The event sends no notification.
- Herdr reports `idle` when an agent is ready for input and its tab has been
  seen in the focused UI. It reports `done` when the same state is reached
  while the work was unseen. A turn you watched therefore stays silent by
  default. Add `idle` to `NOTIFY_STATUSES` to receive those notifications too,
  including short turns in the pane you are looking at.
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

## Doctor

```
herdr plugin action invoke doctor
```

`doctor` checks Node, the `herdr`, `git` and `flock` binaries, config permissions,
active settings, the state directory and bot credentials. With `REPLIES=1` it
also checks the reply poller and which whisper CLI it found. It sends one silent
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

Unparseable numbers use defaults at runtime; other invalid values can be capped,
disable a feature or match nothing. `doctor` says what each mistake costs and
reports each invalid key as an error rather than also marking it OK. It exits
with `2` for config errors and `1` for other failures. Values are printed as written, except the
bot token, which is never printed.

With `SIDEBAR_TOKENS=1`, it checks the local client config for `$telegram`
in sidebar rows. A missing layout is a warning, not an error; run the
[sidebar action](#sidebar-tokens) where the Herdr window runs. A client on
another machine needs the token in that machine's config.

## Troubleshooting

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

## Testing

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
Telegram: sending and retries, the queue sweeper, the reply poller, locking,
sidebar setup and `doctor`. CI runs them on Node 18, 20, 22 and 24, plus a hook run with no
configuration to check that missing settings do not crash the plugin. The
macOS job runs Node 22 with Homebrew util-linux.

## Uninstall

```
herdr plugin uninstall naturalmoods.herdr-telegram-notify
```
