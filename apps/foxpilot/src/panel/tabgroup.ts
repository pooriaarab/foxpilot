// Puts the tab foxpilot drives into its own tab group and keeps the group's
// title as a live status: ⚡ running, ✅ done, ⛔ blocked, ⏹ stopped, ⚠️ error.
// The final status shows for a few seconds, then the group is dissolved.
// A tab the user already grouped is left in its group and not relabelled.
// Compat source: MDN browser-compat-data (webextensions/api/tabGroups.json,
// tabs.json): tabs.group/ungroup and Tab.groupId since Firefox 138;
// tabGroups.get/update, TAB_GROUP_ID_NONE and Color since Firefox 139.
import type { AgentView } from "@foxpilot/agent/agent";

type Color = `${chrome.tabGroups.Color}`;

export class TabGroupStatus {
  private last = "";

  private constructor(
    private readonly groupId: number | null,
    private readonly tabId: number,
    /** Only groups foxpilot created are dissolved. */
    private readonly owned: boolean,
  ) {}

  static async start(tabId: number): Promise<TabGroupStatus> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        const group = await chrome.tabGroups.get(tab.groupId);
        // Reuse a group foxpilot made before; leave the user's own groups alone.
        const ours = group.title?.includes("foxpilot") ?? false;
        return new TabGroupStatus(ours ? tab.groupId : null, tabId, ours);
      }
      // Without windowId the group goes to the caller's window, which fails from a popup.
      const groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } });
      return new TabGroupStatus(groupId, tabId, true);
    } catch {
      return new TabGroupStatus(null, tabId, false);
    }
  }

  private async set(title: string, color: Color) {
    if (this.groupId === null || title === this.last) return;
    this.last = title;
    await chrome.tabGroups.update(this.groupId, { title, color, collapsed: false }).catch(() => {});
  }

  running() {
    return this.set("⚡ foxpilot", "cyan");
  }

  update(view: AgentView) {
    const seconds = `${(view.elapsedMs / 1000).toFixed(1)} s`;
    switch (view.status) {
      case "done":
        return this.set(`✅ foxpilot · ${seconds}`, "green");
      case "blocked":
        return this.set("⛔ foxpilot · blocked", "red");
      case "stopped":
        return this.set("⏹ foxpilot · stopped", "grey");
      case "error":
        return this.set("⚠️ foxpilot · error", "red");
      default:
        return this.set(`⚡ foxpilot · step ${view.history.length + 1}`, "cyan");
    }
  }

  failed() {
    return this.set("⚠️ foxpilot · error", "red");
  }

  /** Leave the final status up briefly, then ungroup the tab. */
  finish(afterMs = 4000) {
    if (this.groupId === null || !this.owned) return;
    setTimeout(() => {
      chrome.tabs.ungroup(this.tabId).catch(() => {});
    }, afterMs);
  }
}
