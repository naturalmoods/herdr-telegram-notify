# herdr-telegram-notify

A Herdr plugin that sends a Telegram message when an agent finishes (`done`)
or needs input (`blocked`) — with enough detail to tell, from the phone, which
agent it was and what it did.

Requires Herdr 0.8 or newer, Node 18+, and Linux or macOS. Herdr's server does
not inherit your shell's PATH, so `run.sh` locates Node itself — an nvm, fnm or
volta install would otherwise be invisible to it.

## Install

```
herdr plugin install naturalmoods/herdr-telegram-notify --yes
```

## Configure

```
herdr plugin config-dir naturalmoods.herdr-telegram-notify
```

Create a `.env` file in that directory (see `.env.example`) with:

```
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat id>
```

Every other key in `.env.example` is optional and switches one part of the
message on or off. `.env` is gitignored — the token belongs in the config
directory, not in this repo.

### Getting a bot token and a chat id

1. **Create the bot.** In Telegram, open a chat with [@BotFather](https://t.me/BotFather)
   and send `/newbot`. It asks for a display name, then for a username ending in
   `bot`. It answers with the token — a long `123456789:AAG…` string. That is
   `TELEGRAM_BOT_TOKEN`, and it is a password: anyone holding it can post as
   your bot.
2. **Say hello to it.** Open your new bot and press Start (or send it any
   message). A bot cannot write to someone who has never written to it, so
   without this step every send fails with `403: bot can't initiate
   conversation with a user`.
3. **Read the chat id.** With the token in hand:

   ```
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
   ```

   The number that comes back is `TELEGRAM_CHAT_ID` — positive for a private
   chat with yourself, negative (`-100…`) for a group. An empty result
   (`{"ok":true,"result":[]}`) means there is nothing pending: Telegram drops
   updates after about 24 hours, so send the bot a fresh message and run it
   again.

For a group instead of a private chat, add the bot to the group and send
`/start@yourbotname` there — group privacy mode hides ordinary messages from
bots, so a command addressed to it is what makes the chat show up in
`getUpdates`.

## The message

```
✅ claude · done
Fix the flaky checkout test
📁 storefront · main · ~/projects/storefront
⏱ ran 4m 12s · 18k out · 143k ctx
🖥 workbench · tab API · herdr agent focus wC:p4
🐑 working: billing-service · 2 idle

Green now, 50 runs in a row. The test asserted on cart order, which the new
batch write no longer guarantees — it sorts before comparing instead …
```

Line by line, and the key that removes it:

| Part | Source | Key |
| --- | --- | --- |
| Status header | the event's agent + status | always |
| Session title | the agent's own pane title | `SHOW_TITLE` |
| Workspace, branch, cwd | session snapshot + the repo's `.git/HEAD` | `SHOW_PROJECT`, `SHOW_BRANCH` |
| Duration | the `working` → stop gap this plugin records, or the turn in the transcript | `SHOW_DURATION` |
| Tokens and cost | `usage` on the transcript's assistant records, summed over the turn | `SHOW_TOKENS` |
| Clock time (off by default) | the moment of the status change | `SHOW_TIMESTAMP` |
| Where it happened, and the command to jump back | session snapshot | `SHOW_PANE`, `SHOW_HOST` |
| What the other agents are doing | session snapshot | `SHOW_HERD` |
| Last message | the agent's transcript (`~/.claude/projects/*.jsonl`, pi's session file) | `SHOW_LAST_MESSAGE`, `LAST_MESSAGE_CHARS` |
| Screen tail (blocked only) | `herdr pane read` — the question it is waiting on | `SHOW_SCREEN_ON_BLOCKED`, `SCREEN_LINES` |

The `🖥` line ends in a raw pane id because `herdr agent focus` takes exactly
that form — the workspace label and the tab name are not accepted as targets.
`wC:p4` reads as "pane 4 in workspace wC"; `herdr pane list` maps the ids to the
numbers and labels the UI shows. The human-readable half of the address is
already on the `📁` line, so the id is left to do the one job the label cannot.

Messages are sent as Telegram HTML, with the agent's `**bold**` and `` `code` ``
carried over. If Telegram rejects the markup, the same message is re-sent as
plain text rather than dropped.

## Behavior

- Fires on Herdr's `pane.agent_status_changed` event.
- Sends only for the statuses in `NOTIFY_STATUSES` (default `done,blocked`), but
  records every transition — that is where the duration comes from.
- `done` is not "the turn ended". Herdr's own definition: `idle` is an agent
  ready for input whose tab **has been seen** in the focused UI, and `done` is
  that same idle state reached while the work was **unseen**. So a turn you sat
  and watched ends as `idle` and stays silent by design; only work that finished
  while you were on another tab, another workspace, or away from the machine
  raises `done`. Put `idle` in `NOTIFY_STATUSES` to be told either way — at the
  cost of a ping for every short turn in the pane you are looking at.
- De-dupes: won't send twice in a row for the same pane if the status hasn't
  actually changed since the last notification.
- The duration is the pane's own `working` → stop gap, but only while that gap
  stays believable as one turn (under six hours). A machine that suspends
  mid-turn notices the status change on waking, not when the agent stopped, so
  past that the transcript's own turn is used instead.
- Degrades instead of failing. Without the `herdr` CLI on the machine there is
  no snapshot, so the message falls back to what the event and the focused-pane
  context carry; an unreadable transcript just drops the body.

## Testing a change

`DRY_RUN=1` prints the message instead of sending it. Env vars override the
`.env` for a single run, so this works whatever the file says:

```
HERDR_PLUGIN_EVENT_JSON='{"event":"pane_agent_status_changed","data":{"pane_id":"wC:p4","workspace_id":"wC","agent_status":"done","agent":"claude"}}' \
HERDR_PLUGIN_CONTEXT_JSON='{}' DRY_RUN=1 node notify.mjs
```

Use a real `pane_id` from `herdr pane list` — the snapshot lookup and the
transcript both hang off it.

## Uninstall

```
herdr plugin uninstall naturalmoods.herdr-telegram-notify
```
