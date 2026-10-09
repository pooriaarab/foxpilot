// Background page. The refusal logic comes in later issues (C2, C3).
import type { AppModel } from "@foxpilot/core/model/load";

/** app.config.mjs `model`, set by scripts/build.mjs from packages/core/src/model/models.ts. */
declare const __MODEL__: AppModel;

console.debug(`consent-shield: bundled model ${__MODEL__.name}`);
