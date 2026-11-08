// App state in one small store. Components read slices with useStore(selector).

import { useRef, useSyncExternalStore } from "react";
import type {
  Boot,
  PromptKind,
  RemoteInfo,
  Session,
  Settings,
  Snippet,
  TerminalTheme,
  TransferEvent,
  Tunnel,
  TunnelState,
} from "./api";

export type PaneStatus = "connecting" | "ready" | "exited";

export interface Pane {
  key: string;
  tab: string;
  session: Session;
  term: number | null;
  status: PaneStatus;
  statusText: string;
  remote: RemoteInfo | null;
  exit: { code: number | null; reason: string } | null;
  cwd: string | null;
  /** cols×rows, for the status bar */
  size: [number, number];
  /** an external viewer window (RDP) */
  viewer: boolean;
  /** got as far as a working session at least once */
  connected: boolean;
}

export type Layout =
  | { type: "leaf"; pane: string }
  | { type: "split"; dir: "row" | "column"; a: Layout; b: Layout; ratio: number };

export interface Tab {
  key: string;
  layout: Layout;
  active: string; // focused pane
}

export interface Prompt {
  id: number;
  term: number | null;
  prompt: PromptKind;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "ok" | "bad";
  action?: { label: string; run: () => void };
}

export type PanelId = "sessions" | "files" | "tunnels" | "snippets";

export interface State {
  booted: boolean;
  boot: Boot | null;
  sessions: Session[];
  tunnels: Tunnel[];
  snippets: Snippet[];
  settings: Settings | null;
  systemTheme: TerminalTheme | null;

  tabs: Tab[];
  activeTab: string | null;
  panes: Record<string, Pane>;

  panel: PanelId | null;
  prompts: Prompt[];
  tunnelStates: Record<string, TunnelState>;
  transfers: Record<string, TransferEvent>;
  toasts: Toast[];

  multiExec: boolean;
  palette: boolean;
  editing: Session | null;
  settingsOpen: boolean;
  /** folder shown by the Files panel per pane */
  filesPath: Record<string, string>;
  filesFollow: Record<string, boolean>;
  /** pane whose find bar is open */
  searching: string | null;
  /** asking before closing a connected tab */
  confirmClose: { tab: string; names: string } | null;
}

let state: State = {
  booted: false,
  boot: null,
  sessions: [],
  tunnels: [],
  snippets: [],
  settings: null,
  systemTheme: null,
  tabs: [],
  activeTab: null,
  panes: {},
  panel: "sessions",
  prompts: [],
  tunnelStates: {},
  transfers: {},
  toasts: [],
  multiExec: false,
  palette: false,
  editing: null,
  settingsOpen: false,
  filesPath: {},
  filesFollow: {},
  searching: null,
  confirmClose: null,
};

const subs = new Set<() => void>();

export function get(): State {
  return state;
}

export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  subs.forEach((f) => f());
}

export function subscribe(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Read a slice. Selectors may build new arrays/objects: equal-looking results keep their identity. */
export function useStore<T>(sel: (s: State) => T): T {
  const last = useRef<{ state: State; value: T } | null>(null);
  const snapshot = () => {
    const prev = last.current;
    if (prev && prev.state === state) return prev.value;
    const value = sel(state);
    if (prev && shallowEqual(prev.value, value)) {
      last.current = { state, value: prev.value };
      return prev.value;
    }
    last.current = { state, value };
    return value;
  };
  return useSyncExternalStore(subscribe, snapshot);
}

export function patchPane(key: string, patch: Partial<Pane>) {
  set((s) => (s.panes[key] ? { panes: { ...s.panes, [key]: { ...s.panes[key], ...patch } } } : {}));
}

export function paneByTerm(term: number): Pane | undefined {
  return Object.values(state.panes).find((p) => p.term === term);
}

export function activePane(): Pane | undefined {
  const tab = state.tabs.find((t) => t.key === state.activeTab);
  return tab ? state.panes[tab.active] : undefined;
}

let toastSeq = 1;
export function toast(text: string, tone: Toast["tone"] = "info", action?: Toast["action"], ms = 4200) {
  const id = toastSeq++;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone, action }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function leaves(l: Layout): string[] {
  return l.type === "leaf" ? [l.pane] : [...leaves(l.a), ...leaves(l.b)];
}

/** Replace the leaf `pane` with `next` (used to split and to remove panes). */
export function replaceLeaf(l: Layout, pane: string, next: Layout | null): Layout | null {
  if (l.type === "leaf") return l.pane === pane ? next : l;
  const a = replaceLeaf(l.a, pane, next);
  const b = replaceLeaf(l.b, pane, next);
  if (!a) return b;
  if (!b) return a;
  return { ...l, a, b };
}

export function setRatio(l: Layout, path: string, ratio: number): Layout {
  if (l.type === "leaf") return l;
  if (path === "") return { ...l, ratio };
  const [head, ...rest] = path.split(".");
  return head === "a" ? { ...l, a: setRatio(l.a, rest.join("."), ratio) } : { ...l, b: setRatio(l.b, rest.join("."), ratio) };
}
