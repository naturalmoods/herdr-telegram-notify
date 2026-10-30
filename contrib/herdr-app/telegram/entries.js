// What the band lists, apart from drawing it: the Telegram labels on the core's
// terminals, one entry per agent that has one and the mute once. Pure, so a test
// reads it under Node — nothing here comes from "herdr".

// A label's value, unless its expiry has passed. No expiry label means it stands.
function unexpired(labels, key, now) {
  const text = labels[key];
  if (typeof text !== "string" || !text.trim()) return undefined;
  const until = Number(labels[`${key}.expires`]);
  return Number.isFinite(until) && until <= now ? undefined : text;
}

export function telegramEntries(terminals = [], now = Date.now()) {
  const entries = [];
  let mute;
  for (const t of terminals) {
    // Agents are terminals whose program reports a status. A helper an agent
    // started is its business, and the daemon labels its own machine only.
    if (!t?.status || t.parent) continue;
    const labels = t.labels ?? {};
    const text = unexpired(labels, "telegram", now);
    if (text) entries.push({ address: t.address, text, where: t.where || labels.where || t.address });
    mute ??= unexpired(labels, "telegram.mute", now);
  }
  // One mute, however many agents carry it.
  if (mute) entries.unshift({ text: mute });
  return entries;
}
