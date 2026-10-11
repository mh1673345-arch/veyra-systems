import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  changePassword,
  getNotificationPreferences,
  listSessions,
  revokeOtherSessions,
  updateNotificationPreferences
} from "./opsClient";
import { useAsync } from "./useAsync";
import { StateBlock, formatDateTime } from "./components";
import { useAuth } from "./AuthContext";

export function AccountPage() {
  const { session } = useAuth();
  const { businessId = "" } = useParams();
  const sessions = useAsync(() => listSessions(), []);
  const prefs = useAsync(() => getNotificationPreferences(businessId), [businessId]);
  const [prefError, setPrefError] = useState<string | null>(null);

  async function togglePreference(key: "new_booking_email" | "new_escalation_email", value: boolean) {
    setPrefError(null);
    try {
      await updateNotificationPreferences(businessId, { [key]: value });
      prefs.reload();
    } catch (err) {
      setPrefError(err instanceof Error ? err.message : "Could not update preferences");
    }
  }

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handlePasswordChange(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setPasswordError(null);
    setPasswordMessage(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordMessage(
        "Password changed. Every other device has been signed out; this one stays signed in."
      );
      sessions.reload();
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Could not change password");
    } finally {
      setPending(false);
    }
  }

  async function handleRevokeOthers() {
    setPending(true);
    setPasswordError(null);
    setPasswordMessage(null);
    try {
      const { revoked } = await revokeOtherSessions();
      setPasswordMessage(
        revoked === 0 ? "No other sessions were active." : `Signed out ${revoked} other session(s).`
      );
      sessions.reload();
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Could not revoke sessions");
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <header className="ops-page-head">
        <h1>Account</h1>
      </header>

      <dl className="ops-detail">
        <dt>Name</dt>
        <dd>{session?.user.name}</dd>
        <dt>Email</dt>
        <dd>{session?.user.email}</dd>
      </dl>

      <h2>Email notifications</h2>
      <StateBlock loading={prefs.loading} error={prefs.error} onRetry={prefs.reload}>
        {prefs.data && (
          <>
            {!prefs.data.emailAvailable && (
              <p className="ops-note">
                This business has email notifications switched off, so none of these will be sent
                even if enabled here.
              </p>
            )}
            <div className="ops-pref-list">
              <label>
                <input
                  type="checkbox"
                  checked={prefs.data.new_booking_email}
                  onChange={(e) => togglePreference("new_booking_email", e.target.checked)}
                />
                Email me about new booking requests
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={prefs.data.new_escalation_email}
                  onChange={(e) => togglePreference("new_escalation_email", e.target.checked)}
                />
                Email me about new escalations
              </label>
            </div>
            {prefError && <p className="ops-state ops-state-error">{prefError}</p>}
          </>
        )}
      </StateBlock>

      <h2>Active sessions</h2>
      <StateBlock
        loading={sessions.loading}
        error={sessions.error}
        empty={(sessions.data?.length ?? 0) === 0}
        emptyMessage="No active sessions."
        onRetry={sessions.reload}
      >
        <table className="ops-table">
          <thead>
            <tr>
              <th>Signed in</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.data?.map((item) => (
              <tr key={item.id}>
                <td>{formatDateTime(item.createdAt)}</td>
                <td>{formatDateTime(item.lastUsedAt)}</td>
                <td>{formatDateTime(item.expiresAt)}</td>
                <td>{item.current && <span className="ops-tag">this device</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </StateBlock>

      <div className="ops-actions">
        <button type="button" onClick={handleRevokeOthers} disabled={pending}>
          Sign out all other devices
        </button>
      </div>

      <h2>Change password</h2>
      <form className="ops-login-form ops-account-form" onSubmit={handlePasswordChange}>
        <label htmlFor="current-password">Current password</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />

        <label htmlFor="new-password">New password</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
        />
        <p className="ops-state">At least 12 characters. Passphrases are fine and encouraged.</p>

        <button type="submit" disabled={pending || !currentPassword || !newPassword}>
          Change password
        </button>
      </form>

      {passwordMessage && <p className="ops-state">{passwordMessage}</p>}
      {passwordError && <p className="ops-state ops-state-error">{passwordError}</p>}
    </section>
  );
}
