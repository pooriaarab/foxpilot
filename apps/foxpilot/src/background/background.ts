// Opens the sidebar when the toolbar button is clicked. The call must run
// synchronously inside the click handler, or Firefox rejects it.
type ClickInfo = { menuItemId: string | number; frameId?: number; targetElementId?: number };
type FirefoxApi = {
  sidebarAction: { toggle(): Promise<void>; open(): Promise<void> };
  menus: {
    create(item: { id: string; title: string; contexts: string[] }): void;
    onClicked: { addListener(listener: (info: ClickInfo, tab?: { id?: number }) => void): void };
  };
};
const firefox = (globalThis as unknown as { browser: FirefoxApi }).browser;

const MENU_ID = "foxpilot-here";

chrome.action.onClicked.addListener(() => {
  void firefox.sidebarAction.toggle();
});

// Menu items outlive this event page, so they are made once per install.
chrome.runtime.onInstalled.addListener(() => {
  firefox.menus.create({ id: MENU_ID, title: "foxpilot: do this here", contexts: ["page", "editable", "link"] });
});

// The element the user right-clicked becomes the scope of the next run:
// snapshot.js reads window.__glinerFast.scope and looks only inside it.
// getTargetElement works only in a content script of the frame that got the
// click, and the id is valid only until the next menu opens, so resolve it now.
// Only the top frame is scoped, because snapshot reads only that frame.
firefox.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  void firefox.sidebarAction.open();
  if (tab?.id === undefined || info.frameId || info.targetElementId === undefined) return;
  void chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "ISOLATED",
    func: (targetElementId: number) => {
      const menus = (globalThis as unknown as { browser: { menus: { getTargetElement(id: number): Element | null } } }).browser.menus;
      const cache = (window.__glinerFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 } as never) as NonNullable<Window["__glinerFast"]>;
      cache.scope = menus.getTargetElement(targetElementId);
    },
    args: [info.targetElementId],
  });
});
