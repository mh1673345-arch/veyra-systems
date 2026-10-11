import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { INDUSTRY_TEMPLATES, type Industry } from "@veyra/shared";
import { useAuth } from "./AuthContext";
import { createWorkspace } from "./opsClient";

/** Every IANA zone the browser knows, with a short fallback list for older engines. */
export function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.("timeZone");
  return zones && zones.length > 0
    ? zones
    : ["UTC", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Karachi", "Asia/Dubai", "Australia/Sydney"];
}

/**
 * Create a workspace. The server creates the business in draft, makes this user
 * its owner, starts a Starter subscription and applies safe booking defaults
 * for the chosen industry. Nothing is invented: services, FAQs and hours come
 * next, from the business itself.
 */
export function CreateWorkspacePage() {
  const { refresh, session } = useAuth();
  const navigate = useNavigate();
  const zones = useMemo(timezoneOptions, []);
  // ~400 zones: built once, not on every keystroke.
  const zoneOptions = useMemo(
    () =>
      zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      )),
    [zones]
  );
  // A suggestion only; the owner confirms it. Reception always uses the
  // business timezone saved here, never a visitor's browser zone.
  const guessedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [form, setForm] = useState({
    name: "",
    industry: "general" as Industry,
    timezone: zones.includes(guessedZone) ? guessedZone : "UTC",
    email: session?.user.email ?? "",
    phone: "",
    website: "",
    address: ""
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Suggest the account's email once the session has loaded, without
  // overwriting anything the owner already typed.
  const sessionEmail = session?.user.email;
  useEffect(() => {
    if (sessionEmail) setForm((current) => (current.email ? current : { ...current, email: sessionEmail }));
  }, [sessionEmail]);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { businessId } = await createWorkspace({
        ...form,
        website: form.website.trim() || undefined,
        address: form.address.trim() || undefined
      });
      await refresh();
      navigate(`/dashboard/${businessId}/setup`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the workspace");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ops-gate">
      <div className="ops-login-card ops-wide-card">
        <div className="ops-brand">
          <span className="ops-brand-mark">Veyra</span>
          <span className="ops-brand-sub">Set up your business</span>
        </div>
        <p className="ops-note">
          This creates your workspace on the Starter plan. Reception stays off until you review it and go live.
        </p>

        <form onSubmit={handleSubmit} className="ops-login-form" data-testid="create-workspace-form">
          <label htmlFor="ws-name">Business name</label>
          <input id="ws-name" value={form.name} onChange={set("name")} required />

          <label htmlFor="ws-industry">Industry</label>
          <select id="ws-industry" value={form.industry} onChange={set("industry")}>
            {Object.values(INDUSTRY_TEMPLATES).map((template) => (
              <option key={template.key} value={template.key}>
                {template.label}
              </option>
            ))}
          </select>

          <label htmlFor="ws-timezone">Timezone</label>
          <select id="ws-timezone" value={form.timezone} onChange={set("timezone")}>
            {zoneOptions}
          </select>

          <label htmlFor="ws-email">Contact email</label>
          <input id="ws-email" type="email" value={form.email} onChange={set("email")} required />

          <label htmlFor="ws-phone">Phone</label>
          <input id="ws-phone" type="tel" value={form.phone} onChange={set("phone")} required />

          <label htmlFor="ws-website">Website (optional)</label>
          <input id="ws-website" type="url" placeholder="https://" value={form.website} onChange={set("website")} />

          <label htmlFor="ws-address">Address (optional)</label>
          <input id="ws-address" value={form.address} onChange={set("address")} />

          {error && (
            <p className="ops-state ops-state-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting || !form.name.trim() || !form.phone.trim() || !form.email.trim()}>
            {submitting ? "Creating…" : "Create workspace"}
          </button>
        </form>

        <p className="ops-note">
          <Link to="/dashboard">Back</Link>
        </p>
      </div>
    </div>
  );
}
