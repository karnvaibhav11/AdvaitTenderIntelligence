"use client";

import { useState } from "react";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { BASE_PATH } from "../base-path";
import { BrandName } from "../BrandName";
import { ThemeToggle } from "../ThemeToggle";
import type { ProcurementApi, SessionUser } from "../../shared/types";

const HIGHLIGHTS = [
  "Tender discovery, bid evaluation and compliance",
  "Spend, vendor, contract and delivery intelligence",
  "TattvaAI: evidence-cited answers over every record",
];

export function LoginScreen({ api, onSignedIn }: { api: ProcurementApi; onSignedIn: (user: SessionUser) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSignedIn(await api.login(username, password));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adv-login">
      <ThemeToggle className="adv-theme-corner" />
      <section className="adv-login-brand">
        <div className="adv-login-glow" aria-hidden />
        <div className="adv-login-grid" aria-hidden />
        <div className="adv-login-brand-inner">
          <img className="adv-login-logo" src={`${BASE_PATH}/advaitsi-icon.png`} alt="Advait" width={200} height={200} />
          <div className="adv-login-wordmark"><BrandName /></div>
          <p className="adv-login-tagline">Tender &amp; Procurement Intelligence</p>
          <ul className="adv-login-points">
            {HIGHLIGHTS.map((line) => <li key={line}><i aria-hidden />{line}</li>)}
          </ul>
        </div>
      </section>

      <section className="adv-login-form-side">
        <div className="adv-login-card">
          <h1>Sign in</h1>
          <p className="adv-login-note">Use the administrator account to open the tender and procurement dashboards.</p>
          <form onSubmit={submit}>
            <label>Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" placeholder="admin" required />
            </label>
            <label>Password
              <span className="adv-login-pw">
                <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="Enter your password" autoFocus required />
                <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </span>
            </label>
            {error && <p className="adv-login-error" role="alert">{error}</p>}
            <button type="submit" className="adv-login-submit" disabled={busy}><LockKeyhole size={15} /> {busy ? "Signing in…" : "Sign in"}</button>
          </form>
          <p className="adv-login-foot">Every query is audited. Synthetic demonstration data only.</p>
        </div>
      </section>
    </div>
  );
}
