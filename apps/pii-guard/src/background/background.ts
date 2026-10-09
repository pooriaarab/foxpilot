// Runs the model for the content scripts and keeps the toolbar badge. Both
// listeners are at the top level, so a message wakes this event page (host.ts).
import { serveModel } from "@foxpilot/core/model/host";
import { loadModel, type AppModel } from "@foxpilot/core/model/load";

declare const __MODEL__: AppModel;

serveModel(() => loadModel(__MODEL__));

/** The content script sends the number of marked spans in its composer. */
chrome.runtime.onMessage.addListener((message: { type?: string; count?: number }, sender) => {
  const tabId = sender.tab?.id;
  if (message.type !== "pii-count" || tabId === undefined) return;
  const count = Math.max(0, Math.floor(message.count ?? 0));
  void chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: "#c50042" });
});
