import { useState } from "react";
import { KeyRound, ShieldAlert, ShieldQuestion, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { set, type Prompt } from "../lib/store";
import { Button } from "./ui";

/** Questions from the engine: unknown host keys, passwords, key passphrases, 2FA codes. */
export function PromptCard({ prompt }: { prompt: Prompt }) {
  const p = prompt.prompt;
  const [values, setValues] = useState<string[]>(() => (p.kind === "interactive" ? p.fields.map(() => "") : [""]));
  const [remember, setRemember] = useState(p.kind === "hostKey" ? true : false);
  const send = (ok: boolean, rememberOverride?: boolean) => {
    set((s) => ({ prompts: s.prompts.filter((q) => q.id !== prompt.id) }));
    api.answer(prompt.id, ok ? { values, remember: rememberOverride ?? remember } : null).catch(() => {});
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    send(true);
  };

  if (p.kind === "hostKey") {
    return (
      <div className={`card prompt hostkey ${p.changed ? "danger" : ""}`} role="alertdialog">
        {p.changed ? <ShieldAlert size={18} className="card-icon bad" /> : <ShieldQuestion size={18} className="card-icon" />}
        <div className="card-text">
          <div className="card-title">{p.changed ? "This server's identity changed" : "First time connecting to this server"}</div>
          <div className="card-sub">
            {p.changed ? (
              <>
                <b>{p.host}{p.port !== 22 ? `:${p.port}` : ""}</b> now shows a different key than the one you trusted before. That happens when a server is reinstalled, or when someone is intercepting the connection. Only continue if you know why it changed.
              </>
            ) : (
              <>Check that this fingerprint matches <b>{p.host}{p.port !== 22 ? `:${p.port}` : ""}</b> before you trust it.</>
            )}
          </div>
          <div className="fingerprint">
            <span className="fp-alg">{p.algorithm}</span>
            <code className="selectable">{p.fingerprint}</code>
          </div>
          <div className="card-actions">
            <Button size="sm" variant={p.changed ? "danger" : "primary"} autoFocus={!p.changed} onClick={() => send(true, true)}>
              {p.changed ? "Trust the new key" : "Trust and remember"}
            </Button>
            <Button size="sm" onClick={() => send(true, false)}>Just this once</Button>
            <Button size="sm" variant="ghost" autoFocus={p.changed} onClick={() => send(false)}>Cancel</Button>
          </div>
        </div>
      </div>
    );
  }

  const title =
    p.kind === "username" ? `Log in to ${p.host}` :
    p.kind === "password" ? (p.retry ? "That didn't work. Try again" : `Password for ${p.user}@${p.host}`) :
    p.kind === "passphrase" ? (p.retry ? "Wrong passphrase. Try again" : "Unlock your key") :
    p.name || `Sign in to ${p.host}`;
  const Icon = p.kind === "username" ? UserRound : KeyRound;

  return (
    <form className={`card prompt ${("retry" in p && p.retry) ? "shake" : ""}`} onSubmit={submit} role="dialog">
      <Icon size={18} className="card-icon" />
      <div className="card-text">
        <div className="card-title">{title}</div>
        {p.kind === "passphrase" && <div className="card-sub"><code>{p.path}</code></div>}
        {p.kind === "interactive" && p.instructions && <div className="card-sub pre">{p.instructions}</div>}
        {p.kind === "interactive" ? (
          p.fields.map((f, i) => (
            <label key={i} className="prompt-field">
              <span>{f.label.replace(/:\s*$/, "")}</span>
              <input
                type={f.echo ? "text" : "password"}
                autoFocus={i === 0}
                autoComplete={f.echo ? "one-time-code" : "off"}
                inputMode={/code|otp|token|verification/i.test(f.label) ? "numeric" : undefined}
                value={values[i] ?? ""}
                onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
              />
            </label>
          ))
        ) : (
          <input
            type={p.kind === "username" ? "text" : "password"}
            placeholder={p.kind === "username" ? "user name" : p.kind === "passphrase" ? "passphrase" : "password"}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={values[0]}
            onChange={(e) => setValues([e.target.value])}
          />
        )}
        {(p.kind === "password" || p.kind === "passphrase") && (
          <label className="check small">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember in the system keyring
          </label>
        )}
        <div className="card-actions">
          <Button size="sm" variant="primary" type="submit">{p.kind === "username" ? "Continue" : "Log in"}</Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => send(false)}>{p.kind === "passphrase" ? "Skip this key" : "Cancel"}</Button>
        </div>
      </div>
    </form>
  );
}
