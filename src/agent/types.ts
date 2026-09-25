// Shapes produced by snapshot.js and recorded by the agent loop.

export type Action = {
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "key" | "wait";
  label: string;
  node?: number;
  document_id?: number;
  role?: string;
  value?: string;
  current_value?: string;
  section?: string;
  form?: number;
  submit?: boolean;
  dialog?: boolean;
  offscreen?: boolean;
  self_link?: boolean;
  suggestion_for?: number;
  delta?: number;
  rect?: { x: number; y: number; w: number; h: number };
};

export type Page = {
  url: string;
  title: string;
  text: string;
  actions: Action[];
  marker: unknown;
  page_key: unknown[];
  guards: Record<string, unknown>;
  fingerprint?: string;
};

export type HistoryEntry = {
  action: string;
  node?: number | null;
  document_id?: number | null;
  requirement?: string | null;
  kind: string;
  form?: number | null;
  submit?: boolean;
  committed_field?: string | null;
  text?: string | null;
  [key: string]: unknown;
};
