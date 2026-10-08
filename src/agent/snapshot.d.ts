import type { Page } from "./types";

/** Reads the page into a Page, or null before the document has a body. */
export function snapshot(): Page | null;
