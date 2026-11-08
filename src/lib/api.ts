// Everything the UI asks of the Rust side, typed.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Protocol = "ssh" | "sftp" | "local" | "telnet" | "serial" | "mosh" | "rdp" | "vnc";
export type ForwardKind = "Local" | "Remote" | "Dynamic";

export interface Forward {
  kind: ForwardKind;
  bind: string;
  port: number;
  host: string;
  host_port: number;
}

export interface Session {
  id: string;
  name: string;
  folder: string;
  protocol: Protocol;
  host: string;
  port: number;
  user: string;
  identity: string;
  jump: string | null;
  save_password: boolean;
  x11: boolean;
  agent_forward: boolean;
  compression: boolean;
  keepalive_secs: number;
  remote_command: string;
  follow_cwd: boolean;
  forwards: Forward[];
  command: string;
  cwd: string;
  device: string;
  baud: number;
  data_bits: number;
  parity: string;
  stop_bits: number;
  flow: string;
  domain: string;
  rdp_args: string;
  env: [string, string][];
  term_type: string;
  color: string;
  notes: string;
  log: boolean;
  created: number;
  last_used: number;
}

export interface Tunnel {
  id: string;
  name: string;
  session: string;
  forward: Forward;
  autostart: boolean;
  keep_alive: boolean;
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
  run: boolean;
}

export interface Settings {
  appearance: "system" | "dark" | "light";
  accent: string;
  terminal_theme: string;
  font_family: string;
  font_size: number;
  line_height: number;
  cursor_style: "bar" | "block" | "underline";
  cursor_blink: boolean;
  scrollback: number;
  copy_on_select: boolean;
  right_click_paste: boolean;
  confirm_close: boolean;
  bell: "visual" | "sound" | "none";
  default_shell: string;
  sftp_show_hidden: boolean;
  download_dir: string;
  restore_tabs: boolean;
  stats_bar: boolean;
  sidebar_width: number;
  sidebar_open: boolean;
}

export interface Shell {
  name: string;
  command: string;
  kind: string;
}

export interface TerminalTheme {
  foreground?: string | null;
  background?: string | null;
  cursor?: string | null;
  selectionBackground?: string | null;
  selectionForeground?: string | null;
  palette: (string | null)[];
}

export interface Boot {
  sessions: Session[];
  tunnels: Tunnel[];
  snippets: Snippet[];
  settings: Settings;
  shells: Shell[];
  platform: string;
  tiling: boolean;
  systemTheme: TerminalTheme | null;
  version: string;
  downloadDir: string;
  hasSshConfig: boolean;
  runningTunnels: string[];
}

export interface RemoteInfo {
  os: string;
  home: string | null;
  user: string;
  host: string;
}

export type PromptKind =
  | { kind: "hostKey"; host: string; port: number; algorithm: string; fingerprint: string; changed: boolean }
  | { kind: "username"; host: string }
  | { kind: "password"; user: string; host: string; retry: boolean; remember: boolean }
  | { kind: "passphrase"; path: string; retry: boolean }
  | { kind: "interactive"; host: string; name: string; instructions: string; fields: { label: string; echo: boolean }[] };

export type TunnelState =
  | { state: "stopped" }
  | { state: "connecting" }
  | { state: "running"; connections: number }
  | { state: "failed"; error: string; retrying: boolean };

export interface TransferEvent {
  id: string;
  term: number;
  direction: "download" | "upload";
  label: string;
  done: number;
  total: number;
  state: "running" | "done" | "failed" | "cancelled";
  error: string | null;
  dest: string;
}

export type EngineEvent =
  | { type: "status"; term: number; text: string }
  | { type: "ready"; term: number; remote: RemoteInfo | null }
  | { type: "exit"; term: number; code: number | null; reason: string }
  | { type: "prompt"; id: number; term: number | null; prompt: PromptKind }
  | { type: "promptDone"; id: number }
  | { type: "tunnel"; id: string; state: TunnelState }
  | ({ type: "transfer" } & TransferEvent)
  | { type: "editSynced"; term: number; path: string; error: string | null }
  | { type: "themeChanged"; theme: TerminalTheme }
  | { type: "viewerExit"; term: number; code: number | null };

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "link" | "other";
  size: number;
  modified: number | null;
  mode: number | null;
  owner: string | null;
  group: string | null;
  linkDir: boolean;
}

export interface Stats {
  cpus: number;
  load1: number;
  cpu: number | null;
  memTotal: number;
  memUsed: number;
  diskTotal: number;
  diskUsed: number;
  uptime: number;
}

export interface Imported {
  sessions: Session[];
  skipped: string[];
}

export const api = {
  bootstrap: () => invoke<Boot>("bootstrap"),
  saveSessions: (sessions: Session[]) => invoke<void>("save_sessions", { sessions }),
  saveTunnels: (tunnels: Tunnel[]) => invoke<void>("save_tunnels", { tunnels }),
  saveSnippets: (snippets: Snippet[]) => invoke<void>("save_snippets", { snippets }),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  setPassword: (id: string, password: string | null) => invoke<void>("set_password", { id, password }),
  hasPassword: (id: string) => invoke<boolean>("has_password", { id }),

  termOpen: (session: Session, cols: number, rows: number, onData: (d: Uint8Array) => void) => {
    const output = new Channel<ArrayBuffer | number[]>();
    output.onmessage = (m) => onData(m instanceof ArrayBuffer ? new Uint8Array(m) : Uint8Array.from(m));
    return invoke<number>("term_open", { session, cols, rows, output });
  },
  termDuplicate: (of: number, cols: number, rows: number, onData: (d: Uint8Array) => void) => {
    const output = new Channel<ArrayBuffer | number[]>();
    output.onmessage = (m) => onData(m instanceof ArrayBuffer ? new Uint8Array(m) : Uint8Array.from(m));
    return invoke<number>("term_duplicate", { of, cols, rows, output });
  },
  termReconnect: (id: number, cols: number, rows: number) => invoke<void>("term_reconnect", { id, cols, rows }),
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  termWriteMany: (ids: number[], data: string) => invoke<void>("term_write_many", { ids, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: number) => invoke<void>("term_close", { id }),
  remoteCwd: (id: number) => invoke<string | null>("remote_cwd", { id }),
  answer: (id: number, answer: { values: string[]; remember: boolean } | null) => invoke<void>("answer", { id, answer }),
  stats: (id: number, prev: [number, number] | null) => invoke<[Stats, [number, number]]>("stats", { id, prev }),
  vncBridge: (id: number) => invoke<{ url: string; password: string | null }>("vnc_bridge", { id }),

  sftpList: (id: number, path: string) => invoke<[string, FileEntry[]]>("sftp_list", { id, path }),
  sftpMkdir: (id: number, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpTouch: (id: number, path: string) => invoke<void>("sftp_touch", { id, path }),
  sftpRename: (id: number, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpChmod: (id: number, path: string, mode: number) => invoke<void>("sftp_chmod", { id, path, mode }),
  sftpRemove: (id: number, paths: string[]) => invoke<void>("sftp_remove", { id, paths }),
  sftpReadText: (id: number, path: string) => invoke<string>("sftp_read_text", { id, path }),
  sftpDownload: (id: number, paths: string[], dir?: string) => invoke<string>("sftp_download", { id, paths, dir: dir ?? null }),
  sftpUpload: (id: number, paths: string[], dir: string) => invoke<string>("sftp_upload", { id, paths, dir }),
  cancelTransfer: (transfer: string) => invoke<void>("cancel_transfer", { transfer }),
  sftpEdit: (id: number, path: string) => invoke<string>("sftp_edit", { id, path }),
  reveal: (path: string) => invoke<void>("reveal", { path }),

  tunnelStart: (tunnel: Tunnel) => invoke<void>("tunnel_start", { tunnel }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),

  serialPorts: () => invoke<{ name: string; description: string }[]>("serial_ports"),
  import: (kind: "ssh" | "mobaxterm" | "putty", path?: string) => invoke<Imported>("import", { kind, path: path ?? null }),
  systemTheme: () => invoke<TerminalTheme | null>("system_theme"),
};

export function onEngine(cb: (e: EngineEvent) => void): Promise<UnlistenFn> {
  return listen<EngineEvent>("tether", (e) => cb(e.payload));
}

export function onOpenUrl(cb: (url: string) => void): Promise<UnlistenFn> {
  return listen<string>("tether-open", (e) => cb(e.payload));
}

export function newId(): string {
  return crypto.randomUUID();
}

export function blankSession(protocol: Protocol = "ssh"): Session {
  const ports: Record<Protocol, number> = { ssh: 22, sftp: 22, mosh: 22, telnet: 23, rdp: 3389, vnc: 5900, local: 0, serial: 0 };
  return {
    id: newId(),
    name: "",
    folder: "",
    protocol,
    host: "",
    port: ports[protocol],
    user: "",
    identity: "",
    jump: null,
    save_password: false,
    x11: false,
    agent_forward: false,
    compression: false,
    keepalive_secs: 30,
    remote_command: "",
    follow_cwd: true,
    forwards: [],
    command: "",
    cwd: "",
    device: "",
    baud: 115200,
    data_bits: 8,
    parity: "none",
    stop_bits: 1,
    flow: "none",
    domain: "",
    rdp_args: "",
    env: [],
    term_type: "xterm-256color",
    color: "",
    notes: "",
    log: false,
    created: Math.floor(Date.now() / 1000),
    last_used: 0,
  };
}

export const NIL = "00000000-0000-0000-0000-000000000000";
