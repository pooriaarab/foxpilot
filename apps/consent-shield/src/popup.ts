// Popup script. It shows the steps taken on the active tab and the per-site off switch.
import { says } from "./plan";
import type { TabLog } from "./store";
import { tabKey } from "./store";

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const host = tab?.url ? new URL(tab.url).hostname : "";
const box = document.getElementById("off") as HTMLInputElement;
const list = document.getElementById("log")!;
document.getElementById("host")!.textContent = host || "this site";

const { off = [] } = (await chrome.storage.local.get("off")) as { off?: string[] };
box.checked = off.includes(host);
box.disabled = !host;
box.addEventListener("change", async () => {
  const { off: now = [] } = (await chrome.storage.local.get("off")) as { off?: string[] };
  const rest = now.filter((h) => h !== host);
  await chrome.storage.local.set({ off: box.checked ? [...rest, host] : rest });
});

const key = tab?.id == null ? "" : tabKey(tab.id);
const log = key ? ((await chrome.storage.session.get(key))[key] as TabLog | undefined)?.log ?? [] : [];
for (const entry of log) {
  const item = document.createElement("li");
  item.textContent = `${entry.title || "Dialog"}: ${entry.failed ? `stopped, ${entry.failed}` : says(entry)}`;
  list.append(item);
}
if (!log.length) list.replaceWith(Object.assign(document.createElement("p"), { textContent: "No consent or nag dialog on this page yet." }));
