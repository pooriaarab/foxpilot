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
  return firstDate(typed) === wanted ? wanted : typed;
}

/** Does this control's name mean exactly the date the task asked for? */
export function sameDate(label: string, wanted: IsoDate | null | undefined): boolean {
  if (!wanted) return false;
  const found = firstDate(label);
  return found !== null && found === wanted;
}
