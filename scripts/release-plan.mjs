// Plans a release. An app ships when no tag "<app>-v<version>" exists on origin.
// Writes `apps` (a JSON matrix of {app, version, channel}) to $GITHUB_OUTPUT.
// An app changed since its last tag with no version bump gets a warning.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const matrix = [];
for (const app of readdirSync(join(root, "apps")).sort()) {
  if (!existsSync(join(root, "apps", app, "app.config.mjs"))) continue;
  const { version } = readJson(`apps/${app}/public/manifest.json`);
  const { channel } = readJson(`apps/${app}/listing/amo.json`);
  if (channel !== "listed" && channel !== "unlisted") {
    throw new Error(`apps/${app}/listing/amo.json: channel must be "listed" or "unlisted", got ${JSON.stringify(channel)}.`);
  }
  const tag = `${app}-v${version}`;
  if (!git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) {
    matrix.push({ app, version, channel });
    continue;
  }
  // Released already. Warn when the code moved on without a version bump.
  const changed = git("diff", "--name-only", `refs/tags/${tag}`, "HEAD", "--", `apps/${app}`, "packages");
  if (changed) {
    console.log(`::warning title=${app} changed without a version bump::${app} changed since ${tag}. Bump apps/${app}/public/manifest.json to release it.`);
  }
}

if (matrix.length === 0) console.log("::notice::Nothing to release. Every app version already has a tag.");
else console.log(`Releasing: ${matrix.map((m) => `${m.app} ${m.version} (${m.channel})`).join(", ")}`);
const line = `apps=${JSON.stringify(matrix)}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
else process.stdout.write(line);
