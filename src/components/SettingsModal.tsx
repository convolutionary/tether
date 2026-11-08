import { useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import type { Settings } from "../lib/api";
import { saveSettings } from "../lib/data";
import { set, useStore } from "../lib/store";
import { SCHEMES, fromSystem } from "../lib/themes";
import { runImport } from "./SessionsPanel";
import { Button, IconButton, Modal, Row, Segmented, Switch } from "./ui";

const ACCENTS = ["#8b9cff", "#6fb3e6", "#79c7c0", "#7fbf8f", "#e5b567", "#ef7b7b", "#e88fa6", "#c99be8"];
const SECTIONS = ["Appearance", "Terminal", "Files", "Import"] as const;

export function SettingsModal() {
  const s = useStore((x) => x.settings)!;
  const sys = useStore((x) => x.systemTheme);
  const boot = useStore((x) => x.boot);
  const [section, setSection] = useState<(typeof SECTIONS)[number]>("Appearance");
  const up = (p: Partial<Settings>) => saveSettings(p);

  const schemes = [
    ...(sys ? [{ id: "system", name: "Desktop", light: false, theme: fromSystem(sys) }] : [{ id: "system", name: "Auto", light: false, theme: SCHEMES[0].theme }]),
    ...SCHEMES,
  ];

  return (
    <Modal title="Settings" onClose={() => set({ settingsOpen: false })} width={720} className="settings">
      <div className="settings-grid">
        <nav className="settings-nav">
          {SECTIONS.map((x) => (
            <button key={x} className={section === x ? "on" : ""} onClick={() => setSection(x)}>{x}</button>
          ))}
          <div className="settings-ver">Tether {boot?.version}</div>
        </nav>
        <div className="settings-body">
          {section === "Appearance" && (
            <>
              <Row label="Theme">
                <Segmented value={s.appearance} onChange={(appearance) => up({ appearance })} options={[{ id: "system", label: "System" }, { id: "dark", label: "Dark" }, { id: "light", label: "Light" }]} />
              </Row>
              <Row label="Accent">
                <div className="accents">
                  {ACCENTS.map((c) => (
                    <button key={c} className={`swatch ${s.accent === c ? "on" : ""}`} style={{ background: c }} aria-label={c} onClick={() => up({ accent: c })} />
                  ))}
                </div>
              </Row>
              <div className="row-block">
                <div className="row-label">Terminal colours</div>
                <div className="row-hint">{sys ? "Desktop follows your phiOS / HyDE theme and changes with it." : "Pick a scheme for every terminal."}</div>
                <div className="schemes">
                  {schemes.map((sc) => (
                    <button key={sc.id} className={`scheme ${s.terminal_theme === sc.id ? "on" : ""}`} onClick={() => up({ terminal_theme: sc.id })}>
                      <span
                        className="scheme-preview"
                        style={{
                          background: sc.id === "system" && !sys ? `linear-gradient(135deg, ${SCHEMES[0].theme.background} 50%, ${SCHEMES[2].theme.background} 50%)` : sc.theme.background,
                          color: sc.theme.foreground,
                        }}
                      >
                        <span className="scheme-line"><span style={{ color: sc.theme.green }}>~</span> <span style={{ color: sc.theme.blue }}>ls</span> -la</span>
                        <span className="scheme-dots">
                          {[sc.theme.red, sc.theme.yellow, sc.theme.green, sc.theme.cyan, sc.theme.blue, sc.theme.magenta].map((c, i) => <i key={i} style={{ background: c }} />)}
                        </span>
                      </span>
                      <span className="scheme-name">{sc.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              <Row label="Server stats under SSH tabs" hint="CPU, memory, disk and uptime of Linux servers"><Switch checked={s.stats_bar} onChange={(v) => up({ stats_bar: v })} /></Row>
            </>
          )}
          {section === "Terminal" && (
            <>
              <Row label="Font">
                <input className="w-200" value={s.font_family} spellCheck={false} onChange={(e) => up({ font_family: e.target.value })} />
              </Row>
              <Row label="Size">
                <div className="stepper">
                  <button onClick={() => up({ font_size: Math.max(8, s.font_size - 1) })}>−</button>
                  <span>{s.font_size}</span>
                  <button onClick={() => up({ font_size: Math.min(32, s.font_size + 1) })}>+</button>
                </div>
              </Row>
              <Row label="Line height">
                <div className="stepper">
                  <button onClick={() => up({ line_height: Math.max(1, +(s.line_height - 0.05).toFixed(2)) })}>−</button>
                  <span>{s.line_height.toFixed(2)}</span>
                  <button onClick={() => up({ line_height: Math.min(2, +(s.line_height + 0.05).toFixed(2)) })}>+</button>
                </div>
              </Row>
              <Row label="Cursor">
                <Segmented value={s.cursor_style} onChange={(cursor_style) => up({ cursor_style })} options={[{ id: "bar", label: "▏ Bar" }, { id: "block", label: "█ Block" }, { id: "underline", label: "▁ Line" }]} />
              </Row>
              <Row label="Blinking cursor"><Switch checked={s.cursor_blink} onChange={(v) => up({ cursor_blink: v })} /></Row>
              <Row label="Copy when selecting"><Switch checked={s.copy_on_select} onChange={(v) => up({ copy_on_select: v })} /></Row>
              <Row label="Right click pastes" hint="Like PuTTY and MobaXterm. Off: right click selects a word"><Switch checked={s.right_click_paste} onChange={(v) => up({ right_click_paste: v })} /></Row>
              <Row label="Bell">
                <Segmented value={s.bell} onChange={(bell) => up({ bell })} options={[{ id: "visual", label: "Flash" }, { id: "none", label: "Off" }]} />
              </Row>
              <Row label="Scrollback" hint="Lines kept per terminal">
                <input className="w-100" type="number" min={1000} step={1000} value={s.scrollback} onChange={(e) => up({ scrollback: Math.max(1000, +e.target.value) })} />
              </Row>
              <Row label="Default shell" hint="For new local terminals. Empty: your login shell">
                <select className="w-200" value={s.default_shell} onChange={(e) => up({ default_shell: e.target.value })}>
                  <option value="">Automatic</option>
                  {boot?.shells.map((sh) => <option key={sh.command} value={sh.command}>{sh.name}</option>)}
                </select>
              </Row>
              <Row label="Ask before closing a connected tab"><Switch checked={s.confirm_close} onChange={(v) => up({ confirm_close: v })} /></Row>
            </>
          )}
          {section === "Files" && (
            <>
              <Row label="Downloads go to" hint={s.download_dir || boot?.downloadDir}>
                <div className="input-with-btn">
                  <IconButton icon={FolderOpen} label="Choose folder" onClick={async () => {
                    const d = await pickFile({ directory: true, title: "Downloads go to" });
                    if (d) up({ download_dir: d as string });
                  }} />
                  {s.download_dir && <Button size="sm" variant="ghost" onClick={() => up({ download_dir: "" })}>Reset</Button>}
                </div>
              </Row>
              <Row label="Show dotfiles"><Switch checked={s.sftp_show_hidden} onChange={(v) => up({ sftp_show_hidden: v })} /></Row>
            </>
          )}
          {section === "Import" && (
            <>
              <p className="muted small">Sessions already here are skipped, so importing twice is safe. Passwords aren't imported.</p>
              <Row label="OpenSSH" hint="Hosts, users, ports, keys, ProxyJump and forwards from ~/.ssh/config">
                <Button size="sm" disabled={!boot?.hasSshConfig} onClick={() => runImport("ssh")}>Import</Button>
              </Row>
              <Row label="MobaXterm" hint="In MobaXterm: right-click User sessions › Export sessions, then pick the .mxtsessions file. MobaXterm.ini works too">
                <Button size="sm" onClick={() => runImport("mobaxterm")}>Choose file…</Button>
              </Row>
              <Row label="PuTTY" hint={boot?.platform === "windows" ? "From the registry" : "From ~/.putty/sessions"}>
                <Button size="sm" onClick={() => runImport("putty")}>Import</Button>
              </Row>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
