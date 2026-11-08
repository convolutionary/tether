import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FileCode,
  FileImage,
  FileArchive,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  FolderTree,
  Home,
  Link2,
  Lock,
  Pencil,
  RefreshCw,
  SquarePen,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, type FileEntry, type TransferEvent } from "../lib/api";
import { saveSettings } from "../lib/data";
import { bytes, joinPath, mode as modeStr, parentPath, when } from "../lib/format";
import { get, set, toast, useStore } from "../lib/store";
import { Button, Empty, IconButton, Modal, Spinner, Switch, useMenu } from "./ui";

function iconFor(e: FileEntry) {
  if (e.kind === "dir" || e.linkDir) return Folder;
  if (e.kind === "link") return Link2;
  const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return FileImage;
  if (["zip", "gz", "tgz", "xz", "bz2", "7z", "rar", "tar", "zst", "deb", "rpm"].includes(ext)) return FileArchive;
  if (["sh", "py", "js", "ts", "rs", "go", "c", "h", "cpp", "java", "rb", "php", "lua", "json", "yaml", "yml", "toml", "conf", "ini", "xml", "html", "css"].includes(ext)) return FileCode;
  if (["txt", "md", "log", "csv"].includes(ext)) return FileText;
  return File;
}

export function FilesPanel() {
  const pane = useStore((s) => {
    const tab = s.tabs.find((t) => t.key === s.activeTab);
    const p = tab ? s.panes[tab.active] : undefined;
    return p && (p.session.protocol === "ssh" || p.session.protocol === "sftp") ? p : undefined;
  });
  const transfers = useStore((s) => Object.values(s.transfers));
  if (!pane) {
    return (
      <section className="panel" aria-label="Files">
        <header className="panel-head"><h3>Files</h3></header>
        <div className="panel-body">
          <Empty icon={FolderTree} title="No server selected">
            <p>Files of the SSH or SFTP tab you're in show here, and follow the folder you <code>cd</code> into.</p>
          </Empty>
        </div>
        <Transfers list={transfers} />
      </section>
    );
  }
  if (pane.status !== "ready" || pane.term == null) {
    return (
      <section className="panel" aria-label="Files">
        <header className="panel-head"><h3>Files</h3></header>
        <div className="panel-body center">
          {pane.status === "connecting" ? <Spinner /> : <span className="muted">Disconnected</span>}
        </div>
        <Transfers list={transfers} />
      </section>
    );
  }
  return <Browser key={pane.key} paneKey={pane.key} term={pane.term} />;
}

export function Browser({ paneKey, term, wide }: { paneKey: string; term: number; wide?: boolean }) {
  const path = useStore((s) => s.filesPath[paneKey] ?? "/");
  const follow = useStore((s) => s.filesFollow[paneKey] ?? true);
  const cwd = useStore((s) => s.panes[paneKey]?.cwd ?? null);
  const home = useStore((s) => s.panes[paneKey]?.remote?.home ?? "/");
  const host = useStore((s) => s.panes[paneKey]?.remote?.host ?? "");
  const showHidden = useStore((s) => s.settings?.sftp_show_hidden ?? false);
  const transfers = useStore((s) => Object.values(s.transfers));
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [perm, setPerm] = useState<FileEntry | null>(null);
  const [confirmDel, setConfirmDel] = useState<string[] | null>(null);
  const [dropping, setDropping] = useState(false);
  const { open: menu, node: menuNode } = useMenu();
  const rootRef = useRef<HTMLElement>(null);
  const reqRef = useRef(0);

  const go = useCallback((p: string) => set((s) => ({ filesPath: { ...s.filesPath, [paneKey]: p } })), [paneKey]);
  const setFollow = (v: boolean) => {
    set((s) => ({ filesFollow: { ...s.filesFollow, [paneKey]: v } }));
    if (v && cwd) go(cwd);
  };

  const load = useCallback(async (p: string) => {
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const [real, list] = await api.sftpList(term, p);
      if (req !== reqRef.current) return;
      setEntries(list);
      setError(null);
      if (real !== p) go(real);
    } catch (e) {
      if (req !== reqRef.current) return;
      setError(String(e));
      setEntries([]);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, [term, go]);

  useEffect(() => {
    setSel(new Set());
    load(path);
  }, [path, load]);

  // follow the shell
  useEffect(() => {
    if (follow && cwd && cwd !== path) go(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, follow]);

  // refresh when a transfer into this folder finishes
  const doneHere = transfers.filter((t) => t.term === term && t.state === "done" && t.direction === "upload" && t.dest === path).length;
  useEffect(() => {
    if (doneHere) load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneHere]);

  // drop files from the desktop to upload them here
  useEffect(() => {
    let un: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const el = rootRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const inside = (pos: { x: number; y: number }) => {
          const x = pos.x / window.devicePixelRatio;
          const y = pos.y / window.devicePixelRatio;
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        };
        if (e.payload.type === "over" || e.payload.type === "enter") setDropping(inside(e.payload.position));
        else if (e.payload.type === "leave") setDropping(false);
        else if (e.payload.type === "drop") {
          setDropping(false);
          if (inside(e.payload.position) && e.payload.paths.length) {
            api.sftpUpload(term, e.payload.paths, get().filesPath[paneKey] ?? "/");
          }
        }
      })
      .then((f) => (un = f));
    return () => un?.();
  }, [term, paneKey]);

  const shown = useMemo(() => (entries ?? []).filter((e) => showHidden || !e.name.startsWith(".")), [entries, showHidden]);
  const selected = shown.filter((e) => sel.has(e.path));

  const open = (e: FileEntry) => {
    if (e.kind === "dir" || e.linkDir) {
      if (follow) setFollow(false);
      go(e.path);
    } else {
      edit(e);
    }
  };
  const edit = (e: FileEntry) =>
    api.sftpEdit(term, e.path).then(
      () => toast(`Editing ${e.name}. Saving uploads it to the server`, "info", undefined, 3200),
      (err) => toast(String(err), "bad"),
    );
  const download = (list: FileEntry[]) => list.length && api.sftpDownload(term, list.map((e) => e.path));
  const downloadTo = async (list: FileEntry[]) => {
    const dir = await pickFile({ directory: true, title: "Download to" });
    if (dir) api.sftpDownload(term, list.map((e) => e.path), dir as string);
  };
  const upload = async (dirs: boolean) => {
    const picked = await pickFile({ multiple: true, directory: dirs, title: dirs ? "Upload folders" : "Upload files" });
    if (picked) api.sftpUpload(term, (Array.isArray(picked) ? picked : [picked]) as string[], path);
  };
  const mkdir = async () => {
    let name = "New folder";
    for (let i = 2; shown.some((e) => e.name === name); i++) name = `New folder ${i}`;
    try {
      await api.sftpMkdir(term, joinPath(path, name));
      await load(path);
      setRenaming(joinPath(path, name));
    } catch (e) {
      toast(String(e), "bad");
    }
  };
  const touch = async () => {
    let name = "untitled.txt";
    for (let i = 2; shown.some((e) => e.name === name); i++) name = `untitled ${i}.txt`;
    try {
      await api.sftpTouch(term, joinPath(path, name));
      await load(path);
      setRenaming(joinPath(path, name));
    } catch (e) {
      toast(String(e), "bad");
    }
  };
  const rename = async (e: FileEntry, to: string) => {
    setRenaming(null);
    if (!to || to === e.name) return;
    try {
      await api.sftpRename(term, e.path, joinPath(path, to));
      load(path);
    } catch (err) {
      toast(String(err), "bad");
    }
  };
  const remove = async (paths: string[]) => {
    setConfirmDel(null);
    try {
      await api.sftpRemove(term, paths);
      toast(`Deleted ${paths.length === 1 ? paths[0].split("/").pop() : `${paths.length} items`}`, "ok", undefined, 2400);
      load(path);
    } catch (e) {
      toast(String(e), "bad");
      load(path);
    }
  };

  const click = (e: React.MouseEvent, f: FileEntry) => {
    if (e.shiftKey && anchor) {
      const a = shown.findIndex((x) => x.path === anchor);
      const b = shown.findIndex((x) => x.path === f.path);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSel(new Set(shown.slice(lo, hi + 1).map((x) => x.path)));
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel);
      n.has(f.path) ? n.delete(f.path) : n.add(f.path);
      setSel(n);
      setAnchor(f.path);
    } else {
      setSel(new Set([f.path]));
      setAnchor(f.path);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (renaming) return;
    const i = shown.findIndex((x) => x.path === anchor);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = shown[e.key === "ArrowDown" ? Math.min(shown.length - 1, i + 1) : Math.max(0, i - 1)];
      if (n) {
        setSel(new Set([n.path]));
        setAnchor(n.path);
      }
    } else if (e.key === "Enter" && selected.length === 1) open(selected[0]);
    else if (e.key === "Backspace") go(parentPath(path));
    else if (e.key === "Delete" && selected.length) setConfirmDel(selected.map((x) => x.path));
    else if (e.key === "F2" && selected.length === 1) setRenaming(selected[0].path);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel(new Set(shown.map((x) => x.path)));
    } else if (e.key === "F5") load(path);
  };

  const itemMenu = (f: FileEntry) => {
    const many = sel.has(f.path) && selected.length > 1 ? selected : [f];
    const isDir = f.kind === "dir" || f.linkDir;
    return [
      ...(many.length === 1 ? [{ label: isDir ? "Open" : "Edit in your editor", icon: isDir ? FolderInput : SquarePen, hint: "Enter", run: () => open(f) }] : []),
      { label: many.length > 1 ? `Download ${many.length} items` : "Download", icon: Download, run: () => download(many) },
      { label: "Download to…", icon: Download, run: () => downloadTo(many) },
      "-" as const,
      ...(many.length === 1
        ? [
            { label: "Rename", icon: Pencil, hint: "F2", run: () => setRenaming(f.path) },
            { label: "Permissions…", icon: Lock, run: () => setPerm(f) },
            { label: "Copy path", icon: Copy, run: () => writeText(f.path) },
            "-" as const,
          ]
        : []),
      { label: many.length > 1 ? `Delete ${many.length} items` : "Delete", icon: Trash2, danger: true, hint: "Del", run: () => setConfirmDel(many.map((x) => x.path)) },
    ];
  };
  const blankMenu = [
    { label: "New folder", icon: FolderPlus, run: mkdir },
    { label: "New file", icon: FilePlus, run: touch },
    "-" as const,
    { label: "Upload files…", icon: Upload, run: () => upload(false) },
    { label: "Upload folder…", icon: Upload, run: () => upload(true) },
    "-" as const,
    { label: "Copy folder path", icon: Copy, run: () => writeText(path) },
    { label: showHidden ? "Hide dotfiles" : "Show dotfiles", icon: showHidden ? EyeOff : Eye, run: () => saveSettings({ sftp_show_hidden: !showHidden }) },
    { label: "Refresh", icon: RefreshCw, hint: "F5", run: () => load(path) },
  ];

  const crumbs = path === "/" ? [""] : path.split("/");

  return (
    <section ref={rootRef} className={`panel files ${wide ? "wide" : ""} ${dropping ? "dropping" : ""}`} aria-label="Files">
      <header className="panel-head">
        <h3 title={host}>Files</h3>
        <div className="panel-actions">
          <IconButton icon={Upload} label="Upload files" onClick={() => upload(false)} />
          <IconButton icon={FolderPlus} label="New folder" onClick={mkdir} />
          <IconButton icon={RefreshCw} label="Refresh (F5)" onClick={() => load(path)} className={loading ? "spin" : ""} />
        </div>
      </header>
      <div className="pathbar">
        <IconButton icon={ArrowUp} label="Up (Backspace)" size={14} onClick={() => { setFollow(false); go(parentPath(path)); }} disabled={path === "/"} />
        <IconButton icon={Home} label={`Home (${home})`} size={14} onClick={() => { setFollow(false); go(home); }} />
        {editingPath ? (
          <input
            className="path-input"
            autoFocus
            defaultValue={path}
            spellCheck={false}
            onBlur={() => setEditingPath(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setFollow(false);
                go((e.target as HTMLInputElement).value.trim() || "/");
                setEditingPath(false);
              }
              if (e.key === "Escape") setEditingPath(false);
            }}
          />
        ) : (
          <div className="crumbs" onDoubleClick={() => setEditingPath(true)} title="Double-click to type a path">
            <span className="crumbs-inner">
            {crumbs.map((c, i) => {
              const to = i === 0 ? "/" : crumbs.slice(0, i + 1).join("/");
              return (
                <span key={i} className="crumb-wrap">
                  {i > 0 && <span className="crumb-sep">/</span>}
                  <button className="crumb" onClick={() => { setFollow(false); go(to); }}>{i === 0 ? "" : c}</button>
                </span>
              );
            })}
            </span>
          </div>
        )}
        <label className={`follow ${follow ? "on" : ""}`} title="Follow the terminal's folder">
          <Switch checked={follow} onChange={setFollow} label="Follow terminal folder" />
        </label>
      </div>
      <div
        className="panel-body flist"
        tabIndex={0}
        onKeyDown={onKey}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) menu(e, blankMenu);
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSel(new Set());
        }}
      >
        {error ? (
          <div className="ferror">
            <span>{error}</span>
            <button className="link" onClick={() => go(home)}>Go home</button>
          </div>
        ) : entries === null ? (
          <div className="center pad"><Spinner /></div>
        ) : shown.length === 0 ? (
          <div className="muted pad small" onContextMenu={(e) => menu(e, blankMenu)}>Empty folder{!showHidden && entries.length > 0 ? " (dotfiles hidden)" : ""}</div>
        ) : (
          shown.map((f) => {
            const Icon = iconFor(f);
            const isDir = f.kind === "dir" || f.linkDir;
            return (
              <div
                key={f.path}
                className={`frow-file ${sel.has(f.path) ? "sel" : ""} ${isDir ? "is-dir" : ""} ${f.name.startsWith(".") ? "dot-file" : ""}`}
                onClick={(e) => click(e, f)}
                onDoubleClick={() => open(f)}
                onContextMenu={(e) => {
                  if (!sel.has(f.path)) {
                    setSel(new Set([f.path]));
                    setAnchor(f.path);
                  }
                  menu(e, itemMenu(f));
                }}
                title={`${f.name}\n${modeStr(f.mode, isDir)}  ${f.owner ?? ""}${f.group ? ":" + f.group : ""}\n${f.modified ? new Date(f.modified * 1000).toLocaleString() : ""}`}
                draggable={false}
              >
                <Icon size={14} strokeWidth={1.7} className="ficon" />
                {renaming === f.path ? (
                  <input
                    className="rename"
                    autoFocus
                    defaultValue={f.name}
                    spellCheck={false}
                    onFocus={(e) => {
                      const dot = f.name.lastIndexOf(".");
                      e.target.setSelectionRange(0, dot > 0 && !isDir ? dot : f.name.length);
                    }}
                    onBlur={(e) => rename(f, e.target.value.trim())}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="fname">{f.name}</span>
                )}
                <span className="fmeta">{isDir ? when(f.modified) : bytes(f.size)}</span>
              </div>
            );
          })
        )}
      </div>
      {dropping && <div className="dropzone">Drop to upload to <code>{path}</code></div>}
      <Transfers list={transfers.filter((t) => t.term === term)} />
      {menuNode}
      {perm && <Permissions entry={perm} onClose={() => setPerm(null)} onSave={async (m) => {
        setPerm(null);
        try {
          await api.sftpChmod(term, perm.path, m);
          load(path);
        } catch (e) {
          toast(String(e), "bad");
        }
      }} />}
      {confirmDel && (
        <Modal title="Delete for good?" onClose={() => setConfirmDel(null)} width={420}
          footer={<>
            <Button onClick={() => setConfirmDel(null)}>Cancel</Button>
            <Button variant="danger" autoFocus onClick={() => remove(confirmDel)}>Delete</Button>
          </>}>
          <p className="modal-text">
            {confirmDel.length === 1 ? <code>{confirmDel[0]}</code> : `${confirmDel.length} items`} will be deleted from <b>{host}</b>, folders with everything in them. There is no trash on the server.
          </p>
        </Modal>
      )}
    </section>
  );
}

function Transfers({ list }: { list: TransferEvent[] }) {
  const speeds = useRef(new Map<string, { t: number; done: number; rate: number }>());
  if (!list.length) return null;
  return (
    <div className="transfers">
      {list.map((t) => {
        const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === "done" ? 100 : 0;
        const prev = speeds.current.get(t.id);
        const now = performance.now();
        let rate = prev?.rate ?? 0;
        if (prev && now - prev.t > 400) {
          rate = ((t.done - prev.done) / (now - prev.t)) * 1000;
          speeds.current.set(t.id, { t: now, done: t.done, rate });
        } else if (!prev) speeds.current.set(t.id, { t: now, done: t.done, rate: 0 });
        return (
          <div key={t.id} className={`transfer ${t.state}`}>
            <div className="transfer-top">
              {t.direction === "download" ? <Download size={12} /> : <Upload size={12} />}
              <span className="transfer-name">{t.label}</span>
              <span className="transfer-num">
                {t.state === "running" ? `${bytes(t.done)}${t.total ? ` / ${bytes(t.total)}` : ""}${rate > 0 ? ` · ${bytes(rate)}/s` : ""}` : t.state}
              </span>
              {t.state === "running" && (
                <button className="ibtn tiny" aria-label="Cancel" onClick={() => api.cancelTransfer(t.id)}>
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="bar"><span style={{ width: `${pct}%` }} /></div>
          </div>
        );
      })}
    </div>
  );
}

function Permissions({ entry, onClose, onSave }: { entry: FileEntry; onClose: () => void; onSave: (m: number) => void }) {
  const [m, setM] = useState(entry.mode ?? 0o644);
  const bits: [string, number][][] = [
    [["Read", 0o400], ["Write", 0o200], ["Run", 0o100]],
    [["Read", 0o40], ["Write", 0o20], ["Run", 0o10]],
    [["Read", 0o4], ["Write", 0o2], ["Run", 0o1]],
  ];
  return (
    <Modal title={<>Permissions · <code>{entry.name}</code></>} onClose={onClose} width={420}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(m)}>Apply</Button>
      </>}>
      <div className="perm-grid">
        <span />
        <span className="perm-h">Read</span>
        <span className="perm-h">Write</span>
        <span className="perm-h">{entry.kind === "dir" ? "Enter" : "Run"}</span>
        {["Owner", "Group", "Everyone"].map((who, r) => (
          <PermRow key={who} who={`${who}${r === 0 && entry.owner ? ` (${entry.owner})` : r === 1 && entry.group ? ` (${entry.group})` : ""}`} bits={bits[r]} m={m} setM={setM} />
        ))}
      </div>
      <div className="perm-octal">
        <input
          value={m.toString(8).padStart(3, "0")}
          onChange={(e) => {
            const v = parseInt(e.target.value || "0", 8);
            if (!Number.isNaN(v) && v <= 0o7777) setM(v);
          }}
          spellCheck={false}
          maxLength={4}
        />
        <code>{modeStr(m, entry.kind === "dir")}</code>
      </div>
    </Modal>
  );
}

function PermRow({ who, bits, m, setM }: { who: string; bits: [string, number][]; m: number; setM: (v: number) => void }) {
  return (
    <>
      <span className="perm-who">{who}</span>
      {bits.map(([n, b]) => (
        <span key={n} className="perm-cell">
          <input type="checkbox" aria-label={`${who} ${n}`} checked={(m & b) !== 0} onChange={(e) => setM(e.target.checked ? m | b : m & ~b)} />
        </span>
      ))}
    </>
  );
}

