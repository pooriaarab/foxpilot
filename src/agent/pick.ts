// "Cheapest", "morning", "nonstop"…: goals that ask for one row out of a list
// of results. Qualifiers come from the goal with plain rules; each row's price,
// departure time and duration are read with GLiNER2 extraction; filtering and
// ranking are code, not the model.

export type Order = "price-asc" | "price-desc" | "duration-asc" | "depart-asc" | "depart-desc";
export type Qualifiers = { order?: Order; window?: [number, number]; windowName?: string; nonstop?: boolean };
export type Row = { i: number; text: string; price?: number; depart?: number; duration?: number; nonstop: boolean };

const WINDOWS: Record<string, [number, number]> = {
  morning: [5 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 21 * 60],
  night: [21 * 60, 5 * 60],
};

export function qualifiers(goal: string): Qualifiers | null {
  const g = goal.toLowerCase();
  const q: Qualifiers = {};
  if (/\b(cheapest|lowest[- ]priced?|least expensive|lowest (price|fare|cost))\b/.test(g)) q.order = "price-asc";
  else if (/\b(most expensive|priciest|highest[- ]priced?)\b/.test(g)) q.order = "price-desc";
  else if (/\b(fastest|shortest|quickest)\b/.test(g)) q.order = "duration-asc";
  else if (/\bearliest\b/.test(g)) q.order = "depart-asc";
  else if (/\b(latest|last)\b/.test(g)) q.order = "depart-desc";
  for (const [name, window] of Object.entries(WINDOWS)) {
    if (new RegExp(`\\b${name}\\b`).test(g)) {
      q.window = window;
      q.windowName = name;
      break;
    }
  }
  if (/\b(nonstop|non-stop|direct)\b/.test(g)) q.nonstop = true;
  return q.order || q.window || q.nonstop ? q : null;
}

export function parseMoney(text: string | undefined): number | undefined {
  const m = text?.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

/** "6:00 AM" → minutes after midnight. */
export function parseClock(text: string | undefined): number | undefined {
  const m = text?.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/i) ?? text?.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return undefined;
  let hours = Number(m[1]) % 24;
  const minutes = Number(m[2] ?? 0);
  if (m[3]) hours = (hours % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
  return hours * 60 + minutes;
}

/** "6 hr 14 min" → minutes. */
export function parseDuration(text: string | undefined): number | undefined {
  const m = text?.match(/(?:(\d+)\s*h(?:r|ours?)?)?\s*(?:(\d+)\s*m(?:in)?)?/i);
  if (!m || (!m[1] && !m[2])) return undefined;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

function inWindow(minutes: number, [start, end]: [number, number]): boolean {
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** The row the qualifiers ask for, in document order among equals; null if none qualifies. */
export function choose(rows: Row[], q: Qualifiers): Row | null {
  let pool = rows.filter((r) => r.price !== undefined || r.depart !== undefined);
  if (q.window) pool = pool.filter((r) => r.depart !== undefined && inWindow(r.depart, q.window!));
  if (q.nonstop) pool = pool.filter((r) => r.nonstop);
  const key: Record<Order, (r: Row) => number | undefined> = {
    "price-asc": (r) => r.price,
    "price-desc": (r) => (r.price === undefined ? undefined : -r.price),
    "duration-asc": (r) => r.duration,
    "depart-asc": (r) => r.depart,
    "depart-desc": (r) => (r.depart === undefined ? undefined : -r.depart),
  };
  if (q.order) {
    const k = key[q.order];
    pool = pool.filter((r) => k(r) !== undefined).sort((a, b) => k(a)! - k(b)! || a.i - b.i);
  }
  return pool[0] ?? null;
}

export function describe(q: Qualifiers, row: Row): string {
  const order: Record<Order, string> = {
    "price-asc": "Cheapest", "price-desc": "Most expensive", "duration-asc": "Fastest",
    "depart-asc": "Earliest", "depart-desc": "Latest",
  };
  const words = [q.order ? order[q.order] : "Best", q.windowName, q.nonstop ? "nonstop" : undefined, "option"].filter(Boolean);
  const title = words.join(" ");
  return row.price !== undefined ? `${title[0]!.toUpperCase()}${title.slice(1)} · $${row.price}` : title;
}
