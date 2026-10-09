// Runs one step for every app under apps/. Usage: node scripts/apps.mjs build|lint
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const steps = {
  build: (app) => ["node", ["scripts/build.mjs", app]],
  // web-ext rejects gecko.update_url unless told the app is self-hosted (unlisted).
  lint: (app) => ["pnpm", ["exec", "web-ext", "lint", ...(selfHosted(app) ? ["--self-hosted"] : []), "-s", `dist/${app}`]],
};
function selfHosted(app) {
  const manifest = JSON.parse(readFileSync(join(root, "apps", app, "public", "manifest.json"), "utf8"));
  return Boolean(manifest.browser_specific_settings?.gecko?.update_url);
}
const step = steps[process.argv[2]];
if (!step) throw new Error(`Usage: node scripts/apps.mjs ${Object.keys(steps).join("|")}`);

const apps = readdirSync(join(root, "apps")).filter((a) => existsSync(join(root, "apps", a, "app.config.mjs")));
for (const app of apps) {
  console.log(`\n== ${process.argv[2]} ${app} ==`);
  const [cmd, args] = step(app);
  const { status } = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
}
