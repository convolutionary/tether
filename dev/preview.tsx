// Dev-only: the real UI against a fake backend, for screenshots and design review.
// npx vite --config dev/vite.preview.ts  →  http://localhost:1421/#scene=terminal
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Session } from "../src/lib/api";

const params = new URLSearchParams(location.search || location.hash.slice(1));
const scene = params.get("scene") ?? "welcome";
const theme = params.get("theme") ?? "dark";
const now = Math.floor(Date.now() / 1000);
let n = 0;
const s = (p: Partial<Session>): Session => ({
  id: crypto.randomUUID(), name: "", folder: "", protocol: "ssh", host: "", port: 22, user: "", identity: "", jump: null,
  save_password: false, x11: false, agent_forward: false, compression: false, keepalive_secs: 30, remote_command: "",
  follow_cwd: true, forwards: [], command: "", cwd: "", device: "", baud: 115200, data_bits: 8, parity: "none", stop_bits: 1,
  flow: "none", domain: "", rdp_args: "", env: [], term_type: "xterm-256color", color: "", notes: "", log: false,
  created: now, last_used: now - (n++) * 5000, ...p,
});
const sessions: Session[] = [
  s({ name: "web-01", folder: "Work/Production", host: "10.20.0.11", user: "deploy" }),
  s({ name: "web-02", folder: "Work/Production", host: "10.20.0.12", user: "deploy" }),
  s({ name: "db-primary", folder: "Work/Production", host: "10.20.1.5", user: "postgres", color: "#e5b567" }),
  s({ name: "bastion", folder: "Work", host: "bastion.convolutionary.dev", user: "aurora" }),
  s({ name: "ci-runner", folder: "Work/Staging", host: "10.30.0.40", user: "ci" }),
  s({ name: "files.nas", folder: "Home", protocol: "sftp", host: "nas.lan", user: "phi" }),
  s({ name: "Windows VM", folder: "Home", protocol: "rdp", host: "192.168.1.60", port: 3389, user: "Administrator" }),
  s({ name: "Pi console", folder: "Lab", protocol: "serial", device: "/dev/ttyUSB0", port: 0 }),
  s({ name: "rpi-cam", folder: "Lab", protocol: "vnc", host: "192.168.1.77", port: 5900 }),
  s({ name: "switch-core", folder: "Lab", protocol: "telnet", host: "192.168.1.2", port: 23, user: "" }),
  s({ name: "pwnbox", host: "pwnbox.convolutionary.dev", user: "root", color: "#ef7b7b" }),
];
const settings = {
  appearance: theme, accent: "#8b9cff", terminal_theme: "system", font_family: "JetBrains Mono", font_size: 13, line_height: 1.15,
  cursor_style: "bar", cursor_blink: false, scrollback: 20000, copy_on_select: true, right_click_paste: false, confirm_close: true,
  bell: "visual", default_shell: "", sftp_show_hidden: false, download_dir: "", restore_tabs: false, stats_bar: true,
  sidebar_width: 290, sidebar_open: true,
};
const files = [
  ["releases", "dir", 4096], ["shared", "dir", 4096], ["logs", "dir", 4096], [".env", "file", 812], [".bashrc", "file", 3771],
  ["docker-compose.yml", "file", 2140], ["deploy.sh", "file", 5632], ["nginx.conf", "file", 3011], ["backup-2026-11-07.tar.zst", "file", 734003200],
  ["README.md", "file", 9220], ["screenshot.png", "file", 412000],
].map(([name, kind, size], i) => ({ name, path: `/srv/app/${name}`, kind, size, modified: now - i * 86400 * 3, mode: kind === "dir" ? 0o755 : 0o644, owner: "deploy", group: "deploy", linkDir: false }));

mockWindows("main");
(window as { __tetherNoWebgl?: boolean }).__tetherNoWebgl = true;
let term = 1;
mockIPC((cmd, args) => {
  switch (cmd) {
    case "bootstrap":
      return {
        sessions, tunnels: [
          { id: crypto.randomUUID(), name: "Postgres on db-primary", session: sessions[2].id, forward: { kind: "Local", bind: "", port: 5433, host: "localhost", host_port: 5432 }, autostart: true, keep_alive: true },
          { id: crypto.randomUUID(), name: "Grafana", session: sessions[3].id, forward: { kind: "Local", bind: "", port: 3000, host: "10.20.2.9", host_port: 3000 }, autostart: false, keep_alive: true },
          { id: crypto.randomUUID(), name: "Browse as bastion", session: sessions[3].id, forward: { kind: "Dynamic", bind: "", port: 1080, host: "", host_port: 0 }, autostart: false, keep_alive: true },
        ],
        snippets: [
          { id: crypto.randomUUID(), name: "Disk usage", text: "df -h | sort -k5 -rn | head", run: true },
          { id: crypto.randomUUID(), name: "Tail app logs", text: "journalctl -u app -f -n 200", run: true },
          { id: crypto.randomUUID(), name: "Who's here", text: "w; last -n 5", run: true },
        ],
        settings, shells: [{ name: "zsh (default)", command: "/usr/bin/zsh -l", kind: "shell" }, { name: "bash", command: "/usr/bin/bash -l", kind: "shell" }, { name: "fish", command: "/usr/bin/fish -l", kind: "shell" }],
        platform: "linux", tiling: false, systemTheme: null, version: "0.1.0", downloadDir: "/home/phi/Downloads", hasSshConfig: true, runningTunnels: [],
      };
    case "term_open":
    case "term_duplicate":
      return term++;
    case "sftp_list":
      return ["/srv/app", files];
    case "stats":
      return [{ cpus: 8, load1: 0.42, cpu: 13.4, memTotal: 16e9, memUsed: 6.1e9, diskTotal: 200e9, diskUsed: 121e9, uptime: 1_036_800 }, [1, 1]];
    case "remote_cwd":
      return "/srv/app";
    case "has_password":
      return false;
    case "serial_ports":
      return [{ name: "/dev/ttyUSB0", description: "FTDI FT232R" }];
    default:
      return null;
  }
  void args;
});

await import("../src/main");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { get, set } = await import("../src/lib/store");
const terms = await import("../src/lib/terms");
while (!get().booted) await wait(20);

const demo = [
  "\x1b[38;5;245mLast login: Sat Nov  8 09:12:44 2026 from 10.20.0.1\x1b[0m",
  "\x1b[1;32mdeploy@web-01\x1b[0m:\x1b[1;34m~\x1b[0m$ cd /srv/app && git log --oneline -4",
  "\x1b[33m9f2c1e7\x1b[0m (\x1b[1;36mHEAD -> main\x1b[0m, \x1b[1;31morigin/main\x1b[0m) Cache warm-up after deploy",
  "\x1b[33m41bd0a2\x1b[0m Retry S3 uploads with backoff",
  "\x1b[33mc07e9f1\x1b[0m Health check waits for migrations",
  "\x1b[33m5aa3d68\x1b[0m Bump rust to 1.96",
  "\x1b[1;32mdeploy@web-01\x1b[0m:\x1b[1;34m/srv/app\x1b[0m$ systemctl status app --no-pager | head -5",
  "\x1b[1;32m●\x1b[0m app.service - App server",
  "     Loaded: loaded (/etc/systemd/system/app.service; \x1b[1;32menabled\x1b[0m)",
  "     Active: \x1b[1;32mactive (running)\x1b[0m since Fri 2026-10-27 14:02:11 UTC; 12 days ago",
  "   Main PID: 2210 (app)",
  "      Tasks: 19 (limit: 18920)",
  "\x1b[1;32mdeploy@web-01\x1b[0m:\x1b[1;34m/srv/app\x1b[0m$ ls -la --color",
  "total 732M",
  "drwxr-xr-x 5 deploy deploy 4.0K Nov  8 09:13 \x1b[1;34m.\x1b[0m",
  "-rw-r--r-- 1 deploy deploy 2.1K Nov  5 18:20 docker-compose.yml",
  "-rwxr-xr-x 1 deploy deploy 5.5K Nov  2 11:04 \x1b[1;32mdeploy.sh\x1b[0m",
  "drwxr-xr-x 4 deploy deploy 4.0K Nov  8 03:00 \x1b[1;34mlogs\x1b[0m",
  "drwxr-xr-x 9 deploy deploy 4.0K Nov  7 22:51 \x1b[1;34mreleases\x1b[0m",
  "\x1b[1;32mdeploy@web-01\x1b[0m:\x1b[1;34m/srv/app\x1b[0m$ ",
].join("\r\n");

if (!["welcome", "editor", "palette", "settings"].includes(scene)) {
  const a = terms.openSession(sessions[0]);
  terms.openSession(sessions[2]);
  terms.openSession({ ...sessions[10] });
  set({ activeTab: get().tabs[0].key });
  await wait(50);
  const panes = Object.values(get().panes);
  terms.handleEngine({ type: "ready", term: panes[0].term ?? 1, remote: { os: "Linux", home: "/srv/app", user: "deploy", host: "10.20.0.11" } });
  terms.handleEngine({ type: "ready", term: panes[1].term ?? 2, remote: { os: "Linux", home: "/var/lib/postgresql", user: "postgres", host: "10.20.1.5" } });
  terms.handleEngine({ type: "status", term: panes[2].term ?? 3, text: "Logging in as root…" });
  await wait(50);
  terms.xt(a)?.term.write(demo);
  set({ panel: scene === "files" || scene === "terminal" ? "files" : get().panel });
  if (scene === "split") {
    await terms.splitActive("row");
    await wait(80);
    const p = Object.values(get().panes).at(-1)!;
    terms.handleEngine({ type: "ready", term: p.term ?? 9, remote: { os: "Linux", home: "/srv/app", user: "deploy", host: "10.20.0.11" } });
    await wait(30);
    terms.xt(p.key)?.term.write("\x1b[1;32mdeploy@web-01\x1b[0m:\x1b[1;34m/srv/app\x1b[0m$ tail -f logs/app.log\r\n2026-11-08T09:14:02Z INFO  request id=7f2 path=/api/health 200 1.2ms\r\n2026-11-08T09:14:03Z INFO  request id=7f3 path=/api/orders 200 18.4ms\r\n2026-11-08T09:14:03Z \x1b[33mWARN\x1b[0m  slow query 412ms: SELECT * FROM orders WHERE …\r\n");
    set({ panel: "tunnels", tunnelStates: { [get().tunnels[0].id]: { state: "running", connections: 2 }, [get().tunnels[2].id]: { state: "connecting" } } });
  }
  if (scene === "hostkey") {
    set({ activeTab: get().tabs[2].key, panel: "sessions" });
    terms.handleEngine({ type: "prompt", id: 1, term: panes[2].term ?? 3, prompt: { kind: "hostKey", host: "pwnbox.convolutionary.dev", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:Beyq3Uscb749Om6VXji3Qa0IEj0Z0QVkDRDvy9Gr7rE", changed: false } });
  }
  if (scene === "password") {
    set({ activeTab: get().tabs[2].key, panel: "snippets" });
    terms.handleEngine({ type: "prompt", id: 2, term: panes[2].term ?? 3, prompt: { kind: "interactive", host: "pwnbox", name: "", instructions: "", fields: [{ label: "Password:", echo: false }, { label: "Verification code:", echo: true }] } });
  }
  if (scene === "transfer") {
    terms.handleEngine({ type: "transfer", id: "t1", term: panes[0].term ?? 1, direction: "download", label: "backup-2026-11-07.tar.zst", done: 312e6, total: 734e6, state: "running", error: null, dest: "" });
    terms.handleEngine({ type: "transfer", id: "t2", term: panes[0].term ?? 1, direction: "upload", label: "3 items", done: 1.2e6, total: 4.8e6, state: "running", error: null, dest: "/srv/app" });
  }
}
if (scene === "editor") set({ editing: sessions[3] });
if (scene === "palette") set({ palette: true });
if (scene === "settings") set({ settingsOpen: true });
