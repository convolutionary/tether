import { useEffect, useMemo, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, Plus, Trash2 } from "lucide-react";
import { api, type Forward, type Protocol, type Session } from "../lib/api";
import { upsertSession } from "../lib/data";
import { get, set, toast, useStore } from "../lib/store";
import { label, openSession } from "../lib/terms";
import { Button, Field, IconButton, Modal, PROTOCOLS, Row, Switch } from "./ui";

const COLORS = ["", "#8b9cff", "#79c7c0", "#7fbf8f", "#e5b567", "#d6a46b", "#ef7b7b", "#e88fa6", "#c99be8"];
const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function SessionEditor({ initial }: { initial: Session }) {
  const sessions = useStore((s) => s.sessions);
  const isNew = !sessions.some((s) => s.id === initial.id);
  const [s, setS] = useState<Session>(initial);
  const [password, setPassword] = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [ports, setPorts] = useState<{ name: string; description: string }[]>([]);
  const up = (p: Partial<Session>) => setS((x) => ({ ...x, ...p }));

  useEffect(() => {
    if (!isNew && initial.save_password) api.hasPassword(initial.id).then(setHasSaved).catch(() => {});
  }, [initial.id, initial.save_password, isNew]);
  useEffect(() => {
    if (s.protocol === "serial") api.serialPorts().then(setPorts).catch(() => setPorts([]));
  }, [s.protocol]);

  const folders = useMemo(() => [...new Set(sessions.map((x) => x.folder).filter(Boolean))].sort(), [sessions]);
  const jumps = sessions.filter((x) => x.protocol === "ssh" && x.id !== s.id);
  const network = !["local", "serial"].includes(s.protocol);
  const sshLike = ["ssh", "sftp", "mosh"].includes(s.protocol);
  const valid = s.protocol === "local" || (s.protocol === "serial" ? !!s.device.trim() : !!s.host.trim());

  const setProtocol = (p: Protocol) => {
    const defaults: Record<Protocol, number> = { ssh: 22, sftp: 22, mosh: 22, telnet: 23, rdp: 3389, vnc: 5900, local: 0, serial: 0 };
    const portWasDefault = Object.values(defaults).includes(s.port) || !s.port;
    up({ protocol: p, port: portWasDefault ? defaults[p] : s.port });
  };

  const save = async (connect: boolean) => {
    const final: Session = { ...s, name: s.name.trim(), host: s.host.trim(), user: s.user.trim(), folder: s.folder.split("/").map((x) => x.trim()).filter(Boolean).join("/") };
    if (password) {
      try {
        await api.setPassword(final.id, password);
        final.save_password = true;
      } catch (e) {
        toast(`Couldn't store the password: ${e}`, "bad");
      }
    } else if (!final.save_password && hasSaved) {
      await api.setPassword(final.id, null).catch(() => {});
    }
    upsertSession(final);
    set({ editing: null });
    if (connect) openSession(final);
  };

  return (
    <Modal
      title={isNew ? "New session" : `Edit · ${label(initial)}`}
      onClose={() => set({ editing: null })}
      width={760}
      className="editor"
      footer={
        <>
          <span className="foot-note">{s.protocol === "ssh" ? "Keys from your SSH agent and ~/.ssh are tried first." : ""}</span>
          <Button onClick={() => set({ editing: null })}>Cancel</Button>
          <Button disabled={!valid} onClick={() => save(false)}>Save</Button>
          <Button variant="primary" disabled={!valid} onClick={() => save(true)}>Save and connect</Button>
        </>
      }
    >
      <div className="editor-grid">
        <nav className="proto-list" aria-label="Protocol">
          {PROTOCOLS.map((p) => (
            <button key={p.id} className={`proto ${s.protocol === p.id ? "on" : ""}`} onClick={() => setProtocol(p.id)} style={{ ["--pc" as string]: `var(--p-${p.id})` }}>
              <p.icon size={15} strokeWidth={1.7} />
              <span className="proto-name">{p.name}</span>
              <span className="proto-hint">{p.hint}</span>
            </button>
          ))}
        </nav>

        <div className="form editor-form">
          {network && (
            <div className="form-grid host-grid">
              <Field label="Host">
                <input autoFocus value={s.host} placeholder="server.example.com or 10.0.0.5" spellCheck={false} onChange={(e) => up({ host: e.target.value })} />
              </Field>
              <Field label="Port">
                <input type="number" min={1} max={65535} value={s.port || ""} onChange={(e) => up({ port: +e.target.value })} />
              </Field>
              {s.protocol !== "vnc" && (
                <Field label="User" hint={s.protocol === "ssh" ? "Leave empty to be asked" : undefined}>
                  <input value={s.user} placeholder={s.protocol === "rdp" ? "Administrator" : "root"} spellCheck={false} onChange={(e) => up({ user: e.target.value })} />
                </Field>
              )}
              {s.protocol === "rdp" && (
                <Field label="Domain">
                  <input value={s.domain} placeholder="optional" spellCheck={false} onChange={(e) => up({ domain: e.target.value })} />
                </Field>
              )}
            </div>
          )}

          {s.protocol === "serial" && (
            <div className="form-grid">
              <Field label="Port" hint={ports.length ? undefined : "No serial ports found right now. Type one"}>
                <input list="serial-ports" value={s.device} placeholder={get().boot?.platform === "windows" ? "COM3" : "/dev/ttyUSB0"} spellCheck={false} onChange={(e) => up({ device: e.target.value })} autoFocus />
                <datalist id="serial-ports">{ports.map((p) => <option key={p.name} value={p.name}>{p.description}</option>)}</datalist>
              </Field>
              <Field label="Speed">
                <select value={s.baud} onChange={(e) => up({ baud: +e.target.value })}>
                  {BAUDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </Field>
              <Field label="Data bits">
                <select value={s.data_bits} onChange={(e) => up({ data_bits: +e.target.value })}>{[8, 7, 6, 5].map((b) => <option key={b}>{b}</option>)}</select>
              </Field>
              <Field label="Parity">
                <select value={s.parity} onChange={(e) => up({ parity: e.target.value })}>{["none", "odd", "even"].map((b) => <option key={b}>{b}</option>)}</select>
              </Field>
              <Field label="Stop bits">
                <select value={s.stop_bits} onChange={(e) => up({ stop_bits: +e.target.value })}>{[1, 2].map((b) => <option key={b}>{b}</option>)}</select>
              </Field>
              <Field label="Flow control">
                <select value={s.flow} onChange={(e) => up({ flow: e.target.value })}>{["none", "hardware", "software"].map((b) => <option key={b}>{b}</option>)}</select>
              </Field>
            </div>
          )}

          {s.protocol === "local" && (
            <div className="form-grid">
              <Field label="Program" hint="Empty runs your default shell" wide>
                <input value={s.command} placeholder={get().boot?.shells[0]?.command ?? "bash -l"} spellCheck={false} onChange={(e) => up({ command: e.target.value })} autoFocus />
              </Field>
              <Field label="Start in" wide>
                <input value={s.cwd} placeholder="~" spellCheck={false} onChange={(e) => up({ cwd: e.target.value })} />
              </Field>
            </div>
          )}

          {(sshLike || s.protocol === "rdp" || s.protocol === "vnc") && (
            <div className="form-section">
              <div className="form-h">Sign in</div>
              <div className="form-grid">
                {s.protocol !== "mosh" && (
                  <Field label={s.protocol === "vnc" ? "VNC password" : "Password"} hint={s.save_password && hasSaved && !password ? "Saved in the keyring. Type to replace" : "Kept in the system keyring, never in Tether's files"}>
                    <input type="password" value={password} placeholder={s.save_password && hasSaved ? "••••••••" : "ask when connecting"} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
                  </Field>
                )}
                {sshLike && (
                  <Field label="Private key" hint="Empty: SSH agent, then ~/.ssh/id_*">
                    <div className="input-with-btn">
                      <input value={s.identity} placeholder="~/.ssh/id_ed25519" spellCheck={false} onChange={(e) => up({ identity: e.target.value })} />
                      <IconButton icon={FolderOpen} label="Choose key file" onClick={async () => {
                        const f = await pickFile({ title: "Private key" });
                        if (f) up({ identity: f as string });
                      }} />
                    </div>
                  </Field>
                )}
              </div>
              {initial.save_password && hasSaved && !password && (
                <label className="check small"><input type="checkbox" checked={!s.save_password} onChange={(e) => up({ save_password: !e.target.checked })} /> Forget the saved password</label>
              )}
            </div>
          )}

          {(s.protocol === "ssh" || s.protocol === "sftp" || s.protocol === "rdp" || s.protocol === "vnc") && (
            <Field label={s.protocol === "ssh" || s.protocol === "sftp" ? "Jump host" : "Through SSH"} hint={s.protocol === "rdp" || s.protocol === "vnc" ? "Encrypts the connection and reaches hosts only that server can see" : "Connect by way of another saved SSH session (ProxyJump)"} wide>
              <select value={s.jump ?? ""} onChange={(e) => up({ jump: e.target.value || null })}>
                <option value="">{s.protocol === "rdp" || s.protocol === "vnc" ? "Direct" : "None"}</option>
                {jumps.map((j) => <option key={j.id} value={j.id}>{label(j)}</option>)}
              </select>
            </Field>
          )}

          <div className="form-grid">
            <Field label="Name">
              <input value={s.name} placeholder={label({ ...s, name: "" }) || "optional"} onChange={(e) => up({ name: e.target.value })} />
            </Field>
            <Field label="Folder" hint="Use / for nesting: Work/Lab">
              <input list="folders" value={s.folder} placeholder="none" spellCheck={false} onChange={(e) => up({ folder: e.target.value })} />
              <datalist id="folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
            </Field>
          </div>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            <span className="field-label">Colour</span>
            {COLORS.map((c) => (
              <button key={c || "auto"} role="radio" aria-checked={s.color === c} className={`swatch ${s.color === c ? "on" : ""} ${c ? "" : "auto"}`} style={c ? { background: c } : { ["--sw" as string]: `var(--p-${s.protocol})` }} title={c || "Protocol colour"} onClick={() => up({ color: c })} />
            ))}
          </div>

          {(s.protocol === "ssh" || s.protocol === "rdp" || s.protocol === "mosh" || s.protocol === "telnet" || s.protocol === "local" || s.protocol === "serial") && (
            <button className="disclosure" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              <ChevronDown size={13} className={advanced ? "open" : ""} /> Advanced
            </button>
          )}
          {advanced && (
            <div className="form-section advanced">
              {s.protocol === "ssh" && (
                <>
                  <Row label="Files follow the terminal" hint="The Files panel opens wherever you cd"><Switch checked={s.follow_cwd} onChange={(v) => up({ follow_cwd: v })} /></Row>
                  <Row label="X11 forwarding" hint="Show remote graphical apps here"><Switch checked={s.x11} onChange={(v) => up({ x11: v })} /></Row>
                  <Row label="Forward SSH agent" hint="Lets the server use your keys to go further. Only on servers you trust"><Switch checked={s.agent_forward} onChange={(v) => up({ agent_forward: v })} /></Row>
                  <Row label="Compression" hint="Helps on slow links"><Switch checked={s.compression} onChange={(v) => up({ compression: v })} /></Row>
                  <div className="form-grid">
                    <Field label="Keep-alive (seconds)" hint="0 turns it off">
                      <input type="number" min={0} value={s.keepalive_secs} onChange={(e) => up({ keepalive_secs: +e.target.value })} />
                    </Field>
                    <Field label="Terminal type">
                      <input value={s.term_type} spellCheck={false} onChange={(e) => up({ term_type: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="Run instead of a shell" wide>
                    <input value={s.remote_command} placeholder="e.g. tmux new -A -s main" spellCheck={false} onChange={(e) => up({ remote_command: e.target.value })} />
                  </Field>
                  <Forwards list={s.forwards} onChange={(forwards) => up({ forwards })} />
                </>
              )}
              {s.protocol === "mosh" && (
                <Field label="Extra mosh options" wide>
                  <input value={s.command} placeholder="--predict=always" spellCheck={false} onChange={(e) => up({ command: e.target.value })} />
                </Field>
              )}
              {s.protocol === "rdp" && (
                <Field label="Extra client options" hint={get().boot?.platform === "windows" ? "Passed to mstsc, e.g. /f /multimon" : "Passed to FreeRDP, e.g. /f /multimon /scale:140"} wide>
                  <input value={s.rdp_args} spellCheck={false} onChange={(e) => up({ rdp_args: e.target.value })} />
                </Field>
              )}
              {s.protocol !== "rdp" && (
                <Row label="Log to a file" hint="Everything the session prints is saved in Tether's logs folder"><Switch checked={s.log} onChange={(v) => up({ log: v })} /></Row>
              )}
            </div>
          )}

          <Field label="Notes" wide>
            <textarea rows={2} value={s.notes} placeholder="Shown when you hover the session" onChange={(e) => up({ notes: e.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function Forwards({ list, onChange }: { list: Forward[]; onChange: (l: Forward[]) => void }) {
  const upd = (i: number, p: Partial<Forward>) => onChange(list.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <div className="forwards">
      <div className="forwards-head">
        <span className="field-label">Port forwards</span>
        <span className="field-hint">Open while this tab is open. For ones that keep running, use Tunnels.</span>
        <IconButton icon={Plus} label="Add forward" onClick={() => onChange([...list, { kind: "Local", bind: "", port: 0, host: "localhost", host_port: 0 }])} />
      </div>
      {list.map((f, i) => (
        <div className="fwd" key={i}>
          <select value={f.kind} onChange={(e) => upd(i, { kind: e.target.value as Forward["kind"] })}>
            <option value="Local">-L local</option>
            <option value="Remote">-R remote</option>
            <option value="Dynamic">-D SOCKS</option>
          </select>
          <input type="number" placeholder="port" value={f.port || ""} onChange={(e) => upd(i, { port: +e.target.value })} />
          {f.kind !== "Dynamic" ? (
            <>
              <span className="arrow">→</span>
              <input placeholder="host" value={f.host} spellCheck={false} onChange={(e) => upd(i, { host: e.target.value })} />
              <input type="number" placeholder="port" value={f.host_port || ""} onChange={(e) => upd(i, { host_port: +e.target.value })} />
            </>
          ) : (
            <span className="fwd-note">SOCKS5 proxy</span>
          )}
          <IconButton icon={Trash2} label="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))} />
        </div>
      ))}
    </div>
  );
}
