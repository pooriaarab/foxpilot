// The page kit: the functions TabBrowser calls on every step. scripts/build.mjs
// bundles this file into kit.js, and TabBrowser injects it once per document
// with scripting.executeScript({files}). After that each call is one message on
// a runtime.Port, so the page does not parse the code again on every call.
// It runs in the same isolated world as executeScript({func}) calls, so
// window.__glinerFast is shared with them.
import { snapshot } from "./snapshot.js";
import { settle } from "./settle";
import { ready } from "./ready";
import { fillField, pressKey, scrollAt, strike } from "./actuate";
import { KIT_PORT } from "./types";

declare global {
  interface Window {
    __foxpilotKit?: boolean;
  }
}

function nodeGuard(node: number) {
  const c = window.__glinerFast;
  return c ? [c.pageKey(), c.guard(c.nodes.get(node))] : null;
}

const kit = { snapshot, settle, ready, nodeGuard, strike, fillField, pressKey, scrollAt };

export type Kit = typeof kit;
export type KitCall = { id: number; name: keyof Kit; args: unknown[] };
export type KitReply = { id: number; result?: unknown; error?: string };

// A document restored from the back-forward cache keeps its kit; injecting
// again must not add a second listener, which would answer every call twice.
if (!window.__foxpilotKit) {
  window.__foxpilotKit = true;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== KIT_PORT) return;
    port.onMessage.addListener(async ({ id, name, args }: KitCall) => {
      let reply: KitReply;
      try {
        reply = { id, result: await (kit[name] as (...a: unknown[]) => unknown)(...args) };
      } catch (error) {
        reply = { id, error: error instanceof Error ? error.message : String(error) };
      }
      try {
        port.postMessage(reply);
      } catch {
        // the panel disconnected; it rejects the call itself
      }
    });
  });
}
