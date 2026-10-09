// A goal that names a site ("… on amazon.com") starts there. Only explicit
// domains count: "on amazon" is not guessed into a URL. The domain of an email
// address ("sam@example.com") is not a site, and neither is a name reserved for
// examples (RFC 2606: example.com, example.net, example.org).

const DOMAIN = /(?<![@\w.-])(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|org|net|io|co|ai|dev|app|edu|gov|uk|de|fr|in|ca|au|jp)(?:\.[a-z]{2})?)\b(?![@.-]\w)(?:\/\S*)?/gi;
const RESERVED = /(?:^|\.)example\.(?:com|net|org)$/i;

export type Site = { host: string; url: string; phrase: string };

export function siteIn(goal: string): Site | null {
  const found = [...goal.matchAll(DOMAIN)].find((m) => !RESERVED.test(m[1]!));
  if (!found) return null;
  const host = found[1]!.toLowerCase().replace(/^www\./, "");
  // Include the word that attaches it to the goal ("on", "at", "from", "in").
  const lead = new RegExp(`\\s*\\b(?:on|at|from|in|via|using)\\s+${escape(found[0])}`, "i").exec(goal);
  return { host, url: `https://${found[0].replace(/^https?:\/\//i, "")}`, phrase: lead ? lead[0] : found[0] };
}

/** The goal without the site, when the site is where the run starts. */
export function withoutSite(goal: string, site: Site): string {
  return goal.replace(site.phrase, "").replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}

/** Is this page already on the site (or a subdomain of it)? */
export function onSite(url: string, site: Site): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === site.host || host.endsWith(`.${site.host}`);
  } catch {
    return false;
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
