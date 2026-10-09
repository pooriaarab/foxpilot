// What the ask allows the agent to do to the user's account and money.
// Controls that sign in, sign out, subscribe, buy or delete are blocked unless
// a step of the ask names the verb. A prohibition in the ask ("Do NOT place
// the order", "Do not use Accept all") always blocks. A goal that asks for
// none of them leaves every one blocked.

/** What logs, traces and the panel show in place of a password. */
export const MASK = "•••";

export type Policy = {
  /** Verbs that a step of the ask names and no prohibition names. */
  allowed: ReadonlySet<string>;
  /** The text of each prohibition, from its verb to the end of the sentence. */
  prohibited: string[];
  /** The password the ask dictates, or null. */
  password: string | null;
};

export const CLOSED: Policy = { allowed: new Set(), prohibited: [], password: null };

/**
 * Each verb: the control labels it covers, the step that allows it (at the
 * head of a clause, base form), and any mention of it, which a prohibition
 * uses to block it. "Getting rid of it by deleting the node" is not a step.
 */
const VERBS: { name: string; label: RegExp; step: RegExp; mention: RegExp }[] = [
  { name: "sign in", label: /\b(sign ?in|log ?in)\b/i, step: /^((sign|log) ?in(to)?|login)\b/i,
    mention: /\b(sign|log)(s|ged|ging|ing|ed)? ?in\b|\blogins?\b/i },
  { name: "sign out", label: /\b(sign ?out|log ?out)\b/i, step: /^((sign|log) ?out|logout)\b/i,
    mention: /\b(sign|log)(s|ged|ging|ing|ed)? ?out\b|\blogouts?\b/i },
  { name: "sign up", label: /\bsign ?up\b/i, step: /^sign ?up\b/i, mention: /\bsign(s|ing|ed)? ?up\b/i },
  { name: "subscribe", label: /\bsubscribe\b/i, step: /^subscribe\b/i, mention: /\b(subscrib(e|ing)|subscriptions?)\b/i },
  { name: "unsubscribe", label: /\bunsubscribe\b/i, step: /^unsubscribe\b/i, mention: /\bunsubscrib(e|es|ed|ing)\b/i },
  { name: "delete", label: /\b(delete|remove account)\b/i, step: /^(delete|remove (my |the |this |your )?account)\b/i,
    mention: /\b(delet(e|es|ed|ing)|remov(e|ing) (my |the |this |your )?account)\b/i },
  { name: "track prices", label: /\btrack prices?\b/i, step: /^track (the )?prices?\b/i, mention: /\btrack(ing)? (the )?prices?\b/i },
  { name: "buy", label: /\b(buy now|purchase|pay now)\b/i,
    step: /^((confirm|complete|make) (the |this |my |your )?purchase|(buy|pay) now)\b/i,
    mention: /\b(buy|buying|bought|purchas(e|es|ed|ing)|pay|paying)\b/i },
  { name: "place order", label: /\b(place|submit|confirm) (your |the |my |this )?order\b/i,
    step: /^(place|submit|confirm) (this |the |my |your |an |our )?order\b/i,
    mention: /\b(plac(e|es|ed|ing)|submit(s|ted|ting)?|confirm(s|ed|ing)?) (this |the |my |your |an |our |any )?(more )?orders?\b/i },
  { name: "checkout", label: /\bcheckout\b/i, step: /^(checkout|(proceed|go|continue) (through|to) (the )?checkout)\b/i,
    mention: /\b(check ?out|checkout)\b/i },
  { name: "book", label: /\b(book now|book with|reserve now|continue to book(ing)?)\b/i,
    step: /^((complete|confirm|finish) (the |my |this |your )?(booking|reservation)|(book|reserve) now)\b/i,
    mention: /\b(book(s|ed|ing)?|reserv(e|es|ed|ing|ation))\b/i },
];

const SENTENCE = /(?<=[.!?])\s+|[\n;]+/;
const CLAUSE = /,\s+|:\s+|\s+[—–-]\s+|\s+(?:and|then|or)\s+/i;
// Words before the verb of a step: "Then log out", "Fully unsubscribe", "IMPORTANT: do not".
const FILLER = /^(?:(?:and|then|also|first|next|finally|please|now|but|so|important|note|fully|only|just|simply|carefully|immediately|you|must|should|need to|have to|want to|try to|go ahead and)\b[\s,!]*)+/i;
const NEGATION = /^(?:do\s+not|don['’]?t|never|avoid|without)\s+/i;
// A prohibition that starts with one of these verbs names its object, not the verb.
const GENERIC = new Set(["click", "press", "use", "tap", "select", "choose", "hit", "pick", "open", "go", "touch"]);
const STOP = new Set(["the", "a", "an", "any", "your", "my", "our", "this", "that", "to", "of", "for", "and", "or", "now", "here", "please", "button", "link"]);
// "the password field" names the field, not a password.
const NOT_A_PASSWORD = /^(field|box|input|is|and|for|to|the|with|of|on|reset|manager|page|screen|form|prompt)$/i;

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Read the ask once, before the run. */
export function policy(ask: string): Policy {
  const steps: string[] = [];
  const prohibited: string[] = [];
  for (const sentence of ask.split(SENTENCE)) {
    const clauses = sentence.split(CLAUSE).map((c) => c.trim().replace(FILLER, ""));
    // Everything after "do not" in a sentence is prohibited: "Do not sign in and subscribe".
    const at = clauses.findIndex((c) => NEGATION.test(c));
    steps.push(...(at < 0 ? clauses : clauses.slice(0, at)));
    if (at >= 0) prohibited.push(clauses.slice(at).join(" ").replace(NEGATION, ""));
  }
  const allowed = new Set(
    VERBS.filter((v) => steps.some((s) => v.step.test(s)) && !prohibited.some((p) => v.mention.test(p))).map((v) => v.name),
  );
  const said = /\bpass(?:word|phrase)\s*(?:is\s+)?[:=]?\s*(?:"([^"]+)"|'([^']+)'|“([^”]+)”|(\S+))/i.exec(ask);
  const quoted = said?.[1] ?? said?.[2] ?? said?.[3];
  const bare = said?.[4]?.replace(/[.,;:!?)\]]+$/, "");
  const password = quoted ?? (bare && !NOT_A_PASSWORD.test(bare) ? bare : null);
  return { allowed, prohibited, password };
}

/** A prohibition names the control: by a quoted label, by every word of the label, or by its verb. */
function forbids(prohibition: string, label: string): boolean {
  const lowered = label.toLowerCase();
  for (const [, quoted] of prohibition.matchAll(/["“']([^"”']+)["”']/g)) {
    if (quoted && lowered.includes(quoted.toLowerCase().trim())) return true;
  }
  const said = new Set(words(prohibition));
  const named = words(label).filter((w) => !STOP.has(w));
  if (named.length && named.every((w) => said.has(w))) return true;
  const verb = words(prohibition)[0];
  return Boolean(verb && !GENERIC.has(verb) && named[0] === verb);
}

/** True when the ask does not allow this control. */
export function blocks(rules: Policy, action: { label: string; secret?: boolean }): boolean {
  if (rules.prohibited.some((p) => forbids(p, action.label))) return true;
  // A password field takes only a dictated password, and only when the ask signs in.
  if (action.secret && !(rules.password && rules.allowed.has("sign in"))) return true;
  return VERBS.some((v) => v.label.test(action.label) && !rules.allowed.has(v.name));
}
