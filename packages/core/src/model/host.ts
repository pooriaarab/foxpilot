// The model host for apps that act from a content script. The background
// event page runs the model (it has a DOM and allows wasm-unsafe-eval); each
// content script gets a Scorer that sends its calls over a runtime.Port.
//
// Firefox unloads an idle event page. Its ports then disconnect: the content
// script rejects the calls in flight, and its next call connects again. That
// connect wakes the event page, which loads the model again. So the background
// must call serveModel() at the top level, where Firefox finds the listener.
import type { Scorer } from "./scorer";

export const MODEL_PORT = "foxmind";

type Method = "classify" | "classifyMany" | "extractEntities";
const methods: readonly Method[] = ["classify", "classifyMany", "extractEntities"];

type Request = { id: number; method: Method; args: unknown[] };
type Reply = { id: number; result: unknown } | { id: number; error: string };

/**
 * Serves `load()`'s Scorer to every content script of this extension.
 * The model loads once, on the first request. A failed load runs again on the next request.
 * Requests from all tabs run one at a time, in the order they arrive.
 */
export function serveModel(load: () => Promise<Scorer>, name = MODEL_PORT): void {
  let scorer: Promise<Scorer> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const model = () =>
    (scorer ??= (async () => {
      const started = performance.now();
      const loaded = await load();
      // Compile the wasm session (or WebGPU shaders) now, so the load time below is the whole cost.
      await loaded.classify("warm up", "warmup", { a: undefined, b: undefined });
      console.info(`[${name}] model ready in ${Math.round(performance.now() - started)} ms`);
      return loaded;
    })().catch((error: unknown) => {
      scorer = undefined;
      throw error;
    }));

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== name) return;
    let open = true;
    port.onDisconnect.addListener(() => (open = false));
    port.onMessage.addListener((request: Request) => {
      const run = async () => {
        // The tab navigated or closed while this request waited; nobody reads the answer.
        if (!open) return;
        let reply: Reply;
        try {
          if (!methods.includes(request.method)) throw new Error(`Unknown method ${String(request.method)}`);
          const loaded = await model();
          const call = loaded[request.method] as (...args: unknown[]) => Promise<unknown>;
          reply = { id: request.id, result: await call.apply(loaded, request.args) };
        } catch (error) {
          reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
        }
        // The port can close during the call. postMessage then throws; drop the reply.
        if (open) try { port.postMessage(reply); } catch { open = false; }
      };
      queue = queue.then(run, run);
    });
  });
}

/**
 * A Scorer for a content script, served by serveModel() in the background.
 * It connects on the first call. When the port closes (navigation, bfcache,
 * or the event page unloads), the calls in flight reject and the next call connects again.
 */
export function remoteScorer(name = MODEL_PORT): Scorer {
  type Pending = { resolve: (value: never) => void; reject: (error: Error) => void };
  type Connection = { port: chrome.runtime.Port; pending: Map<number, Pending> };
  let current: Connection | undefined;
  let next = 0;

  const connect = (): Connection => {
    const connection: Connection = { port: chrome.runtime.connect({ name }), pending: new Map() };
    connection.port.onMessage.addListener((reply: Reply) => {
      const call = connection.pending.get(reply.id);
      if (!call) return;
      connection.pending.delete(reply.id);
      if ("error" in reply) call.reject(new Error(reply.error));
      else call.resolve(reply.result as never);
    });
    connection.port.onDisconnect.addListener(() => {
      if (current === connection) current = undefined;
      const reason = chrome.runtime.lastError?.message;
      const error = new Error(`The model host disconnected${reason ? `: ${reason}` : ""}`);
      for (const call of connection.pending.values()) call.reject(error);
      connection.pending.clear();
    });
    return connection;
  };

  const call = <T>(method: Method, args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      const connection = (current ??= connect());
      connection.pending.set(id, { resolve: resolve as (value: never) => void, reject });
      try {
        connection.port.postMessage({ id, method, args } satisfies Request);
      } catch (error) {
        // The port closed before its onDisconnect ran. Forget it, so the next call connects again.
        connection.pending.delete(id);
        if (current === connection) current = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  return {
    extractEntities: (text, types, threshold) => call("extractEntities", threshold === undefined ? [text, types] : [text, types, threshold]),
    classify: (text, name, labels) => call("classify", [text, name, labels]),
    classifyMany: (texts, name, labels) => call("classifyMany", [texts, name, labels]),
  };
}
