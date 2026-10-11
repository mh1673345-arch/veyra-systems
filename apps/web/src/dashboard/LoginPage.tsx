import { useState } from "react";
import { Navigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const { session, loading, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="ops-gate">
        <p className="ops-state">Loading…</p>
      </div>
    );
  }

  // Already signed in: send them on to where they were headed.
  if (session) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? "/dashboard"} replace />;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      // The server returns a deliberately generic message; show it as-is.
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ops-gate">
      <div className="ops-login-card">
        <div className="ops-brand">
          <span className="ops-brand-mark">Veyra</span>
          <span className="ops-brand-sub">Operations</span>
        </div>

        <form onSubmit={handleSubmit} className="ops-login-form">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          {error && (
            <p className="ops-state ops-state-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting || !email.trim() || !password}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="ops-note">
          New to Veyra? <Link to="/signup">Create an account</Link>
        </p>
      </div>
    </div>
  );
}
