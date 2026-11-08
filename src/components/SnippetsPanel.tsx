import { useState } from "react";
import { Braces, CornerDownLeft, Pencil, Plus, Radio, Trash2 } from "lucide-react";
import { newId, type Snippet } from "../lib/api";
import { saveSnippets } from "../lib/data";
import { useStore } from "../lib/store";
import { sendText } from "../lib/terms";
import { Button, Empty, Field, IconButton, Modal, useMenu } from "./ui";

export function SnippetsPanel() {
  const snippets = useStore((s) => s.snippets);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const { open: menu, node } = useMenu();
  return (
    <section className="panel" aria-label="Snippets">
      <header className="panel-head">
        <h3>Snippets</h3>
        <div className="panel-actions">
          <IconButton icon={Plus} label="New snippet" onClick={() => setEditing({ id: newId(), name: "", text: "", run: true })} />
        </div>
      </header>
      <div className="panel-body">
        {snippets.length === 0 ? (
          <Empty icon={Braces} title="No snippets">
            <p>Commands you type often, one click away. Send them to the terminal you're in, or to every open terminal at once.</p>
          </Empty>
        ) : (
          snippets.map((s) => (
            <div
              key={s.id}
              className="snippet"
              onClick={() => sendText(s.text, s.run)}
              onContextMenu={(e) =>
                menu(e, [
                  { label: "Send to this terminal", icon: CornerDownLeft, run: () => sendText(s.text, s.run) },
                  { label: "Send to every terminal", icon: Radio, run: () => sendText(s.text, s.run, true) },
                  "-",
                  { label: "Edit…", icon: Pencil, run: () => setEditing(s) },
                  { label: "Delete", icon: Trash2, danger: true, run: () => saveSnippets(snippets.filter((x) => x.id !== s.id)) },
                ])
              }
              title="Click to send · right-click for more"
            >
              <div className="snippet-name">
                {s.name || s.text.split("\n")[0]}
                {s.run && <CornerDownLeft size={11} className="snippet-run" />}
              </div>
              <pre className="snippet-text">{s.text}</pre>
            </div>
          ))
        )}
      </div>
      {editing && (
        <Modal
          title={editing.name ? `Snippet · ${editing.name}` : "New snippet"}
          onClose={() => setEditing(null)}
          width={520}
          footer={<>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!editing.text.trim()}
              onClick={() => {
                const exists = snippets.some((x) => x.id === editing.id);
                saveSnippets(exists ? snippets.map((x) => (x.id === editing.id ? editing : x)) : [...snippets, editing]);
                setEditing(null);
              }}
            >
              Save
            </Button>
          </>}
        >
          <div className="form">
            <Field label="Name" wide>
              <input value={editing.name} placeholder="e.g. Disk usage" onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
            </Field>
            <Field label="Text" wide>
              <textarea className="mono" rows={5} value={editing.text} spellCheck={false} placeholder="df -h | sort -k5 -rn" onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
            </Field>
            <label className="check"><input type="checkbox" checked={editing.run} onChange={(e) => setEditing({ ...editing, run: e.target.checked })} /> Press Enter after sending</label>
          </div>
        </Modal>
      )}
      {node}
    </section>
  );
}
