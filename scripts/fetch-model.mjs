// Downloads a bundled model's files from its pinned Hub revision into
// ~/.cache/foxpilot/models/<repo>@<revision>/ and checks each file's sha256.
// A file that does not match is deleted and the run fails. scripts/build.mjs
// calls fetchModel() for an app whose model has delivery "bundle".
// Usage: node scripts/fetch-model.mjs [name...]. The default is every bundled model.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { models } from "../packages/core/src/model/models.ts";

/** The cache directory of one model. */
export function modelCache(model) {
  return join(homedir(), ".cache/foxpilot/models", `${model.repo}@${model.revision}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Downloads every file of `model` that is not in the cache, checks all of them, and returns the cache directory. */
export async function fetchModel(name) {
  const model = models[name];
  if (!model) throw new Error(`Unknown model ${name}. Known: ${Object.keys(models).join(", ")}.`);
  if (model.delivery !== "bundle" || !model.files) throw new Error(`${name} downloads from the Hub at run time; there is nothing to fetch.`);
  const cache = modelCache(model);
  for (const [file, want] of Object.entries(model.files)) {
    const path = join(cache, file);
    if (!existsSync(path)) {
      const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
      console.log(`fetch ${url}`);
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
      mkdirSync(dirname(path), { recursive: true });
      await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.part`));
      renameSync(`${path}.part`, path);
    }
    const got = await sha256(path);
    if (got !== want) {
      rmSync(path);
      throw new Error(`${name}: ${file} has sha256 ${got}, models.ts pins ${want}. Deleted it.`);
    }
  }
  return cache;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2);
  for (const name of names.length ? names : Object.keys(models).filter((n) => models[n].delivery === "bundle")) {
    console.log(`${name}: ${await fetchModel(name)}`);
  }
}
