// Writes or updates <app>-updates.json, the Firefox update manifest for an unlisted app.
// Usage: node scripts/release/updates.mjs <app> <version> <xpi-url> <sha256>
// It reads the file from the current directory when it exists, so older versions stay.
// Format: https://extensionworkshop.com/documentation/manage/updating-your-extension/
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [app, version, updateLink, sha256] = process.argv.slice(2);
if (!app || !version || !updateLink || !sha256) {
  throw new Error("Usage: node scripts/release/updates.mjs <app> <version> <xpi-url> <sha256>");
}
if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`Bad version "${version}".`);
if (!/^https:\/\//.test(updateLink)) throw new Error("The XPI url must use https.");
if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("The sha256 must be 64 lowercase hex digits.");

const manifest = JSON.parse(readFileSync(join(process.cwd(), "apps", app, "public", "manifest.json"), "utf8"));
const id = manifest.browser_specific_settings?.gecko?.id;
if (!id) throw new Error(`apps/${app} manifest has no gecko id.`);

const file = join(process.cwd(), `${app}-updates.json`);
const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { addons: {} };
const updates = (doc.addons[id]?.updates ?? []).filter((u) => u.version !== version);
updates.push({ version, update_link: updateLink, update_hash: `sha256:${sha256}` });
doc.addons[id] = { updates };
writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${file}`);
