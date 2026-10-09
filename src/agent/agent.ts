// Port of gliner2-ultrafast agent.py (MIT): the agent loop. Observe, choose,
// act, record; typed choices, observable state, bounded execution.
import { parseAsk } from "./ask";
import type { ModelCall } from "../model/gliner2";
import { TabBrowser, StalePage } from "./browser";
import { choose, requirements, sends, type Decision, type Memory, type Part, type Scorer } from "./controller";
import { firstDate, normalise } from "./dates";
import { MASK, policy, type Policy } from "./policy";
import { Refused, type FieldContext, type FieldWriter } from "./fieldtext";
import { searchQuery } from "./search";
import { stripQualifiers } from "./pick";
import type { Action, HistoryEntry, Page } from "./types";
import { verify, type Verdict } from "./verify";

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
  /** Where this step's time went, in ms: deciding (GLiNER2 calls), acting, reading the page after. */
  timing?: Timing;
};

export type Timing = { decide: number; calls: number; model: number; labels: number; act: number; observe: number };

/** A decision the stale check stopped: the step it was for, its target, and the check that failed. */
export type Refusal = { step: number; target: string | null; reason: string };

export type AgentView = {
  status: Status;
  goal: string;
  parts: Part[];
  history: Step[];
  decision: Decision | null;
  textCalls: { field: string; value?: string; error?: string; ms?: number }[];
  refusals: Refusal[];
  elapsedMs: number;
  modelMs: number;
  message?: string;
  /** The finished page checked against the goal (set when the run ends early on it). */
  verdict?: Verdict;
  /** Every decision with the page's actions, for debugging. */
  decisions?: (Decision & { served: string[]; actions: string[]; ms?: number; calls?: number })[];
};

export type SpansFound = Map<string, string>;

/** The most recent field a value was typed into. */
function lastFill(history: HistoryEntry[]) {
  return [...history].reverse().find((h) => h.kind === "fill") ?? null;
}

/** The page's controls by kind and label, ignoring text and geometry. */
function controls(page: Page): string {
  return JSON.stringify(page.actions.map((a) => [a.kind, a.label, a.value ?? null]));
}

function opensMenu(action: Action) {
  return action.kind === "click" && (action.expanded !== undefined || action.haspopup !== undefined || action.role === "combobox");
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

const SETTLE_MS = 1000;

const hasControls = (page: Page) => page.actions.some((a) => a.kind === "click" || a.kind === "fill" || a.kind === "select");

/** A step that sent a form: a real submit, Enter, or a click on its Search button. */
function sent(entry: Step): boolean {
  return Boolean(entry.submit) || (entry.kind === "click" && sends({ kind: "click", label: entry.action } as Action));
}

export class Agent {
  private memory: Memory = new Map();
  private refused = new Set<string>();
  private served = new Set<string>();
  private fruitless = 0;
  private startedAt: number | null = null;
  private page!: Page;
  private timing: Timing | null = null;
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
    private readonly rules: Policy,
    private readonly calls: ModelCall[] | null,
  ) {
    this.view = { status: "ready", goal, parts, history: [], decision: null, textCalls: [], refusals: [], elapsedMs: 0, modelMs: 0 };
  }

  /** Reads the goal's requirements once (before the clock starts) and observes the tab. */
  static async create(
    model: Scorer, browser: TabBrowser, goal: string,
    makeWriter: (parts: Part[], found: SpansFound, model: Scorer) => FieldWriter, onUpdate: (view: AgentView) => void,
    calls: ModelCall[] | null = null,
  ): Promise<Agent> {
    const task = goal.trim();
    if (!task) throw new Error("Type a goal first");
    const found: SpansFound = new Map();
    const recording: Scorer = {
      extractEntities: async (text, types, threshold) => {
        const entities = await model.extractEntities(text, types, threshold);
        for (const spans of Object.values(entities)) for (const span of spans) found.set(span.text.toLowerCase(), span.text);
        return entities;
      },
      classify: (text, name, labels) => model.classify(text, name, labels),
    };
    // Qualifiers ("cheapest", "morning") choose among results; they are not field
    // values. In an ask that dictates values, "time: Morning" is one.
    const { values } = parseAsk(task);
    const parts = await requirements(values.length ? task : stripQualifiers(task) || task, recording);
    // A dictated value is typed as written, not as GLiNER2 cased its span.
    for (const value of values) found.set(value.value.toLowerCase(), value.value);
    const agent = new Agent(model, browser, task, parts, makeWriter(parts, found, model), onUpdate, found, policy(task), calls);
    // A page that just loaded may not have drawn its controls yet (a site
    // opened for the goal); give it up to 3 s before judging it.
    agent.page = await browser.observe();
    for (let waited = 0; waited < 3000 && !hasControls(agent.page); waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      agent.page = await browser.observe();
    }
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
    let decision: Decision | null = null;
    try {
      await this.predict();
      decision = this.view.decision;
      const before = this.view.history.length;
      await this.act();
      this.fruitless = this.view.history.length > before ? 0 : this.fruitless + 1;
    } catch (error) {
      if (!(error instanceof StalePage)) throw error;
      this.view.refusals.push({ step: this.view.history.length + 1, target: decision?.target ?? null, reason: error.message });
      this.fruitless += 1;
      this.view.decision = null;
      this.view.status = "ready";
      // The page was still moving. Read it once it is quiet: if its labels are
      // the same, every score is in memory and the redo costs no model call.
      this.page = await this.browser.observe(true);
    }
  }

  /** Every path here has just observed the page. The stale check before input catches later changes. */
  private async predict() {
    if (this.view.history.length >= MAX_STEPS) {
      this.view.status = "blocked";
      throw new Error(`Stopped at the ${MAX_STEPS}-action budget`);
    }
    const stats = { calls: 0, model: 0, labels: 0 };
    const counted: Scorer = {
      extractEntities: async (text, types, threshold) => {
        const started = performance.now();
        try { return await this.model.extractEntities(text, types, threshold); }
        finally { stats.calls++; stats.model += performance.now() - started; stats.labels = Math.max(stats.labels, Object.keys(types).length); }
      },
      classify: async (text, name, labels) => {
        const started = performance.now();
        try { return await this.model.classify(text, name, labels); }
        finally { stats.calls++; stats.model += performance.now() - started; stats.labels = Math.max(stats.labels, Object.keys(labels).length); }
      },
    };
    const started = performance.now();
    const mark = this.calls?.length ?? 0;
    const decision = await choose(counted, this.page, this.view.history, this.memory, this.refused, this.parts, this.served, this.view.goal, this.rules);
    const decide = Math.round(performance.now() - started);
    // Training data: tie each call this decision made to what it chose.
    if (this.calls) {
      const step = this.view.history.length + 1;
      for (const call of this.calls.slice(mark)) {
        call.decision = { step, choice: decision.choice, operation: decision.operation, target: decision.target, requirement: decision.requirement };
      }
    }
    this.timing = { decide, calls: stats.calls, model: Math.round(stats.model), labels: stats.labels, act: 0, observe: 0 };
    this.view.modelMs += decision.latencyMs;
    this.view.decision = decision;
    this.view.decisions = [...(this.view.decisions ?? []), { ...decision, served: [...this.served], actions: this.page.actions.map((a) => `${a.id} ${a.kind} ${a.label}`), ms: decide, calls: stats.calls }];
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
        // Live pages change text on their own; what matters for "nothing
        // left to do" is that the controls it judged are still the same.
        const now = await this.browser.observe();
        if (controls(now) !== controls(page)) {
          this.page = now;
          this.view.status = "ready";
          throw new StalePage("Page changed since the decision. Choose again.");
        }
      }
      this.view.status = selected === "DONE" ? "done" : "blocked";
      if (selected === "BLOCKED" && !hasControls(page)) {
        this.view.message = `No buttons, links or fields on "${page.title || page.url}": still loading, or a robot check`;
      }
      return;
    }
    const action = page.actions.find((a) => a.id === selected)!;
    let text: string | null = null;
    let textMs = 0;
    if (action.kind === "fill") {
      const context: FieldContext = {
        goal: this.view.goal,
        requirement: decision.requirement,
        field: { label: action.label, role: action.role, value: action.value },
        page: { title: page.title, text: page.text.slice(0, 6000) },
        recent_actions: this.view.history.slice(-6).map((h) => ({ action: h.action, text: h.text })),
        date: decision.date,
        candidates: (this.parts.find((p) => p.text === decision.requirement)?.values ?? []).map((v) => this.surfaces.get(v) ?? v),
        textFields: new Set(page.actions.filter((a) => a.kind === "fill").map((a) => a.node)).size,
      };
      const started = performance.now();
      try {
        // A password field takes the password the ask dictates; no writer sees it.
        text = action.secret ? this.rules.password : normalise(await this.writer.write(context), decision.date);
        if (text == null) throw new Refused("The goal dictates no password");
        // The password goes into a password field only, never into one the page shows.
        if (!action.secret && this.rules.password && text.includes(this.rules.password)) {
          throw new Refused("The value holds the password and the field is not a password field");
        }
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        // The goal supplies no value for this field. Nothing is guessed; the
        // field stops being offered and the run goes on.
        this.refused.add(action.label);
        this.view.status = "ready";
        this.view.textCalls.push({ field: action.label, error: error.message });
        // The writer took time; the next decision reads the page as it is now.
        this.page = await this.browser.observe();
        return;
      }
      textMs = Math.round(performance.now() - started);
      this.view.textCalls.push({ field: action.label, value: action.secret ? MASK : text, ms: textMs });
      // The whole goal went in as a search query, so every part of it is asked;
      // what is left is submitting it, not clicking results that name a part.
      if (text === searchQuery(this.view.goal)) for (const part of this.parts) this.served.add(part.text);
    }
    const acting = performance.now();
    const navigations = this.browser.navigations;
    await this.browser.act(action, page, text);
    const act = Math.round(performance.now() - acting);
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
      form: action.kind === "key" ? (lastFill(history)?.form ?? null) : (action.form ?? null),
      submit: Boolean(action.submit || action.kind === "key"),
      // Taking a suggestion commits the field it completes, not the form around it.
      committed_field: decision.commits ? (lastFill(history)?.action ?? null) : null,
      committed_node: decision.commits ? (lastFill(history)?.node ?? null) : null,
      text: action.secret ? MASK : text,
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
    const observing = performance.now();
    this.page = await this.browser.observe();
    // What the committed field shows once the suggestion is taken; verify()
    // trusts this node even if the page renames it later.
    if (entry.committed_node != null) {
      entry.committed_value = this.page.actions.find((a) =>
        a.kind === "fill" && a.node === entry.committed_node && a.document_id === entry.document_id)?.value ?? null;
    }
    if (this.timing) entry.timing = { ...this.timing, act, observe: Math.round(performance.now() - observing) };
    for (const done of completedDates(this.parts, this.page, history)) this.served.add(done);
    // A control that opened a menu or picker has not answered its requirement yet.
    // Zipline addition: nor has one that opens a menu at all (aria-expanded,
    // aria-haspopup, combobox), even if the menu had not rendered when observed.
    if (decision.covered.length && !opensDialog(this.page) && !opensMenu(action)) {
      for (const c of decision.covered) this.served.add(c);
    }
    entry.pageChanged = this.page.fingerprint !== page.fingerprint;
    entry.elapsedMs = this.elapsed();
    const repeated = history.slice(-3);
    this.view.status =
      repeated.length === 3 && repeated.every((h) => h.pageChanged === false && h.kind !== "wait") ? "blocked" : "ready";
    if (this.view.status === "blocked") this.view.message = "Three actions in a row changed nothing";
    // Parts without a value ("Book me a flight") are left to the page check, and
    // so is a value typed then sent with Enter (Google Maps' destination is never
    // "served": no suggestion was taken).
    else if (sent(entry) && this.parts.every((p) => this.served.has(p.text) || (!p.values.length && !p.date) ||
      history.some((h) => h.kind === "fill" && h.requirement === p.text))) {
      await this.finishIfVerified(navigations);
    }
  }

  /**
   * Zipline addition: the Python loop ends after two waits and two scrolls find
   * nothing left to do (2–4 s on Google Flights). Once every value is entered and
   * the form was just sent, the finished page is checked instead; if it shows
   * the goal, the run ends there. Results get up to a second to finish loading first.
   */
  private async finishIfVerified(navigations: number) {
    // A search that loads a new page (Amazon) leaves the old one up for a
    // moment; checking it would verify and read the page the search came from.
    await this.browser.settleNavigation(navigations);
    // Wait until two looks in a row read the same page (results done loading), at most SETTLE_MS.
    const until = performance.now() + SETTLE_MS;
    let previous = this.page.fingerprint;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      this.page = await this.browser.observe();
      if (this.page.fingerprint === previous || performance.now() >= until) break;
      previous = this.page.fingerprint;
    }
    const verdict = await verify(this.model, this.page, this.parts, this.view.history);
    if (!verdict.verified) return;
    this.view.verdict = verdict;
    this.view.status = "done";
  }
}
