// Puts the tab Zipline drives into its own tab group and keeps the group's
// title as a live status: ⚡ running, ✅ done, ⛔ blocked, ⏹ stopped, ⚠️ error.
// A tab the user already grouped is left in its group and not relabelled.
import type { AgentView } from "../agent/agent";

type Color = `${chrome.tabGroups.Color}`;

export class TabGroupStatus {
  private last = "";

  private constructor(private readonly groupId: number | null) {}

  static async start(tabId: number): Promise<TabGroupStatus> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        const group = await chrome.tabGroups.get(tab.groupId);
        // Reuse a group Zipline made before; leave the user's own groups alone.
        return new TabGroupStatus(group.title?.includes("Zipline") ? tab.groupId : null);
      }
      // Without windowId the group goes to the caller's window, which fails from a popup.
      return new TabGroupStatus(await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } }));
    } catch {
      return new TabGroupStatus(null);
    }
  }

  private async set(title: string, color: Color) {
    if (this.groupId === null || title === this.last) return;
    this.last = title;
    await chrome.tabGroups.update(this.groupId, { title, color, collapsed: false }).catch(() => {});
  }

  running() {
    return this.set("⚡ Zipline", "cyan");
  }

  update(view: AgentView) {
    const seconds = `${(view.elapsedMs / 1000).toFixed(1)} s`;
    switch (view.status) {
      case "done":
        return this.set(`✅ Zipline · ${seconds}`, "green");
      case "blocked":
        return this.set("⛔ Zipline · blocked", "red");
      case "stopped":
        return this.set("⏹ Zipline · stopped", "grey");
      case "error":
        return this.set("⚠️ Zipline · error", "red");
      default:
        return this.set(`⚡ Zipline · step ${view.history.length + 1}`, "cyan");
    }
  }

  failed() {
    return this.set("⚠️ Zipline · error", "red");
  }
}
