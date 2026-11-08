// xterm.js instances live here, outside React, so splitting and re-rendering never loses a terminal.
// Also: opening, splitting, reconnecting and closing tabs.

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, newId, NIL, type EngineEvent, type Session } from "./api";
import { fromSystem, isLight, SCHEMES } from "./themes";
import {
  activePane,
  get,
  leaves,
  patchPane,
  paneByTerm,
  replaceLeaf,
  set,
  toast,
  type Layout,
  type Pane,
  type Tab,
} from "./store";

export interface XT {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  webgl: WebglAddon | null;
  cwdTimer: number | null;
}

const xts = new Map<string, XT>();

export function xt(pane: string): XT | undefined {
  return xts.get(pane);
}

export function ensureXterm(pane: string): XT {
  return xts.get(pane) ?? makeXterm(pane);
}

export const TERMINAL_KINDS = new Set(["ssh", "local", "telnet", "serial", "mosh"]);

export function currentTheme(): ITheme {
  const s = get().settings;
  const sys = get().systemTheme;
  const id = s?.terminal_theme ?? "system";
  if (id === "system") {
    if (sys) return fromSystem(sys);
    return (document.documentElement.dataset.theme === "light" ? SCHEMES[2] : SCHEMES[0]).theme;
  }
  return (SCHEMES.find((x) => x.id === id) ?? SCHEMES[0]).theme;
}

export function terminalIsLight(): boolean {
  return isLight(currentTheme().background);
}

function makeXterm(pane: string): XT {
  const s = get().settings!;
  const term = new Terminal({
    fontFamily: `"${s.font_family}", "JetBrains Mono", ui-monospace, monospace`,
    fontSize: s.font_size,
    lineHeight: s.line_height,
    cursorStyle: s.cursor_style,
    cursorBlink: s.cursor_blink,
    cursorInactiveStyle: "outline",
    scrollback: s.scrollback,
    allowProposedApi: true,
    allowTransparency: false,
    macOptionIsMeta: true,
    rightClickSelectsWord: !s.right_click_paste,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    smoothScrollDuration: 0,
    theme: currentTheme(),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon((e, uri) => {
    if (e.ctrlKey || e.metaKey) openUrl(uri).catch(() => {});
  }));
  const host = document.createElement("div");
  host.className = "xterm-host";
  term.open(host);
  let webgl: WebglAddon | null = null;
  if (!(window as { __tetherNoWebgl?: boolean }).__tetherNoWebgl) try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl?.dispose();
      webgl = null;
    });
    term.loadAddon(webgl);
  } catch {
    webgl = null;
  }

  // copy on select, Ctrl+Shift+C/V, right click paste
  term.onSelectionChange(() => {
    if (get().settings?.copy_on_select && term.hasSelection()) writeText(term.getSelection()).catch(() => {});
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && k === "c") {
      if (term.hasSelection()) writeText(term.getSelection()).catch(() => {});
      return false;
    }
    if (e.ctrlKey && e.shiftKey && k === "v") {
      readText().then((t) => t && term.paste(t)).catch(() => {});
      return false;
    }
    // let app shortcuts through (they're handled on window)
    if ((e.ctrlKey && e.shiftKey) || (e.ctrlKey && ["tab", "pageup", "pagedown"].includes(k))) return false;
    if (e.ctrlKey && (k === "k" || k === ",")) return false;
    return true;
  });
  host.addEventListener("contextmenu", (e) => {
    if (!get().settings?.right_click_paste) return;
    e.preventDefault();
    if (term.hasSelection()) {
      writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
    } else {
      readText().then((t) => t && term.paste(t)).catch(() => {});
    }
  });

  // OSC 7 (file://host/path) from shells that announce their folder
  term.parser.registerOscHandler(7, (data) => {
    try {
      const u = new URL(data);
      patchPane(pane, { cwd: decodeURIComponent(u.pathname) });
    } catch {
      /* not a URL */
    }
    return true;
  });
  term.onTitleChange(() => set({}));
  term.onBell(() => {
    const b = get().settings?.bell;
    if (b === "visual") {
      host.classList.remove("bell");
      void host.offsetWidth;
      host.classList.add("bell");
    }
  });

  const x: XT = { term, fit, search, host, webgl, cwdTimer: null };
  term.onData((d) => sendInput(pane, d));
  term.onResize(({ cols, rows }) => {
    const p = get().panes[pane];
    patchPane(pane, { size: [cols, rows] });
    if (p?.term != null && p.status !== "exited") api.termResize(p.term, cols, rows).catch(() => {});
  });
  xts.set(pane, x);
  return x;
}

function sendInput(pane: string, d: string) {
  const s = get();
  const p = s.panes[pane];
  if (!p || p.term == null) return;
  if (p.status === "exited") {
    // "press R to reconnect"
    if (d === "r" || d === "R" || d === "\r") reconnect(pane);
    return;
  }
  if (s.multiExec) {
    const ids = Object.values(s.panes).filter((q) => q.term != null && q.status === "ready" && TERMINAL_KINDS.has(q.session.protocol)).map((q) => q.term!);
    api.termWriteMany(ids, d).catch(() => {});
  } else {
    api.termWrite(p.term, d).catch(() => {});
  }
  // after Enter, the folder may have changed: ask (debounced)
  if (d.includes("\r") && p.session.protocol === "ssh") {
    const x = xts.get(pane);
    if (x) {
      if (x.cwdTimer) clearTimeout(x.cwdTimer);
      x.cwdTimer = window.setTimeout(async () => {
        const q = get().panes[pane];
        if (!q?.term) return;
        const cwd = await api.remoteCwd(q.term).catch(() => null);
        if (cwd && cwd !== get().panes[pane]?.cwd) patchPane(pane, { cwd });
      }, 450);
    }
  }
}

export function retheme() {
  const theme = currentTheme();
  const s = get().settings!;
  for (const x of xts.values()) {
    x.term.options.theme = theme;
    x.term.options.fontFamily = `"${s.font_family}", "JetBrains Mono", ui-monospace, monospace`;
    x.term.options.fontSize = s.font_size;
    x.term.options.lineHeight = s.line_height;
    x.term.options.cursorStyle = s.cursor_style;
    x.term.options.cursorBlink = s.cursor_blink;
    x.term.options.scrollback = s.scrollback;
    try {
      x.fit.fit();
    } catch {
      /* not visible */
    }
  }
  document.documentElement.style.setProperty("--term-bg", theme.background ?? "#0b0c0e");
}

function size(): [number, number] {
  const p = activePane();
  const x = p && xts.get(p.key);
  if (x) return [x.term.cols, x.term.rows];
  return [120, 32];
}

function newPane(session: Session, tab: string): Pane {
  return {
    key: newId(),
    tab,
    session,
    term: null,
    status: "connecting",
    statusText: session.protocol === "local" ? "" : `Connecting to ${label(session)}…`,
    remote: null,
    exit: null,
    cwd: null,
    size: size(),
    viewer: session.protocol === "rdp",
    connected: false,
  };
}

export function label(s: Session): string {
  if (s.name) return s.name;
  if (s.protocol === "local") return s.command ? s.command.split(/\s+/)[0].split(/[\\/]/).pop()! : "Terminal";
  if (s.protocol === "serial") return s.device;
  return s.user ? `${s.user}@${s.host}` : s.host;
}

async function start(pane: Pane) {
  const s = pane.session;
  const [cols, rows] = pane.size;
  if (TERMINAL_KINDS.has(s.protocol)) {
    const x = ensureXterm(pane.key);
    try {
      const id = await api.termOpen(s, cols, rows, (d) => x.term.write(d));
      patchPane(pane.key, { term: id });
    } catch (e) {
      patchPane(pane.key, { status: "exited", exit: { code: null, reason: String(e) } });
    }
  } else {
    try {
      const id = await api.termOpen(s, cols, rows, () => {});
      patchPane(pane.key, { term: id });
    } catch (e) {
      patchPane(pane.key, { status: "exited", exit: { code: null, reason: String(e) } });
    }
  }
}

/** Open a session in a new tab (or as a split of the active pane). */
export function openSession(session: Session, split?: "row" | "column") {
  const s = get();
  const tabNow = s.tabs.find((t) => t.key === s.activeTab);
  if (split && tabNow) {
    const pane = newPane(session, tabNow.key);
    const layout = replaceLeaf(tabNow.layout, tabNow.active, {
      type: "split",
      dir: split,
      a: { type: "leaf", pane: tabNow.active },
      b: { type: "leaf", pane: pane.key },
      ratio: 0.5,
    })!;
    set((st) => ({
      panes: { ...st.panes, [pane.key]: pane },
      tabs: st.tabs.map((t) => (t.key === tabNow.key ? { ...t, layout, active: pane.key } : t)),
    }));
    start(pane);
    return pane.key;
  }
  const tab: Tab = { key: newId(), layout: { type: "leaf", pane: "" }, active: "" };
  const pane = newPane(session, tab.key);
  tab.layout = { type: "leaf", pane: pane.key };
  tab.active = pane.key;
  set((st) => ({ tabs: [...st.tabs, tab], activeTab: tab.key, panes: { ...st.panes, [pane.key]: pane } }));
  start(pane);
  if (session.id !== NIL && session.protocol !== "local") {
    // remember it was used (sorting "recent")
    set((st) => ({ sessions: st.sessions.map((x) => (x.id === session.id ? { ...x, last_used: Math.floor(Date.now() / 1000) } : x)) }));
  }
  return pane.key;
}

/** Split the focused pane: same server (reusing its login), or the same local shell. */
export async function splitActive(dir: "row" | "column") {
  const p = activePane();
  if (!p) return;
  if (p.session.protocol === "ssh" && p.term != null && p.status === "ready") {
    const s = get();
    const tab = s.tabs.find((t) => t.key === p.tab)!;
    const pane = newPane(p.session, tab.key);
    const layout = replaceLeaf(tab.layout, tab.active, {
      type: "split",
      dir,
      a: { type: "leaf", pane: tab.active },
      b: { type: "leaf", pane: pane.key },
      ratio: 0.5,
    })!;
    set((st) => ({
      panes: { ...st.panes, [pane.key]: pane },
      tabs: st.tabs.map((t) => (t.key === tab.key ? { ...t, layout, active: pane.key } : t)),
    }));
    const x = makeXterm(pane.key);
    try {
      const id = await api.termDuplicate(p.term, pane.size[0], pane.size[1], (d) => x.term.write(d));
      patchPane(pane.key, { term: id });
    } catch (e) {
      patchPane(pane.key, { status: "exited", exit: { code: null, reason: String(e) } });
    }
    return;
  }
  if (TERMINAL_KINDS.has(p.session.protocol)) openSession({ ...p.session }, dir);
}

/** Same server in a new tab. */
export async function duplicateTab(pane: string) {
  const p = get().panes[pane];
  if (!p) return;
  if (p.session.protocol === "ssh" && p.term != null && p.status === "ready") {
    const tab: Tab = { key: newId(), layout: { type: "leaf", pane: "" }, active: "" };
    const np = newPane(p.session, tab.key);
    tab.layout = { type: "leaf", pane: np.key };
    tab.active = np.key;
    set((st) => ({ tabs: [...st.tabs, tab], activeTab: tab.key, panes: { ...st.panes, [np.key]: np } }));
    const x = makeXterm(np.key);
    try {
      const id = await api.termDuplicate(p.term, np.size[0], np.size[1], (d) => x.term.write(d));
      patchPane(np.key, { term: id });
    } catch (e) {
      patchPane(np.key, { status: "exited", exit: { code: null, reason: String(e) } });
    }
  } else {
    openSession({ ...p.session });
  }
}

export function reconnect(pane: string) {
  const p = get().panes[pane];
  if (!p) return;
  const x = xts.get(pane);
  if (p.term == null) {
    patchPane(pane, { status: "connecting", exit: null });
    start({ ...p, status: "connecting" });
    return;
  }
  x?.term.write("\r\n");
  patchPane(pane, { status: "connecting", exit: null, statusText: `Reconnecting to ${label(p.session)}…`, remote: null });
  const [cols, rows] = x ? [x.term.cols, x.term.rows] : p.size;
  api.termReconnect(p.term, cols, rows).catch((e) => patchPane(pane, { status: "exited", exit: { code: null, reason: String(e) } }));
}

export function closePane(pane: string) {
  const s = get();
  const p = s.panes[pane];
  if (!p) return;
  if (p.term != null) api.termClose(p.term).catch(() => {});
  const x = xts.get(pane);
  if (x) {
    x.term.dispose();
    xts.delete(pane);
  }
  const tab = s.tabs.find((t) => t.key === p.tab);
  const panes = { ...s.panes };
  delete panes[pane];
  // forget prompts for it
  const prompts = s.prompts.filter((q) => q.term !== p.term);
  if (!tab) return set({ panes, prompts });
  const layout = replaceLeaf(tab.layout, pane, null);
  if (!layout) {
    const idx = s.tabs.findIndex((t) => t.key === tab.key);
    const tabs = s.tabs.filter((t) => t.key !== tab.key);
    const next = s.activeTab === tab.key ? (tabs[idx] ?? tabs[idx - 1] ?? null)?.key ?? null : s.activeTab;
    set({ panes, tabs, activeTab: next, prompts });
  } else {
    const active = tab.active === pane ? leaves(layout)[0] : tab.active;
    set({ panes, prompts, tabs: s.tabs.map((t) => (t.key === tab.key ? { ...t, layout, active } : t)) });
  }
}

/** Close a tab, asking first if it's connected somewhere and the user wants to be asked. */
export function requestCloseTab(tabKey: string) {
  const s = get();
  const tab = s.tabs.find((t) => t.key === tabKey);
  if (!tab) return;
  const live = leaves(tab.layout).map((k) => s.panes[k]).filter((p) => p && p.status === "ready" && p.session.protocol !== "local");
  if (s.settings?.confirm_close && live.length) set({ confirmClose: { tab: tabKey, names: live.map((p) => label(p!.session)).join(", ") } });
  else closeTab(tabKey);
}

export function closeTab(tabKey: string) {
  const tab = get().tabs.find((t) => t.key === tabKey);
  if (!tab) return;
  for (const p of leaves(tab.layout)) closePane(p);
}

export function focusPane(pane: string) {
  const p = get().panes[pane];
  if (!p) return;
  set((s) => ({ activeTab: p.tab, tabs: s.tabs.map((t) => (t.key === p.tab ? { ...t, active: pane } : t)) }));
  xts.get(pane)?.term.focus();
}

export function focusActive() {
  const p = activePane();
  if (p) requestAnimationFrame(() => xts.get(p.key)?.term.focus());
}

export function sendText(text: string, run: boolean, all = false) {
  const s = get();
  const data = run ? text.replace(/\n?$/, "\r") : text;
  if (all) {
    const ids = Object.values(s.panes).filter((q) => q.term != null && q.status === "ready" && TERMINAL_KINDS.has(q.session.protocol)).map((q) => q.term!);
    api.termWriteMany(ids, data).catch(() => {});
    return;
  }
  const p = activePane();
  if (p?.term != null && p.status === "ready") {
    const x = xts.get(p.key);
    if (x) x.term.paste(run ? text.replace(/\n$/, "") : text);
    if (run) api.termWrite(p.term, "\r").catch(() => {});
    focusActive();
  }
}

// ---------------------------------------------------------------- engine events

const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

export function handleEngine(e: EngineEvent) {
  switch (e.type) {
    case "status": {
      const p = paneByTerm(e.term);
      if (p) patchPane(p.key, { statusText: e.text });
      break;
    }
    case "ready": {
      const p = paneByTerm(e.term);
      if (!p) break;
      patchPane(p.key, { status: "ready", statusText: "", remote: e.remote, cwd: e.remote?.home ?? null, connected: true });
      const sftpFirst = p.session.protocol === "sftp";
      set((s) => ({
        filesPath: { ...s.filesPath, [p.key]: e.remote?.home ?? "/" },
        filesFollow: { ...s.filesFollow, [p.key]: p.session.follow_cwd },
        panel: sftpFirst ? "files" : s.panel,
      }));
      if (get().activeTab === p.tab) focusActive();
      break;
    }
    case "exit": {
      const p = paneByTerm(e.term);
      if (!p) break;
      patchPane(p.key, { status: "exited", exit: { code: e.code, reason: e.reason } });
      const x = xts.get(p.key);
      if (x) {
        const why = e.reason ? e.reason : e.code != null ? `exit ${e.code}` : "closed";
        x.term.write(`\r\n${ANSI_DIM}── session ended · ${why} · press R to reconnect ──${ANSI_RESET}\r\n`);
      }
      // drop questions this tab was asking
      set((s) => ({ prompts: s.prompts.filter((q) => q.term !== e.term) }));
      break;
    }
    case "viewerExit": {
      const p = paneByTerm(e.term);
      if (p) patchPane(p.key, { status: "exited", exit: { code: e.code, reason: "window closed" } });
      break;
    }
    case "prompt":
      set((s) => ({ prompts: [...s.prompts.filter((q) => q.id !== e.id), { id: e.id, term: e.term, prompt: e.prompt }] }));
      break;
    case "promptDone":
      set((s) => ({ prompts: s.prompts.filter((q) => q.id !== e.id) }));
      break;
    case "tunnel":
      set((s) => ({ tunnelStates: { ...s.tunnelStates, [e.id]: e.state } }));
      break;
    case "transfer": {
      const { type: _t, ...t } = e;
      set((s) => ({ transfers: { ...s.transfers, [t.id]: t } }));
      if (t.state === "done") {
        toast(`${t.direction === "download" ? "Downloaded" : "Uploaded"} ${t.label}`, "ok",
          t.direction === "download" && t.dest ? { label: "Show", run: () => api.reveal(t.dest).catch(() => {}) } : undefined);
        setTimeout(() => set((s) => {
          const n = { ...s.transfers };
          delete n[t.id];
          return { transfers: n };
        }), 2500);
      } else if (t.state === "failed") {
        toast(`${t.label}: ${t.error ?? "failed"}`, "bad", undefined, 8000);
      }
      break;
    }
    case "editSynced":
      if (e.error) toast(`Couldn't save ${e.path.split("/").pop()}: ${e.error}`, "bad", undefined, 8000);
      else toast(`Saved ${e.path.split("/").pop()} to the server`, "ok", undefined, 2200);
      break;
    case "themeChanged":
      set({ systemTheme: e.theme });
      if ((get().settings?.terminal_theme ?? "system") === "system") retheme();
      break;
  }
}

/** The folder tree as nested folders → sessions (for the Sessions panel). */
export type Tree = { name: string; path: string; folders: Tree[]; sessions: Session[] };

export function tree(sessions: Session[]): Tree {
  const root: Tree = { name: "", path: "", folders: [], sessions: [] };
  for (const s of sessions) {
    let node = root;
    const parts = s.folder.split("/").map((x) => x.trim()).filter(Boolean);
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let next = node.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path, folders: [], sessions: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.sessions.push(s);
  }
  const sort = (t: Tree) => {
    t.folders.sort((a, b) => a.name.localeCompare(b.name));
    t.sessions.sort((a, b) => label(a).localeCompare(label(b)));
    t.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function layoutOf(tabKey: string): Layout | null {
  return get().tabs.find((t) => t.key === tabKey)?.layout ?? null;
}
