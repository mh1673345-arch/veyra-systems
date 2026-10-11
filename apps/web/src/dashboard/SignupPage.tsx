import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { signUp } from "./opsClient";

/**
 * Self-service account creation. The server applies the same password policy
 * as a password change and signs the new user straight in; they then create
 * their workspace. No email verification exists yet (no email provider), and
 * this page doesn't pretend otherwise.
 */
export function SignupPage() {
  const { session, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && session) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signUp(name.trim(), email.trim(), password);
      await refresh();
      navigate("/dashboard/new", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create your account");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ops-gate">
      <div className="ops-login-card">
        <div className="ops-brand">
          <span className="ops-brand-mark">Veyra</span>
          <span className="ops-brand-sub">Create your account</span>
        </div>

        <form onSubmit={handleSubmit} className="ops-login-form">
          <label htmlFor="signup-name">Your name</label>
          <input id="signup-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />

          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <label htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            required
          />
          <p className="ops-note">At least 12 characters. Avoid common words.</p>

          {error && (
            <p className="ops-state ops-state-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting || !name.trim() || !email.trim() || !password}>
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="ops-note">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
