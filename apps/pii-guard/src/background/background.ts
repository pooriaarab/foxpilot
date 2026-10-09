// Will run the model for the content script. No detection yet (B2).
import type { AppModel } from "@foxpilot/core/model/load";

declare const __MODEL__: AppModel;

console.assert(__MODEL__.name === "foxmind-small");
