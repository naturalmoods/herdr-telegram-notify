#!/bin/sh
# Herdr's server does not inherit an interactive shell's PATH, so a node
# installed by nvm, fnm or volta is usually invisible to it. Find one, then hand
# over to the notifier. Node 18+ is required (fetch, ?? and ?.).

if command -v node >/dev/null 2>&1; then
  exec node notify.mjs
fi

for candidate in \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.config/nvm/versions/node/*/bin/node \
  "$HOME"/.volta/bin/node \
  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -x "$candidate" ]; then
    exec "$candidate" notify.mjs
  fi
done

echo "herdr-telegram-notify: no node found on PATH or in the usual install locations (Node 18+ required)" >&2
exit 1
