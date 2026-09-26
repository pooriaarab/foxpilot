// Port of gliner2-ultrafast dates.py (MIT). Dates are ISO strings (YYYY-MM-DD)
// so equality works like Python's date objects.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const DATE = new RegExp(
  `\\b(?:(?<iso>\\d{4}-\\d{1,2}-\\d{1,2})` +
    `|(?<month>${MONTH})[a-z]*\\.?\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(?<year>\\d{4}))?` +
    `|(?<day2>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<month2>${MONTH})[a-z]*\\.?(?:,?\\s+(?<year2>\\d{4}))?` +
    `|(?<m>\\d{1,2})/(?<d>\\d{1,2})/(?<y>\\d{4}))\\b`,
  "i",
);

export type IsoDate = string;

function iso(year: number, month: number, day: number): IsoDate | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The first date in the text, or null. A missing year is this year or next. */
export function firstDate(text: unknown, today: Date = new Date()): IsoDate | null {
  const found = DATE.exec(String(text ?? ""));
  if (!found?.groups) return null;
  const g = found.groups;
  if (g.iso) {
    const [year, month, day] = g.iso.split("-").map(Number) as [number, number, number];
    return iso(year, month, day);
  }
  if (g.m) return iso(Number(g.y), Number(g.m), Number(g.d));
  const month = MONTHS.indexOf((g.month ?? g.month2 ?? "").slice(0, 3).toLowerCase()) + 1;
  const day = Number(g.day ?? g.day2);
  const year = g.year ?? g.year2;
  if (month < 1) return null;
  const thisYear = today.getFullYear();
  let parsed = iso(year ? Number(year) : thisYear, month, day);
  if (!parsed) return null;
  // An undated "20 September" that has already passed means the next one.
  const todayIso = iso(thisYear, today.getMonth() + 1, today.getDate())!;
  if (!year && parsed < todayIso) parsed = iso(thisYear + 1, month, day);
  return parsed;
}

/** The typed value in ISO form, when it is the date the task asked for. */
export function normalise(typed: string, wanted: IsoDate | null | undefined): string {
  if (!wanted) return typed;
  // Zipline: a writer may echo the goal's words ("1st Friday of next month").
  return resolveDate(typed) === wanted ? wanted : typed;
}

/** Does this control's name mean exactly the date the task asked for? */
export function sameDate(label: string, wanted: IsoDate | null | undefined): boolean {
  if (!wanted) return false;
  const found = firstDate(label);
  return found !== null && found === wanted;
}

// Zipline addition: dates said the way people say them. Resolved against today
// in code; GLiNER2 only has to see that "the 1st Friday of next month" is a date.
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day)?";
const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1,
};
const ORDINAL = Object.keys(ORDINALS).join("|");
const NUMBERS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const day = (name: string) => WEEKDAYS.indexOf(name.slice(0, 3));
const at = (year: number, month: number, date: number) => new Date(Date.UTC(year, month, date));
const isoOf = (d: Date) => iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());

/** The nth weekday (1-based, -1 for the last) of a month, or null if there is none. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date | null {
  if (n === -1) {
    const last = at(year, month + 1, 0);
    return at(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
  }
  const first = at(year, month, 1);
  const date = 1 + ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7;
  const found = at(year, month, date);
  return found.getUTCMonth() === month ? found : null;
}

/**
 * "tomorrow", "next Friday", "the 1st Friday of next month", "the last Monday
 * of October", "in 2 weeks". "Next Friday" is the first Friday after today;
 * "this Friday" can be today.
 */
export function relativeDate(text: unknown, today: Date = new Date()): IsoDate | null {
  const t = String(text ?? "").toLowerCase();
  const base = at(today.getFullYear(), today.getMonth(), today.getDate());
  const plus = (days: number) => isoOf(at(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));

  const nth = new RegExp(`\\b(${ORDINAL})\\s+${WEEKDAY}\\s+(?:of|in)\\s+(?:(this|next)\\s+month|(${MONTH})[a-z]*\\.?(?:,?\\s+(\\d{4}))?)\\b`).exec(t);
  if (nth) {
    const [, ordinal, weekday, which, monthName, year] = nth;
    let y = base.getUTCFullYear();
    let m = base.getUTCMonth();
    if (which === "next") m += 1;
    else if (monthName) {
      m = MONTHS.indexOf(monthName.slice(0, 3));
      if (year) y = Number(year);
      else if (m < base.getUTCMonth()) y += 1;
    }
    const found = nthWeekday(at(y, m, 1).getUTCFullYear(), at(y, m, 1).getUTCMonth(), day(weekday!), ORDINALS[ordinal!]!);
    return found ? isoOf(found) : null;
  }
  if (/\bday after tomorrow\b/.test(t)) return plus(2);
  if (/\btomorrow\b/.test(t)) return plus(1);
  if (/\b(today|tonight)\b/.test(t)) return plus(0);
  const later = /\bin\s+(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week)s?\b/.exec(t);
  if (later) {
    const n = NUMBERS[later[1]!] ?? Number(later[1]);
    return plus(later[2] === "week" ? n * 7 : n);
  }
  // Full names only: "Sun Valley" and "Sat" are not dates.
  const named = /\b(?:(this|next|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (named) {
    const ahead = (day(named[2]!) - base.getUTCDay() + 7) % 7;
    return plus(named[1] === "this" ? ahead : ahead || 7);
  }
  return null;
}

/** A calendar date if the text has one, otherwise a relative one. */
export function resolveDate(text: unknown, today: Date = new Date()): IsoDate | null {
  return firstDate(text, today) ?? relativeDate(text, today);
}
