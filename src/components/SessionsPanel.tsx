import { useMemo, useRef, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  Columns2,
  Copy,
  Download,
  FileInput,
  Folder,
  FolderOpen,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, blankSession, type Session } from "../lib/api";
import { deleteSession, duplicateSession, mergeImported } from "../lib/data";
import { fuzzy } from "../lib/format";
import { get, set, toast, useStore } from "../lib/store";
import { label, openSession, tree, type Tree } from "../lib/terms";
import { Dot, Empty, IconButton, useMenu } from "./ui";

const COLLAPSED_KEY = "tether.collapsed";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export async function runImport(kind: "ssh" | "mobaxterm" | "putty") {
  let path: string | undefined;
  if (kind === "mobaxterm") {
    const p = await pickFile({
      title: "MobaXterm sessions",
      filters: [{ name: "MobaXterm sessions", extensions: ["mxtsessions", "ini"] }],
    });
    if (!p) return;
    path = p as string;
  }
  try {
    const r = await api.import(kind, path);
    const added = mergeImported(r.sessions);
    const what = { ssh: "SSH config", mobaxterm: "MobaXterm", putty: "PuTTY" }[kind];
    if (r.sessions.length === 0) toast(`Nothing to import from ${what}`, "info");
    else toast(`Imported ${added} session${added === 1 ? "" : "s"} from ${what}${added < r.sessions.length ? ` (${r.sessions.length - added} already here)` : ""}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`, "ok", undefined, 6000);
  } catch (e) {
    toast(String(e), "bad");
  }
}

export function SessionsPanel() {
  const sessions = useStore((s) => s.sessions);
  const panes = useStore((s) => s.panes);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [sel, setSel] = useState<string | null>(null);
  const { open: menu, node: menuNode } = useMenu();
  const listRef = useRef<HTMLDivElement>(null);

  const live = useMemo(() => {
    const m = new Map<string, "connecting" | "ready" | "exited">();
    for (const p of Object.values(panes)) {
      if (m.get(p.session.id) !== "ready") m.set(p.session.id, p.status);
    }
    return m;
  }, [panes]);

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    next.has(path) ? next.delete(path) : next.add(path);
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  // flat list of what's visible, for keyboard navigation
  const filtered = useMemo(() => {
    if (!q.trim()) return null;
    return sessions
      .map((s) => ({ s, score: fuzzy(q, `${label(s)} ${s.host} ${s.user} ${s.folder} ${s.device}`) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  }, [q, sessions]);

  const root = useMemo(() => tree(sessions), [sessions]);
  const visible: Session[] = useMemo(() => {
    if (filtered) return filtered;
    // same order as rendered: each level's folders first, then its loose sessions
    const order = (t: Tree): Session[] => [...t.folders.flatMap((f) => (collapsed.has(f.path) ? [] : order(f))), ...t.sessions];
    return order(root);
  }, [filtered, root, collapsed]);

  const sessionMenu = (s: Session) => [
    { label: "Connect", icon: Play, hint: "Enter", run: () => openSession(s) },
    { label: "Connect in split", icon: Columns2, run: () => openSession(s, "row") },
    "-" as const,
    { label: "Edit…", icon: Pencil, run: () => set({ editing: s }) },
    { label: "Duplicate", icon: Copy, run: () => duplicateSession(s) },
    { label: "Copy address", icon: Copy, run: () => writeText(s.protocol === "serial" ? s.device : `${s.user ? s.user + "@" : ""}${s.host}`) },
    "-" as const,
    { label: "Delete", icon: Trash2, danger: true, run: () => deleteSession(s.id) },
  ];

  const onKey = (e: React.KeyboardEvent) => {
    const i = visible.findIndex((s) => s.id === sel);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(visible[Math.min(visible.length - 1, i + 1)]?.id ?? null);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(visible[Math.max(0, i - 1)]?.id ?? null);
    } else if (e.key === "Enter") {
      const s = visible[i] ?? visible[0];
      if (s) openSession(s);
    } else if (e.key === "Delete" && i >= 0) {
      deleteSession(visible[i].id);
    } else if (e.key === "F2" && i >= 0) {
      set({ editing: visible[i] });
    }
  };

  const row = (s: Session, depth: number) => (
    <div
      key={s.id}
      role="treeitem"
      aria-selected={sel === s.id}
      className={`srow ${sel === s.id ? "sel" : ""}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={() => setSel(s.id)}
      onDoubleClick={() => openSession(s)}
      onContextMenu={(e) => {
        setSel(s.id);
        menu(e, sessionMenu(s));
      }}
      title={s.notes || undefined}
    >
      <Dot protocol={s.protocol} color={s.color} state={live.get(s.id)} />
      <span className="srow-name">{label(s)}</span>
      <span className="srow-meta">{s.protocol === "serial" ? s.device : s.protocol === "local" ? "" : s.host}</span>
      <button className="srow-go" aria-label={`Connect to ${label(s)}`} onClick={(e) => { e.stopPropagation(); openSession(s); }}>
        <Play size={11} strokeWidth={2} />
      </button>
    </div>
  );

  const folder = (t: Tree, depth: number): React.ReactNode => (
    <div key={t.path} role="group">
      <div className="frow" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => toggle(t.path)}>
        <ChevronRight size={12} strokeWidth={2} className={`chev ${collapsed.has(t.path) ? "" : "open"}`} />
        {collapsed.has(t.path) ? <Folder size={13} strokeWidth={1.7} /> : <FolderOpen size={13} strokeWidth={1.7} />}
        <span>{t.name}</span>
        <span className="frow-count">{count(t)}</span>
      </div>
      {!collapsed.has(t.path) && (
        <>
          {t.folders.map((f) => folder(f, depth + 1))}
          {t.sessions.map((s) => row(s, depth + 1))}
        </>
      )}
    </div>
  );

  const hasSshConfig = get().boot?.hasSshConfig;

  return (
    <section className="panel" aria-label="Sessions">
      <header className="panel-head">
        <h3>Sessions</h3>
        <div className="panel-actions">
          <IconButton
            icon={FileInput}
            label="Import sessions"
            onClick={(e) =>
              menu(e, [
                { label: "From ~/.ssh/config", icon: Server, run: () => runImport("ssh") },
                { label: "From MobaXterm…", icon: Download, run: () => runImport("mobaxterm") },
                { label: "From PuTTY", icon: Download, run: () => runImport("putty") },
              ])
            }
          />
          <IconButton icon={Plus} label="New session" onClick={() => set({ editing: blankSession("ssh") })} />
        </div>
      </header>
      <div className="panel-search">
        <Search size={13} strokeWidth={2} />
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter") {
            onKey(e);
            listRef.current?.focus();
          }
          if (e.key === "Escape") setQ("");
        }} placeholder="Filter" spellCheck={false} />
      </div>
      <div className="panel-body" role="tree" tabIndex={0} ref={listRef} onKeyDown={onKey}>
        {sessions.length === 0 ? (
          <Empty icon={Server} title="No saved sessions">
            <p>Save the servers you use, or bring them over.</p>
            <div className="empty-actions">
              <button className="link" onClick={() => set({ editing: blankSession("ssh") })}>New session</button>
              {hasSshConfig && <button className="link" onClick={() => runImport("ssh")}>Import ~/.ssh/config</button>}
              <button className="link" onClick={() => runImport("mobaxterm")}>Import from MobaXterm</button>
            </div>
          </Empty>
        ) : filtered ? (
          filtered.length ? filtered.map((s) => row(s, 0)) : <div className="muted pad">Nothing matches “{q}”.</div>
        ) : (
          <>
            {root.folders.map((f) => folder(f, 0))}
            {root.sessions.map((s) => row(s, 0))}
          </>
        )}
      </div>
      {menuNode}
    </section>
  );
}

function count(t: Tree): number {
  return t.sessions.length + t.folders.reduce((n, f) => n + count(f), 0);
}
