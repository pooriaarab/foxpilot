// Loads the model an app picked in app.config.mjs. scripts/build.mjs puts its
// models.ts entry in __MODEL__; the app passes that here.
import { env } from "@huggingface/transformers";
import { Gliner2 } from "./gliner2";
import { Gliner25 } from "./gliner25";
import type { Model } from "./models";

export type AppModel = Model & { name: string };

export async function loadModel(model: AppModel, progress_callback?: (info: unknown) => void): Promise<Gliner2> {
  const options = { device: model.device, dtype: model.dtype, progress_callback };
  const Runtime = model.decoder === "gliner25" ? Gliner25 : Gliner2;
  if (model.delivery === "hub") return Runtime.load(model.repo, { ...options, revision: model.revision });
  // scripts/build.mjs copied the files to models/<name>/ in the extension. Never ask the Hub.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = chrome.runtime.getURL("models/");
  return Runtime.load(model.name, options);
}
