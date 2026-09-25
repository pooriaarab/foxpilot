// Port of gliner2-ultrafast agent.py (MIT): the agent loop. Observe, choose,
// act, record; typed choices, observable state, bounded execution.
import { TabBrowser, StalePage } from "./browser";
import { choose, requirements, type Decision, type Memory, type Part, type Scorer } from "./controller";
import { firstDate, normalise } from "./dates";
import { Refused, type FieldContext, type FieldWriter } from "./fieldtext";
import type { HistoryEntry, Page } from "./types";

export const MAX_STEPS = 60;
/** Consecutive decisions that reach no execution before the run is called stuck. */
export const FRUITLESS = 14;

export type Status = "ready" | "predicted" | "done" | "blocked" | "stopped" | "error";

export type Step = HistoryEntry & {
  step: number;
  operation: string;
  target: string | null;
  confidence: number;
  latencyMs: number;
  textMs: number;
  textWriter: string | null;
  elapsedMs: number;
  pageChanged: boolean | null;
};

export type AgentView = {
  status: Status;
  goal: string;
  parts: Part[];
  history: Step[];
  decision: Decision | null;
  textCalls: { field: string; value?: string; error?: string; ms?: number }[];
  elapsedMs: number;
  modelMs: number;
  message?: string;
  /** Every decision with the page's actions, for debugging. */
  decisions?: (Decision & { served: string[]; actions: string[] })[];
};

export type SpansFound = Map<string, string>;

/** The form of the most recent field a value was typed into. */
function committed(history: HistoryEntry[]) {
  return [...history].reverse().find((h) => h.kind === "fill")?.form ?? null;
}

/** The name of the most recent field a value was typed into. */
function filledLabel(history: HistoryEntry[]) {
  return [...history].reverse().find((h) => h.kind === "fill")?.action ?? null;
}

function opensDialog(page: Page) {
  return page.actions.some((a) => a.dialog);
}

/** A date requirement is complete when its assigned field shows that date. */
function completedDates(parts: Part[], page: Page, history: HistoryEntry[]): Set<string> {
  const completed = new Set<string>();
  if (opensDialog(page)) return completed;
  for (const part of parts) {
    if (!part.date) continue;
    for (const target of history.filter((h) => h.requirement === part.text && h.kind === "fill")) {
      for (const action of page.actions) {
        if (action.kind !== "fill") continue;
        const sameNode = target.node != null && target.document_id != null &&
          target.node === action.node && target.document_id === action.document_id;
        if ((sameNode || target.action === action.label) && firstDate(action.value) === part.date) completed.add(part.text);
      }
    }
  }
  return completed;
}

export class Agent {
  private memory: Memory = new Map();
  private refused = new Set<string>();
  private served = new Set<string>();
  private fruitless = 0;
  private startedAt: number | null = null;
  private page!: Page;
  private stopRequested = false;
  view: AgentView;

  private constructor(
    private readonly model: Scorer,
    private readonly browser: TabBrowser,
    goal: string,
    private readonly parts: Part[],
    private readonly writer: FieldWriter,
    private readonly onUpdate: (view: AgentView) => void,
    private readonly surfaces: SpansFound,
  ) {
    this.view = { status: "ready", goal, parts, history: [], decision: null, textCalls: [], elapsedMs: 0, modelMs: 0 };
  }

  /** Reads the goal's requirements once (before the clock starts) and observes the tab. */
  static async create(
    model: Scorer, browser: TabBrowser, goal: string,
    makeWriter: (parts: Part[], found: SpansFound) => FieldWriter, onUpdate: (view: AgentView) => void,
  ): Promise<Agent> {
    const task = goal.trim();
    if (!task) throw new Error("Type a goal first");
    const found: SpansFound = new Map();
    const recording: Scorer = {
      extractEntities: async (text, types) => {
        const entities = await model.extractEntities(text, types);
        for (const spans of Object.values(entities)) for (const span of spans) found.set(span.text.toLowerCase(), span.text);
        return entities;
      },
      classify: (text, name, labels) => model.classify(text, name, labels),
    };
    const parts = await requirements(task, recording);
    const agent = new Agent(model, browser, task, parts, makeWriter(parts, found), onUpdate, found);
    agent.page = await browser.observe();
    return agent;
  }

  stop() {
    this.stopRequested = true;
  }

  private elapsed() {
    return Math.round(performance.now() - (this.startedAt ?? performance.now()));
  }

  private emit(message?: string) {
    this.view = { ...this.view, elapsedMs: this.elapsed(), message };
    this.onUpdate(this.view);
  }

  async run(): Promise<AgentView> {
    this.startedAt = performance.now();
    this.emit();
    try {
      while (!["done", "blocked", "stopped"].includes(this.view.status)) {
        if (this.stopRequested) {
          this.view.status = "stopped";
          break;
        }
        await this.tick();
        this.emit();
      }
    } catch (error) {
      this.view.status = this.view.status === "blocked" ? "blocked" : "error";
      this.emit(error instanceof Error ? error.message : String(error));
      return this.view;
    }
    this.emit();
    return this.view;
  }

  private async tick() {
    if (this.fruitless >= FRUITLESS) {
      this.view.status = "blocked";
      throw new Error(`Stopped after ${FRUITLESS} decisions that could not be executed`);
    }
    try {
      await this.predict();
      const before = this.view.history.length;
      await this.act();
      this.fruitless = this.view.history.length > before ? 0 : this.fruitless + 1;
    } catch (error) {
      if (!(error instanceof StalePage)) throw error;
      this.fruitless += 1;
      this.view.decision = null;
      this.view.status = "ready";
      this.page = await this.browser.observe();
    }
  }

  private async predict() {
    if (!(await this.browser.fresh(this.page))) this.page = await this.browser.observe();
    if (this.view.history.length >= MAX_STEPS) {
      this.view.status = "blocked";
      throw new Error(`Stopped at the ${MAX_STEPS}-action budget`);
    }
    const decision = await choose(this.model, this.page, this.view.history, this.memory, this.refused, this.parts, this.served);
    this.view.modelMs += decision.latencyMs;
    this.view.decision = decision;
    this.view.decisions = [...(this.view.decisions ?? []), { ...decision, served: [...this.served], actions: this.page.actions.map((a) => `${a.id} ${a.kind} ${a.label}`) }];
    this.view.status = "predicted";
    this.emit();
  }

  private async act() {
    const decision = this.view.decision!;
    const page = this.page;
    // Consume once, before any mutation or model call. A retry cannot double-click.
    this.view.decision = null;
    const selected = decision.choice;
    if (selected === "DONE" || selected === "BLOCKED") {
      if (!(await this.browser.fresh(page))) {
        this.view.status = "ready";
        throw new StalePage("Page changed since the decision. Choose again.");
      }
      this.view.status = selected === "DONE" ? "done" : "blocked";
      return;
    }
    const action = page.actions.find((a) => a.id === selected)!;
    let text: string | null = null;
    let textMs = 0;
    if (action.kind === "fill") {
      if (!(await this.browser.fresh(page))) throw new StalePage("Page changed before text generation. Choose again.");
      const context: FieldContext = {
        goal: this.view.goal,
        requirement: decision.requirement,
        field: { label: action.label, role: action.role, value: action.value },
        page: { title: page.title, text: page.text.slice(0, 6000) },
        recent_actions: this.view.history.slice(-6).map((h) => ({ action: h.action, text: h.text })),
        date: decision.date,
        candidates: (this.parts.find((p) => p.text === decision.requirement)?.values ?? []).map((v) => this.surfaces.get(v) ?? v),
      };
      const started = performance.now();
      try {
        text = normalise(await this.writer.write(context), decision.date);
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        // The goal supplies no value for this field. Nothing is guessed; the
        // field stops being offered and the run goes on.
        this.refused.add(action.label);
        this.view.status = "ready";
        this.view.textCalls.push({ field: action.label, error: error.message });
        return;
      }
      textMs = Math.round(performance.now() - started);
      this.view.textCalls.push({ field: action.label, value: text, ms: textMs });
    }
    await this.browser.act(action, page, text);
    const history = this.view.history;
    const entry: Step = {
      step: history.length + 1,
      action: action.label,
      node: action.node ?? null,
      document_id: action.document_id ?? null,
      requirement: decision.requirement,
      kind: action.kind,
      // A suggestion sits in its own popup form; what it commits is the form of
      // the field that was just typed into.
      form: action.kind === "key" ? committed(history) : (action.form ?? null),
      submit: Boolean(action.submit || action.kind === "key"),
      // Taking a suggestion commits the field it completes, not the form around it.
      committed_field: decision.commits ? filledLabel(history) : null,
      text,
      operation: decision.operation,
      target: decision.target,
      confidence: decision.confidence,
      latencyMs: decision.latencyMs,
      textMs,
      textWriter: text != null ? this.writer.name : null,
      elapsedMs: this.elapsed(),
      pageChanged: null,
    };
    history.push(entry);
    this.emit();
    this.page = await this.browser.observe();
    for (const done of completedDates(this.parts, this.page, history)) this.served.add(done);
    // A control that opened a menu or picker has not answered its requirement yet.
    if (decision.covered.length && !opensDialog(this.page)) for (const c of decision.covered) this.served.add(c);
    entry.pageChanged = this.page.fingerprint !== page.fingerprint;
    entry.elapsedMs = this.elapsed();
    const repeated = history.slice(-3);
    this.view.status =
      repeated.length === 3 && repeated.every((h) => h.pageChanged === false && h.kind !== "wait") ? "blocked" : "ready";
    if (this.view.status === "blocked") this.view.message = "Three actions in a row changed nothing";
  }
}
