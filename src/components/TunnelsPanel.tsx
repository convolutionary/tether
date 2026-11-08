import { useState } from "react";
import { ArrowLeftRight, Pencil, Plus, Trash2 } from "lucide-react";
import { api, newId, type ForwardKind, type Tunnel, type TunnelState } from "../lib/api";
import { saveTunnels } from "../lib/data";
import { set, toast, useStore } from "../lib/store";
import { label } from "../lib/terms";
import { Button, Empty, Field, IconButton, Modal, Segmented, Switch, useMenu } from "./ui";

export function describe(t: Tunnel["forward"]): { from: string; to: string } {
  const bind = t.bind || "localhost";
  if (t.kind === "Dynamic") return { from: `${bind}:${t.port}`, to: "SOCKS5 proxy" };
  if (t.kind === "Remote") return { from: `server ${bind}:${t.port}`, to: `${t.host}:${t.host_port}` };
  return { from: `${bind}:${t.port}`, to: `${t.host}:${t.host_port}` };
}

function stateText(st: TunnelState | undefined): { text: string; cls: string } {
  switch (st?.state) {
    case "running":
      return { text: st.connections ? `${st.connections} open` : "up", cls: "ok" };
    case "connecting":
      return { text: "connecting", cls: "busy" };
    case "failed":
      return { text: st.retrying ? "retrying" : "failed", cls: "bad" };
    default:
      return { text: "off", cls: "off" };
  }
}

export function TunnelsPanel() {
  const tunnels = useStore((s) => s.tunnels);
  const states = useStore((s) => s.tunnelStates);
  const sessions = useStore((s) => s.sessions);
  const [editing, setEditing] = useState<Tunnel | null>(null);
  const { open: menu, node } = useMenu();

  const on = (t: Tunnel) => {
    const st = states[t.id]?.state;
    return st === "running" || st === "connecting" || (st === "failed" && (states[t.id] as { retrying: boolean }).retrying);
  };
  const toggle = (t: Tunnel, v: boolean) => {
    if (v) api.tunnelStart(t).catch((e) => toast(String(e), "bad"));
    else api.tunnelStop(t.id);
  };

  const sshSessions = sessions.filter((s) => s.protocol === "ssh");

  return (
    <section className="panel" aria-label="Tunnels">
      <header className="panel-head">
        <h3>Tunnels</h3>
        <div className="panel-actions">
          <IconButton
            icon={Plus}
            label="New tunnel"
            onClick={() => {
              if (!sshSessions.length) {
                toast("Tunnels run over an SSH session: save one first", "info");
                return;
              }
              setEditing({
                id: newId(),
                name: "",
                session: sshSessions[0].id,
                forward: { kind: "Local", bind: "", port: 8080, host: "localhost", host_port: 80 },
                autostart: false,
                keep_alive: true,
              });
            }}
          />
        </div>
      </header>
      <div className="panel-body">
        {tunnels.length === 0 ? (
          <Empty icon={ArrowLeftRight} title="No tunnels">
            <p>Reach a database, a web UI or a whole network through one of your SSH servers. Tunnels keep running when you close tabs, and reconnect on their own.</p>
          </Empty>
        ) : (
          tunnels.map((t) => {
            const st = stateText(states[t.id]);
            const via = sessions.find((s) => s.id === t.session);
            const d = describe(t.forward);
            const err = states[t.id]?.state === "failed" ? (states[t.id] as { error: string }).error : null;
            return (
              <div
                key={t.id}
                className="tunnel"
                onContextMenu={(e) =>
                  menu(e, [
                    { label: "Edit…", icon: Pencil, run: () => setEditing(t) },
                    { label: "Delete", icon: Trash2, danger: true, run: () => {
                      api.tunnelStop(t.id);
                      saveTunnels(tunnels.filter((x) => x.id !== t.id));
                    } },
                  ])
                }
                onDoubleClick={() => setEditing(t)}
              >
                <div className="tunnel-top">
                  <span className={`tstate ${st.cls}`} />
                  <span className="tunnel-name">{t.name || d.from}</span>
                  <span className={`tunnel-state ${st.cls}`}>{st.text}</span>
                  <Switch checked={on(t)} onChange={(v) => toggle(t, v)} label={`Run ${t.name}`} />
                </div>
                <div className="tunnel-route">
                  <code>{d.from}</code>
                  <span className="arrow">→</span>
                  <code>{d.to}</code>
                </div>
                <div className="tunnel-via">via {via ? label(via) : <i>deleted session</i>}{t.autostart ? " · starts with Tether" : ""}</div>
                {err && <div className="tunnel-err">{err}</div>}
              </div>
            );
          })
        )}
      </div>
      {editing && (
        <TunnelEditor
          tunnel={editing}
          onClose={() => setEditing(null)}
          onSave={(t) => {
            const exists = tunnels.some((x) => x.id === t.id);
            saveTunnels(exists ? tunnels.map((x) => (x.id === t.id ? t : x)) : [...tunnels, t]);
            setEditing(null);
            if (on(t)) {
              api.tunnelStop(t.id);
              setTimeout(() => api.tunnelStart(t).catch(() => {}), 200);
            }
          }}
        />
      )}
      {node}
    </section>
  );
}

function TunnelEditor({ tunnel, onClose, onSave }: { tunnel: Tunnel; onClose: () => void; onSave: (t: Tunnel) => void }) {
  const sessions = useStore((s) => s.sessions.filter((x) => x.protocol === "ssh"));
  const [t, setT] = useState(tunnel);
  const f = t.forward;
  const setF = (p: Partial<Tunnel["forward"]>) => setT({ ...t, forward: { ...f, ...p } });
  const valid = f.port > 0 && f.port < 65536 && (f.kind === "Dynamic" || (f.host && f.host_port > 0)) && t.session;
  const explain = {
    Local: "A port on this computer reaches a host:port as seen from the server. For databases and web UIs behind it.",
    Remote: "A port on the server reaches a host:port as seen from this computer. To show the server something running here.",
    Dynamic: "A SOCKS5 proxy on this computer whose connections leave from the server. Point a browser at it to browse as the server.",
  }[f.kind];
  return (
    <Modal
      title={tunnel.name ? `Tunnel · ${tunnel.name}` : "New tunnel"}
      onClose={onClose}
      width={520}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid} onClick={() => onSave(t)}>Save</Button>
      </>}
    >
      <div className="form">
        <Field label="Kind" wide>
          <Segmented<ForwardKind>
            value={f.kind}
            onChange={(kind) => setF({ kind })}
            options={[
              { id: "Local", label: "Local  -L" },
              { id: "Remote", label: "Remote  -R" },
              { id: "Dynamic", label: "SOCKS  -D" },
            ]}
          />
        </Field>
        <p className="form-note">{explain}</p>
        <Field label="Through" wide>
          <select value={t.session} onChange={(e) => setT({ ...t, session: e.target.value })}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
          </select>
        </Field>
        <div className="form-grid">
          <Field label={f.kind === "Remote" ? "Server listens on" : "Listen on"}>
            <input value={f.bind} placeholder={f.kind === "Remote" ? "localhost" : "127.0.0.1"} onChange={(e) => setF({ bind: e.target.value })} spellCheck={false} />
          </Field>
          <Field label="Port">
            <input type="number" min={1} max={65535} value={f.port || ""} onChange={(e) => setF({ port: +e.target.value })} />
          </Field>
          {f.kind !== "Dynamic" && (
            <>
              <Field label={f.kind === "Remote" ? "Forward to (from here)" : "Forward to (from the server)"}>
                <input value={f.host} onChange={(e) => setF({ host: e.target.value })} spellCheck={false} />
              </Field>
              <Field label="Port">
                <input type="number" min={1} max={65535} value={f.host_port || ""} onChange={(e) => setF({ host_port: +e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <Field label="Name" wide>
          <input value={t.name} placeholder="optional, e.g. Postgres on db-01" onChange={(e) => setT({ ...t, name: e.target.value })} />
        </Field>
        <label className="check"><input type="checkbox" checked={t.autostart} onChange={(e) => setT({ ...t, autostart: e.target.checked })} /> Start with Tether</label>
        <label className="check"><input type="checkbox" checked={t.keep_alive} onChange={(e) => setT({ ...t, keep_alive: e.target.checked })} /> Reconnect when the connection drops</label>
      </div>
    </Modal>
  );
}

// for the palette
export function openTunnelEditor() {
  set({ panel: "tunnels" });
}
