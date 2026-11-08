import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownUp,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  Download,
  FileInput,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderX,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, blankSession, type Protocol, type Session } from "../lib/api";
import { deleteFolder, deleteSession, duplicateSession, mergeImported, moveSessions, renameFolder } from "../lib/data";
import { ago, fuzzy } from "../lib/format";
import { get, set, toast, useStore } from "../lib/store";
import { label, natural, openSession, tree, type Tree } from "../lib/terms";
import { Dot, Empty, IconButton, useMenu, type MenuEntry } from "./ui";

const COLLAPSED_KEY = "tether.collapsed";
const VIEW_KEY = "tether.sessionView";
const FOLDERS_KEY = "tether.folders";

type SortKey = "name" | "address" | "recent" | "protocol";
type GroupKey = "folder" | "protocol" | "none";
type View = { sort: SortKey; group: GroupKey };

const PROTOCOLS: Protocol[] = ["ssh", "sftp", "mosh", "rdp", "vnc", "telnet", "serial", "local"];
const PROTOCOL_NAME: Record<Protocol, string> = { ssh: "SSH", sftp: "SFTP", mosh: "Mosh", rdp: "RDP", vnc: "VNC", telnet: "Telnet", serial: "Serial", local: "Local" };
const DEFAULT_PORT: Partial<Record<Protocol, number>> = { ssh: 22, sftp: 22, mosh: 22, telnet: 23, rdp: 3389, vnc: 5900 };

const address = (s: Session) => (s.protocol === "serial" ? s.device : s.host);
const byName = (a: Session, b: Session) => natural(label(a), label(b));
const ORDER: Record<SortKey, (a: Session, b: Session) => number> = {
  name: byName,
  address: (a, b) => natural(address(a), address(b)) || a.port - b.port || byName(a, b),
  recent: (a, b) => b.last_used - a.last_used || byName(a, b),
  protocol: (a, b) => PROTOCOLS.indexOf(a.protocol) - PROTOCOLS.indexOf(b.protocol) || byName(a, b),
};

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
function loadList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not kept; fine */
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

/** A folder being named: a new one under `parent`, or the existing one at `path`. */
type Naming = { parent: string; path: string | null; move?: string };
type Drag = { id: string; label: string; x: number; y: number; over: string | null };

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
const isVirtual = (path: string) => path.startsWith("#");

export function SessionsPanel() {
  const sessions = useStore((s) => s.sessions);
  const panes = useStore((s) => s.panes);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsedState] = useState(() => new Set(loadList(COLLAPSED_KEY)));
  const [view, setViewState] = useState<View>(() => load(VIEW_KEY, { sort: "name", group: "folder" } as View));
  const [extras, setExtrasState] = useState(() => loadList(FOLDERS_KEY));
  const [naming, setNaming] = useState<Naming | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const { open: menu, node: menuNode } = useMenu();
  const listRef = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);

  const setCollapsed = (next: Set<string>) => {
    setCollapsedState(next);
    keep(COLLAPSED_KEY, [...next]);
  };
  const setView = (v: Partial<View>) => {
    const next = { ...view, ...v };
    setViewState(next);
    keep(VIEW_KEY, next);
  };
  const setExtras = (next: string[]) => {
    const uniq = [...new Set(next)];
    setExtrasState(uniq);
    keep(FOLDERS_KEY, uniq);
  };

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
  };

  const filtered = useMemo(() => {
    if (!q.trim()) return null;
    return sessions
      .map((s) => ({ s, score: fuzzy(q, `${label(s)} ${s.host} ${s.user} ${s.folder} ${s.device}`) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  }, [q, sessions]);

  const root: Tree = useMemo(() => {
    const order = ORDER[view.sort];
    if (view.group === "folder") return tree(sessions, order, extras);
    if (view.group === "protocol") {
      const folders = PROTOCOLS.map((p) => ({ name: PROTOCOL_NAME[p], path: `#${p}`, folders: [], sessions: sessions.filter((s) => s.protocol === p).sort(order) }))
        .filter((f) => f.sessions.length);
      return { name: "", path: "", folders, sessions: [] };
    }
    return { name: "", path: "", folders: [], sessions: [...sessions].sort(order) };
  }, [sessions, view, extras]);

  /** every real folder path, for "Move to folder" */
  const folderPaths = useMemo(() => {
    const out: string[] = [];
    const walk = (t: Tree) => t.folders.forEach((f) => (out.push(f.path), walk(f)));
    walk(tree(sessions, undefined, extras));
    return out;
  }, [sessions, extras]);

  const visible: Session[] = useMemo(() => {
    if (filtered) return filtered;
    const order = (t: Tree): Session[] => [...t.folders.flatMap((f) => (collapsed.has(f.path) ? [] : order(f))), ...t.sessions];
    return order(root);
  }, [filtered, root, collapsed]);

  // ---- folders

  const commitName = (raw: string) => {
    const n = naming;
    setNaming(null);
    const name = raw.replace(/\//g, " ").trim();
    if (!n || !name) return;
    const path = join(n.parent, name);
    if (n.path === null) {
      setExtras([...extras, path]);
      if (n.move) moveSessions([n.move], path);
    } else if (path !== n.path) {
      if (folderPaths.includes(path)) return toast(`There's already a folder called ${name}`, "bad");
      renameFolder(n.path, path);
      const moved = (p: string) => (p === n.path || p.startsWith(`${n.path}/`) ? path + p.slice(n.path!.length) : p);
      setExtras(extras.map(moved));
      setCollapsed(new Set([...collapsed].map(moved)));
    }
    if (n.parent && collapsed.has(n.parent)) toggle(n.parent);
  };

  const removeFolder = (t: Tree) => {
    const n = count(t);
    const undo = deleteFolder(t.path);
    const before = extras;
    setExtras(extras.filter((p) => p !== t.path && !p.startsWith(`${t.path}/`)));
    toast(n ? `Removed ${t.name}; its ${n} session${n === 1 ? "" : "s"} moved up` : `Removed ${t.name}`, "info", { label: "Undo", run: () => (undo(), setExtras(before)) }, 6000);
  };

  const connectAll = (t: Tree) => {
    const all = (x: Tree): Session[] => [...x.sessions, ...x.folders.flatMap(all)];
    all(t).filter((s) => s.protocol !== "rdp").forEach((s) => openSession(s));
  };

  const folderMenu = (t: Tree): MenuEntry[] => {
    const n = count(t);
    if (isVirtual(t.path)) return [{ label: `Connect all (${n})`, icon: Play, disabled: !n, run: () => connectAll(t) }];
    return [
      { label: `Connect all (${n})`, icon: Play, disabled: !n, run: () => connectAll(t) },
      { label: "New folder inside", icon: FolderPlus, run: () => { if (collapsed.has(t.path)) toggle(t.path); setNaming({ parent: t.path, path: null }); } },
      { label: "Rename", icon: Pencil, hint: "F2", run: () => setNaming({ parent: parentOf(t.path), path: t.path }) },
      "-",
      { label: "Remove folder", icon: FolderX, danger: true, run: () => removeFolder(t) },
    ];
  };

  const moveMenu = (s: Session, at: { clientX: number; clientY: number }) =>
    menu(at, [
      { heading: "Move to" },
      { label: "No folder", icon: FolderX, checked: !s.folder, run: () => moveSessions([s.id], "") },
      ...folderPaths.map((p) => ({ label: p.split("/").join(" › "), icon: Folder, checked: s.folder === p, run: () => moveSessions([s.id], p) })),
      "-",
      { label: "New folder…", icon: FolderPlus, run: () => { setView({ group: "folder" }); setNaming({ parent: "", path: null, move: s.id }); } },
    ]);

  const sessionMenu = (s: Session, at: { clientX: number; clientY: number }): MenuEntry[] => [
    { label: "Connect", icon: Play, hint: "Enter", run: () => openSession(s) },
    { label: "Connect in split", icon: Columns2, run: () => openSession(s, "row") },
    "-",
    { label: "Edit…", icon: Pencil, hint: "F2", run: () => set({ editing: s }) },
    { label: "Move to folder…", icon: FolderInput, run: () => moveMenu(s, at) },
    { label: "Duplicate", icon: Copy, run: () => duplicateSession(s) },
    { label: "Copy address", icon: Copy, run: () => writeText(s.protocol === "serial" ? s.device : `${s.user ? s.user + "@" : ""}${s.host}`) },
    "-",
    { label: "Delete", icon: Trash2, danger: true, run: () => deleteSession(s.id) },
  ];

  const viewMenu = (e: React.MouseEvent) => {
    const all = new Set<string>();
    const walk = (t: Tree) => t.folders.forEach((f) => (all.add(f.path), walk(f)));
    walk(root);
    menu(e, [
      { heading: "Sort by" },
      { label: "Name", checked: view.sort === "name", run: () => setView({ sort: "name" }) },
      { label: "Address", checked: view.sort === "address", run: () => setView({ sort: "address" }) },
      { label: "Last used", checked: view.sort === "recent", run: () => setView({ sort: "recent" }) },
      { label: "Type", checked: view.sort === "protocol", run: () => setView({ sort: "protocol" }) },
      { heading: "Group by" },
      { label: "Folders", checked: view.group === "folder", run: () => setView({ group: "folder" }) },
      { label: "Type", checked: view.group === "protocol", run: () => setView({ group: "protocol" }) },
      { label: "Nothing", checked: view.group === "none", run: () => setView({ group: "none" }) },
      "-",
      { label: "Collapse all", icon: ChevronsDownUp, disabled: !all.size, run: () => setCollapsed(new Set([...collapsed, ...all])) },
      { label: "Expand all", icon: ChevronsUpDown, disabled: !all.size, run: () => setCollapsed(new Set([...collapsed].filter((p) => !all.has(p)))) },
    ]);
  };

  // ---- drag a session onto a folder (pointer-driven: the window's own file drop stays free for uploads)

  const startDrag = (e: React.MouseEvent, s: Session) => {
    if (e.button !== 0 || view.group !== "folder" || filtered) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let started = false;
    let over: string | null = null;
    const move = (ev: MouseEvent) => {
      if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      started = true;
      const zone = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-drop]");
      over = zone ? zone.dataset.drop ?? null : null;
      setDrag({ id: s.id, label: label(s), x: ev.clientX, y: ev.clientY, over });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!started) return;
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      setDrag(null);
      if (over !== null && over !== s.folder) {
        moveSessions([s.id], over);
        if (over && collapsed.has(over)) toggle(over);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (naming) return;
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

  const meta = (s: Session) => {
    if (view.sort === "recent") return s.last_used ? ago(s.last_used) : "";
    if (s.protocol === "serial") return s.device;
    if (s.protocol === "local") return "";
    const port = s.port && s.port !== DEFAULT_PORT[s.protocol] ? `:${s.port}` : "";
    // don't repeat the address when the name already says it
    return label(s).includes(s.host) ? port : s.host + port;
  };

  const row = (s: Session, depth: number) => (
    <div
      key={s.id}
      role="treeitem"
      aria-selected={sel === s.id}
      className={`srow ${sel === s.id ? "sel" : ""} ${drag?.id === s.id ? "dragging" : ""}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      onMouseDown={(e) => startDrag(e, s)}
      onClick={() => !dragged.current && setSel(s.id)}
      onDoubleClick={() => openSession(s)}
      onContextMenu={(e) => {
        setSel(s.id);
        const at = { clientX: e.clientX, clientY: e.clientY };
        menu(e, sessionMenu(s, at));
      }}
      title={s.notes || undefined}
    >
      <Dot protocol={s.protocol} color={s.color} state={live.get(s.id)} />
      <span className="srow-name">{label(s)}</span>
      <span className="srow-meta">{meta(s)}</span>
      {view.group !== "protocol" && s.protocol !== "ssh" && <span className="srow-tag">{PROTOCOL_NAME[s.protocol]}</span>}
      <button className="srow-go" aria-label={`Connect to ${label(s)}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openSession(s); }}>
        <Play size={11} strokeWidth={2} />
      </button>
    </div>
  );

  const nameInput = (depth: number, initial: string, key: string) => (
    <div key={key} className="frow naming" style={{ paddingLeft: 6 + depth * 14 }}>
      <ChevronRight size={12} strokeWidth={2} className="chev" style={{ visibility: "hidden" }} />
      <FolderOpen size={13} strokeWidth={1.7} />
      <input
        autoFocus
        defaultValue={initial}
        placeholder="Folder name"
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commitName(e.currentTarget.value);
          if (e.key === "Escape") setNaming(null);
        }}
        onBlur={(e) => commitName(e.currentTarget.value)}
      />
    </div>
  );

  const folder = (t: Tree, depth: number): React.ReactNode => {
    const shut = collapsed.has(t.path);
    const virtual = isVirtual(t.path);
    return (
      <div key={t.path} role="group" className={`fgroup ${drag?.over === t.path ? "drop" : ""}`} data-drop={virtual ? undefined : t.path}>
        {naming?.path === t.path ? (
          nameInput(depth, t.name, `naming-${t.path}`)
        ) : (
          <div
            className="frow"
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => toggle(t.path)}
            onContextMenu={(e) => menu(e, folderMenu(t))}
            onKeyDown={(e) => e.key === "F2" && !virtual && setNaming({ parent: parentOf(t.path), path: t.path })}
            tabIndex={-1}
          >
            <ChevronRight size={12} strokeWidth={2} className={`chev ${shut ? "" : "open"}`} />
            {virtual ? <Dot protocol={t.path.slice(1) as Protocol} /> : shut ? <Folder size={13} strokeWidth={1.7} /> : <FolderOpen size={13} strokeWidth={1.7} />}
            <span className="frow-name">{t.name}</span>
            <span className="frow-count">{count(t) || ""}</span>
          </div>
        )}
        {!shut && (
          <div className="fkids">
            {naming && naming.path === null && naming.parent === t.path && nameInput(depth + 1, "", "naming-new")}
            {t.folders.map((f) => folder(f, depth + 1))}
            {t.sessions.map((s) => row(s, depth + 1))}
            {!t.folders.length && !t.sessions.length && !(naming && naming.parent === t.path) && (
              <div className="fempty" style={{ paddingLeft: 30 + depth * 14 }}>Drag sessions here</div>
            )}
          </div>
        )}
      </div>
    );
  };

  const hasSshConfig = get().boot?.hasSshConfig;
  const outOfFolder = drag && drag.over === "" && sessions.find((s) => s.id === drag.id)?.folder;

  return (
    <section className="panel" aria-label="Sessions">
      <header className="panel-head">
        <h3>Sessions</h3>
        <div className="panel-actions">
          <IconButton icon={ArrowDownUp} label="Sort and group" onClick={viewMenu} />
          <IconButton icon={FolderPlus} label="New folder" onClick={() => { setView({ group: "folder" }); setQ(""); setNaming({ parent: "", path: null }); }} />
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
      <div
        className={`panel-body ${outOfFolder ? "drop-root" : ""}`}
        role="tree"
        tabIndex={0}
        ref={listRef}
        onKeyDown={onKey}
        data-drop={view.group === "folder" ? "" : undefined}
      >
        {sessions.length === 0 && !naming ? (
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
            {naming && naming.path === null && naming.parent === "" && nameInput(0, "", "naming-root")}
            {root.folders.map((f) => folder(f, 0))}
            {root.folders.length > 0 && root.sessions.length > 0 && <div className="fsep" />}
            {root.sessions.map((s) => row(s, 0))}
          </>
        )}
        {outOfFolder && <div className="drop-hint">Drop to take it out of {outOfFolder.split("/").pop()}</div>}
      </div>
      {drag && createPortal(<div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 6 }}>{drag.label}</div>, document.body)}
      {menuNode}
    </section>
  );
}

function count(t: Tree): number {
  return t.sessions.length + t.folders.reduce((n, f) => n + count(f), 0);
}
