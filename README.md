# herdr-telegram-notify

A Herdr plugin that sends a Telegram message when an agent finishes (`done`)
or needs input (`blocked`). No other status changes trigger a message.

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

## Behavior

- Fires on Herdr's `pane.agent_status_changed` event.
- Ignores every status except `done` and `blocked`.
- De-dupes: won't send twice in a row for the same pane if the status hasn't
  actually changed since the last notification.
- Message format: `✅ <agent kind> done — <workspace label> (<pane id>)` or
  `⚠️ <agent kind> blocked — <workspace label> (<pane id>)`, e.g.
  `✅ claude done — jegykezelo (wB:p9)`.

## Uninstall

```
herdr plugin uninstall naturalmoods.herdr-telegram-notify
```
