import { useState } from "react";
import type { ContactVerificationState, CustomerContactDto } from "@veyra/shared";
import {
  getConfirmationDestinations,
  getCustomerContact,
  updateCustomerContact
} from "../opsClient";
import { StateBlock } from "../components";
import { useAsync } from "../useAsync";

/**
 * The customer behind a conversation, in as little space as possible.
 *
 * Not a CRM: enough to see who this is, how they can be reached, and how
 * firmly any of that is actually known. The verification state is shown in
 * words rather than a tick, because "they typed it into a form" and "we
 * proved they own it" are different facts and only one of them exists today.
 *
 * The phone arrives masked from the server, so there is no full number in
 * this component to leak into a screenshot or a support ticket.
 */

const STATE_LABEL: Record<ContactVerificationState, string> = {
  unknown: "not known",
  provided: "given, not verified",
  channel_confirmed: "confirmed on this channel",
  verified: "verified"
};

export function ContactCard({
  businessId,
  contactId,
  conversationId,
  canEdit
}: {
  businessId: string;
  contactId: string;
  conversationId: string;
  canEdit: boolean;
}) {
  const state = useAsync(() => getCustomerContact(businessId, contactId), [businessId, contactId]);
  const destinations = useAsync(
    () => getConfirmationDestinations(businessId, conversationId),
    [businessId, conversationId]
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ name: string; phone: string; email: string }>({
    name: "",
    phone: "",
    email: ""
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contact: CustomerContactDto | null = state.data ?? null;

  function startEditing(current: CustomerContactDto) {
    // The phone is masked, so the field starts empty rather than showing
    // dots an operator might save back over the real number.
    setDraft({ name: current.displayName ?? "", phone: "", email: current.email ?? "" });
    setError(null);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateCustomerContact(businessId, contactId, {
        name: draft.name.trim() || null,
        // An untouched phone field means "leave it alone", not "clear it".
        ...(draft.phone.trim() ? { phone: draft.phone.trim() } : {}),
        email: draft.email.trim() || null
      });
      setEditing(false);
      state.reload();
      destinations.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-panel" data-testid="contact-card">
      <h3>Customer</h3>
      <StateBlock loading={state.loading && !contact} error={state.error} onRetry={state.reload}>
        {contact && (
          <>
            <dl className="ops-detail">
              <dt>Name</dt>
              <dd data-testid="contact-name">{contact.displayName ?? "Not given"}</dd>
              <dt>Phone</dt>
              <dd data-testid="contact-phone">
                {contact.phone ?? "Not given"}
                <span className="ops-note"> · {STATE_LABEL[contact.phoneState]}</span>
              </dd>
              <dt>Email</dt>
              <dd data-testid="contact-email">
                {contact.email ?? "Not given"}
                <span className="ops-note"> · {STATE_LABEL[contact.emailState]}</span>
              </dd>
              <dt>First seen on</dt>
              <dd data-testid="contact-source">{contact.source}</dd>
              <dt>Messaging consent</dt>
              <dd data-testid="contact-consent">
                SMS: {contact.smsConsent} · WhatsApp: {contact.whatsappConsent}
              </dd>
              <dt>Linked</dt>
              <dd data-testid="contact-linked">
                {contact.bookingCount} booking{contact.bookingCount === 1 ? "" : "s"} ·{" "}
                {contact.conversationCount} conversation{contact.conversationCount === 1 ? "" : "s"}
              </dd>
            </dl>

            <h4>Confirmation would go to</h4>
            <StateBlock
              loading={destinations.loading && !destinations.data}
              error={destinations.error}
              onRetry={destinations.reload}
            >
              {destinations.data && (
                <ul className="ops-plain-list" data-testid="contact-destinations">
                  {destinations.data.available.map((destination) => (
                    <li key={destination.channel}>
                      <strong>{destination.channel}</strong> {destination.to}
                      <span className="ops-note"> · {destination.reason}</span>
                    </li>
                  ))}
                  {destinations.data.blocked.map((blocked) => (
                    <li key={`blocked-${blocked.channel}`} className="ops-note">
                      {blocked.channel} unavailable — {blocked.reason}
                    </li>
                  ))}
                  {destinations.data.available.length === 0 && destinations.data.blocked.length === 0 && (
                    <li className="ops-note" data-testid="contact-no-destination">
                      Nowhere — this customer has given no contact details.
                    </li>
                  )}
                </ul>
              )}
            </StateBlock>

            {canEdit && !editing && (
              <div className="ops-actions">
                <button type="button" data-testid="contact-edit" onClick={() => startEditing(contact)}>
                  Correct details
                </button>
              </div>
            )}

            {canEdit && editing && (
              <div className="ops-actions" data-testid="contact-form">
                <label>
                  Name
                  <input
                    type="text"
                    value={draft.name}
                    data-testid="contact-name-input"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label>
                  Phone
                  <input
                    type="tel"
                    value={draft.phone}
                    placeholder="Leave blank to keep the current number"
                    data-testid="contact-phone-input"
                    onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    value={draft.email}
                    data-testid="contact-email-input"
                    onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                  />
                </label>
                <button type="button" disabled={busy} data-testid="contact-save" onClick={save}>
                  Save
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <p className="ops-note">
                  Correcting a number changes where future messages go. Messages already sent are not
                  rewritten.
                </p>
              </div>
            )}

            {error && (
              <p className="ops-error" data-testid="contact-error">
                {error}
              </p>
            )}
          </>
        )}
      </StateBlock>
    </section>
  );
}
