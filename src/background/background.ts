// Opens the sidebar when the toolbar button is clicked. The call must run
// synchronously inside the click handler, or Firefox rejects it.
type FirefoxApi = { sidebarAction: { toggle(): Promise<void> } };

chrome.action.onClicked.addListener(() => {
  void (globalThis as unknown as { browser: FirefoxApi }).browser.sidebarAction.toggle();
});
