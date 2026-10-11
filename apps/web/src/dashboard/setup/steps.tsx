import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  type BookingSettings,
  type BusinessProfile,
  CLOSING_STYLES,
  type ConfigFaq,
  type ConfigService,
  type EscalationSettings,
  INDUSTRY_TEMPLATES,
  type Industry,
  PLAN_CATALOG,
  RECEPTION_TONES,
  type ReadinessReport,
  type ReceptionSettings,
  type WorkingDay
} from "@veyra/shared";
import {
  ApiError,
  addMember,
  getCalendarSettings,
  listMembers,
  setup
} from "../opsClient";
import { StateBlock } from "../components";
import { useAsync } from "../useAsync";
import { timezoneOptions } from "../CreateWorkspacePage";
import { useStep } from "./SetupWizard";

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Registers a form's save with the wizard's "Save & continue". */
function useRegisterSave(save: (() => Promise<void>) | null, deps: unknown[]) {
  const { registerSave } = useStep();
  useEffect(() => {
    registerSave(save);
    return () => registerSave(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* ------------------------------ 1. Details ------------------------------- */

export function BusinessDetailsStep() {
  const { businessId, canEdit } = useStep();
  const state = useAsync(() => setup.profile(businessId), [businessId]);
  const [form, setForm] = useState<BusinessProfile | null>(null);
  const zones = useMemo(timezoneOptions, []);
  useEffect(() => setForm(state.data), [state.data]);

  useRegisterSave(
    form && canEdit
      ? async () => {
          const saved = await setup.saveProfile(businessId, {
            name: form.name,
            industry: form.industry,
            timezone: form.timezone,
            contactPhone: form.contactPhone ?? "",
            contactEmail: form.contactEmail ?? "",
            website: form.website ?? "",
            address: form.address,
            description: form.description
          });
          setForm(saved);
        }
      : null,
    [form, canEdit]
  );

  const set = (key: keyof BusinessProfile) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((current) => (current ? { ...current, [key]: event.target.value } : current));

  return (
    <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
      {form && (
        <fieldset className="ops-form" disabled={!canEdit} data-testid="step-business-details">
          <label>
            Business name
            <input value={form.name} onChange={set("name")} />
          </label>
          <label>
            Industry
            <select value={form.industry} onChange={set("industry")}>
              {Object.values(INDUSTRY_TEMPLATES).map((template) => (
                <option key={template.key} value={template.key}>
                  {template.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Timezone
            <select value={form.timezone} onChange={set("timezone")}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <label>
            Public phone
            <input type="tel" value={form.contactPhone ?? ""} onChange={set("contactPhone")} />
          </label>
          <label>
            Contact email
            <input type="email" value={form.contactEmail ?? ""} onChange={set("contactEmail")} />
          </label>
          <label>
            Website
            <input type="url" placeholder="https://" value={form.website ?? ""} onChange={set("website")} />
          </label>
          <label>
            Address
            <input value={form.address} onChange={set("address")} />
          </label>
          <label className="ops-form-wide">
            Short description
            <textarea rows={3} value={form.description} onChange={set("description")} maxLength={1000} />
          </label>
        </fieldset>
      )}
    </StateBlock>
  );
}

/* ------------------------------ 2. Services ------------------------------ */

const EMPTY_SERVICE = { name: "", description: "", price: "", priceNote: "", durationMinutes: "", bookable: true };

export function ServicesStep() {
  const { businessId, canEdit } = useStep();
  const state = useAsync(() => setup.services(businessId), [businessId]);
  const profile = useAsync(() => setup.profile(businessId), [businessId]);
  const [services, setServices] = useState<ConfigService[] | null>(null);
  const [draft, setDraft] = useState(EMPTY_SERVICE);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setServices(state.data?.services ?? null), [state.data]);

  const suggestions = profile.data ? INDUSTRY_TEMPLATES[profile.data.industry as Industry]?.suggestedServices ?? [] : [];

  async function run(action: () => Promise<{ services: ConfigService[] }>) {
    setError(null);
    try {
      setServices((await action()).services);
    } catch (err) {
      setError(message(err, "Could not save the service"));
    }
  }

  function toInput(value: typeof EMPTY_SERVICE) {
    return {
      name: value.name.trim(),
      description: value.description.trim(),
      price: value.price.trim(),
      priceNote: value.priceNote.trim() || null,
      durationMinutes: value.durationMinutes ? Number(value.durationMinutes) : null,
      bookable: value.bookable
    };
  }

  return (
    <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
      {services && (
        <div data-testid="step-services">
          <p className="ops-note">
            Reception only mentions services listed here, at the price you write. Archived services disappear from
            Reception straight away but stay on past bookings.
          </p>

          {services.length === 0 ? (
            <p className="ops-empty" data-testid="services-empty">No services yet</p>
          ) : (
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Price</th>
                  <th>Duration</th>
                  <th>Status</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {services.map((service) =>
                  editing === service.id ? (
                    <ServiceEditRow
                      key={service.id}
                      service={service}
                      onCancel={() => setEditing(null)}
                      onSave={async (value) => {
                        await run(() => setup.updateService(businessId, service.id, toInput(value)));
                        setEditing(null);
                      }}
                    />
                  ) : (
                    <tr key={service.id} className={service.active ? "" : "ops-row-muted"}>
                      <td>
                        {service.name}
                        {service.description && <div className="ops-note">{service.description}</div>}
                      </td>
                      <td>
                        {service.price || "—"}
                        {service.priceNote && <span className="ops-note"> {service.priceNote}</span>}
                      </td>
                      <td>{service.durationMinutes ? `${service.durationMinutes} min` : "—"}</td>
                      <td>
                        {service.active ? (service.bookable ? "Active" : "Active · not bookable") : "Archived"}
                      </td>
                      {canEdit && (
                        <td className="ops-row-actions">
                          <button type="button" onClick={() => setEditing(service.id)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void run(() =>
                                service.active
                                  ? setup.archiveService(businessId, service.id)
                                  : setup.restoreService(businessId, service.id)
                              )
                            }
                          >
                            {service.active ? "Archive" : "Restore"}
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}

          {canEdit && (
            <form
              className="ops-form ops-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => setup.addService(businessId, toInput(draft))).then(() => setDraft(EMPTY_SERVICE));
              }}
            >
              <h3 className="ops-form-wide">Add a service</h3>
              {suggestions.length > 0 && (
                <div className="ops-suggestions ops-form-wide">
                  <span className="ops-note">Common for your industry:</span>
                  {suggestions.map((name) => (
                    <button key={name} type="button" className="ops-chip" onClick={() => setDraft({ ...draft, name })}>
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <label>
                Name
                <input aria-label="Service name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label>
                Price
                <input aria-label="Service price" placeholder="e.g. £55" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
              </label>
              <label>
                Price note
                <input placeholder="e.g. per session" value={draft.priceNote} onChange={(e) => setDraft({ ...draft, priceNote: e.target.value })} />
              </label>
              <label>
                Duration (minutes)
                <input
                  aria-label="Service duration"
                  type="number"
                  min={5}
                  value={draft.durationMinutes}
                  onChange={(e) => setDraft({ ...draft, durationMinutes: e.target.value })}
                />
              </label>
              <label className="ops-form-wide">
                Description
                <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
              <label className="ops-check">
                <input type="checkbox" checked={draft.bookable} onChange={(e) => setDraft({ ...draft, bookable: e.target.checked })} />
                Can be booked
              </label>
              <button type="submit" disabled={!draft.name.trim()}>
                Add service
              </button>
            </form>
          )}
          {error && <p className="ops-state ops-state-error" role="alert">{error}</p>}
        </div>
      )}
    </StateBlock>
  );
}

function ServiceEditRow({
  service,
  onSave,
  onCancel
}: {
  service: ConfigService;
  onSave: (value: typeof EMPTY_SERVICE) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState({
    name: service.name,
    description: service.description,
    price: service.price,
    priceNote: service.priceNote ?? "",
    durationMinutes: service.durationMinutes ? String(service.durationMinutes) : "",
    bookable: service.bookable
  });
  return (
    <tr>
      <td>
        <input aria-label="Edit service name" value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} />
        <input aria-label="Edit description" value={value.description} onChange={(e) => setValue({ ...value, description: e.target.value })} />
      </td>
      <td>
        <input aria-label="Edit price" value={value.price} onChange={(e) => setValue({ ...value, price: e.target.value })} />
        <input aria-label="Edit price note" value={value.priceNote} onChange={(e) => setValue({ ...value, priceNote: e.target.value })} />
      </td>
      <td>
        <input
          aria-label="Edit duration"
          type="number"
          min={5}
          value={value.durationMinutes}
          onChange={(e) => setValue({ ...value, durationMinutes: e.target.value })}
        />
      </td>
      <td>
        <label className="ops-check">
          <input type="checkbox" checked={value.bookable} onChange={(e) => setValue({ ...value, bookable: e.target.checked })} />
          Bookable
        </label>
      </td>
      <td className="ops-row-actions">
        <button type="button" onClick={() => void onSave(value)} disabled={!value.name.trim()}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </td>
    </tr>
  );
}

/* --------------------------- 3. FAQs / knowledge -------------------------- */

export function KnowledgeStep() {
  const { businessId, canEdit } = useStep();
  const state = useAsync(() => setup.faqs(businessId), [businessId]);
  const profile = useAsync(() => setup.profile(businessId), [businessId]);
  const [faqs, setFaqs] = useState<ConfigFaq[] | null>(null);
  const [draft, setDraft] = useState({ question: "", answer: "", category: "" });
  const [editing, setEditing] = useState<{ id: string; question: string; answer: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setFaqs(state.data?.faqs ?? null), [state.data]);

  const suggestions = profile.data ? INDUSTRY_TEMPLATES[profile.data.industry as Industry]?.suggestedQuestions ?? [] : [];

  async function run(action: () => Promise<{ faqs: ConfigFaq[] }>) {
    setError(null);
    try {
      setFaqs((await action()).faqs);
    } catch (err) {
      setError(message(err, "Could not save the FAQ"));
    }
  }

  function move(index: number, delta: number) {
    if (!faqs) return;
    const ids = faqs.map((faq) => faq.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    void run(() => setup.reorderFaqs(businessId, ids));
  }

  return (
    <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
      {faqs && (
        <div data-testid="step-knowledge">
          <p className="ops-note">Reception answers these questions using exactly the answers you write here.</p>

          {faqs.length === 0 ? (
            <p className="ops-empty" data-testid="faqs-empty">No FAQs yet</p>
          ) : (
            <ul className="ops-faq-list">
              {faqs.map((faq, index) => (
                <li key={faq.id} className={faq.active ? "" : "ops-row-muted"}>
                  {editing?.id === faq.id ? (
                    <div className="ops-form">
                      <input aria-label="Edit question" value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} />
                      <textarea aria-label="Edit answer" rows={3} value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} />
                      <div className="ops-actions">
                        <button
                          type="button"
                          onClick={() =>
                            void run(() =>
                              setup.updateFaq(businessId, faq.id, { question: editing.question, answer: editing.answer })
                            ).then(() => setEditing(null))
                          }
                        >
                          Save
                        </button>
                        <button type="button" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="ops-faq-q">
                        {faq.question}
                        {faq.category && <span className="ops-tag">{faq.category}</span>}
                        {!faq.active && <span className="ops-tag">Disabled</span>}
                      </div>
                      <div className="ops-note">{faq.answer}</div>
                      {canEdit && (
                        <div className="ops-row-actions">
                          <button type="button" onClick={() => setEditing({ id: faq.id, question: faq.question, answer: faq.answer })}>
                            Edit
                          </button>
                          <button type="button" onClick={() => void run(() => setup.setFaqActive(businessId, faq.id, !faq.active))}>
                            {faq.active ? "Disable" : "Enable"}
                          </button>
                          <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                            ↑
                          </button>
                          <button type="button" aria-label="Move down" disabled={index === faqs.length - 1} onClick={() => move(index, 1)}>
                            ↓
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canEdit && (
            <form
              className="ops-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  setup.addFaq(businessId, {
                    question: draft.question.trim(),
                    answer: draft.answer.trim(),
                    category: draft.category.trim() || null
                  })
                ).then(() => setDraft({ question: "", answer: "", category: "" }));
              }}
            >
              <h3>Add a question</h3>
              {suggestions.length > 0 && (
                <div className="ops-suggestions">
                  <span className="ops-note">Questions callers often ask — you write the answer:</span>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.question}
                      type="button"
                      className="ops-chip"
                      onClick={() => setDraft({ question: suggestion.question, answer: "", category: suggestion.category })}
                    >
                      {suggestion.question}
                    </button>
                  ))}
                </div>
              )}
              <label>
                Question
                <input aria-label="FAQ question" value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} />
              </label>
              <label>
                Answer
                <textarea aria-label="FAQ answer" rows={3} value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
              </label>
              <label>
                Category (optional)
                <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
              </label>
              <button type="submit" disabled={!draft.question.trim() || !draft.answer.trim()}>
                Add question
              </button>
            </form>
          )}
          {error && <p className="ops-state ops-state-error" role="alert">{error}</p>}
        </div>
      )}
    </StateBlock>
  );
}

/* ------------------------------ 4. Hours --------------------------------- */

export function HoursStep() {
  const { businessId, canEdit } = useStep();
  const state = useAsync(() => setup.hours(businessId), [businessId]);
  const [days, setDays] = useState<WorkingDay[] | null>(null);
  useEffect(() => setDays(state.data?.days ?? null), [state.data]);

  useRegisterSave(
    days && canEdit
      ? async () => {
          const saved = await setup.saveHours(businessId, days);
          setDays(saved.days);
        }
      : null,
    [days, canEdit]
  );

  const update = (dayOfWeek: number, change: (day: WorkingDay) => WorkingDay) =>
    setDays((current) => current?.map((day) => (day.dayOfWeek === dayOfWeek ? change(day) : day)) ?? null);

  return (
    <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
      {days && (
        <div data-testid="step-hours">
          <p className="ops-note">
            Times are in your business timezone, <strong>{state.data?.timezone}</strong>. Add a second period for split
            days, like a lunch break.
          </p>
          <table className="ops-table ops-hours">
            <tbody>
              {days.map((day) => (
                <tr key={day.dayOfWeek}>
                  <th scope="row">{DAY_NAMES[day.dayOfWeek]}</th>
                  <td>
                    <label className="ops-check">
                      <input
                        type="checkbox"
                        aria-label={`${DAY_NAMES[day.dayOfWeek]} open`}
                        disabled={!canEdit}
                        checked={day.periods.length > 0}
                        onChange={(e) =>
                          update(day.dayOfWeek, (current) => ({
                            ...current,
                            periods: e.target.checked ? [{ opens: "09:00", closes: "17:00" }] : []
                          }))
                        }
                      />
                      {day.periods.length > 0 ? "Open" : "Closed"}
                    </label>
                  </td>
                  <td>
                    {day.periods.map((period, index) => (
                      <span key={index} className="ops-period">
                        <input
                          type="time"
                          aria-label={`${DAY_NAMES[day.dayOfWeek]} period ${index + 1} opens`}
                          disabled={!canEdit}
                          value={period.opens}
                          onChange={(e) =>
                            update(day.dayOfWeek, (current) => ({
                              ...current,
                              periods: current.periods.map((p, i) => (i === index ? { ...p, opens: e.target.value } : p))
                            }))
                          }
                        />
                        –
                        <input
                          type="time"
                          aria-label={`${DAY_NAMES[day.dayOfWeek]} period ${index + 1} closes`}
                          disabled={!canEdit}
                          value={period.closes}
                          onChange={(e) =>
                            update(day.dayOfWeek, (current) => ({
                              ...current,
                              periods: current.periods.map((p, i) => (i === index ? { ...p, closes: e.target.value } : p))
                            }))
                          }
                        />
                        {canEdit && day.periods.length > 1 && (
                          <button
                            type="button"
                            aria-label="Remove period"
                            onClick={() =>
                              update(day.dayOfWeek, (current) => ({
                                ...current,
                                periods: current.periods.filter((_, i) => i !== index)
                              }))
                            }
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                    {canEdit && day.periods.length > 0 && day.periods.length < 4 && (
                      <button
                        type="button"
                        className="ops-linkish"
                        onClick={() =>
                          update(day.dayOfWeek, (current) => ({
                            ...current,
                            periods: [...current.periods, { opens: "14:00", closes: "17:00" }]
                          }))
                        }
                      >
                        + period
                      </button>
                    )}
                  </td>
                  <td>
                    {day.periods.length > 0 && (
                      <label className="ops-check">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={day.bookable}
                          onChange={(e) => update(day.dayOfWeek, (current) => ({ ...current, bookable: e.target.checked }))}
                        />
                        Take bookings
                      </label>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StateBlock>
  );
}

/* ------------------------------ 5. Booking ------------------------------- */

export function BookingStep() {
  const { businessId, canEdit } = useStep();
  const state = useAsync(() => setup.booking(businessId), [businessId]);
  const [form, setForm] = useState<BookingSettings | null>(null);
  useEffect(() => setForm(state.data), [state.data]);

  useRegisterSave(
    form && canEdit
      ? async () => {
          const saved = await setup.saveBooking(businessId, {
            bookingRequestsEnabled: form.bookingRequestsEnabled,
            minNoticeMinutes: form.minNoticeMinutes,
            maxHorizonDays: form.maxHorizonDays,
            slotIntervalMinutes: form.slotIntervalMinutes,
            bufferBeforeMinutes: form.bufferBeforeMinutes,
            bufferAfterMinutes: form.bufferAfterMinutes,
            // Only sent when the plan includes it; the server re-checks anyway.
            ...(form.calendarEntitled ? { calendarBookingEnabled: form.calendarBookingEnabled } : {})
          });
          setForm(saved);
        }
      : null,
    [form, canEdit]
  );

  const num = (key: keyof BookingSettings) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => (current ? { ...current, [key]: Number(event.target.value) } : current));

  return (
    <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
      {form && (
        <fieldset className="ops-form" disabled={!canEdit} data-testid="step-booking">
          <label className="ops-check ops-form-wide">
            <input
              type="checkbox"
              checked={form.bookingRequestsEnabled}
              onChange={(e) => setForm({ ...form, bookingRequestsEnabled: e.target.checked })}
            />
            Take booking requests for your team to confirm
          </label>
          <label>
            Minimum notice (minutes)
            <input type="number" min={0} value={form.minNoticeMinutes} onChange={num("minNoticeMinutes")} />
          </label>
          <label>
            Book up to (days ahead)
            <input type="number" min={1} max={365} value={form.maxHorizonDays} onChange={num("maxHorizonDays")} />
          </label>
          <label>
            Slot interval
            <select value={form.slotIntervalMinutes} onChange={num("slotIntervalMinutes")}>
              {[5, 10, 15, 20, 30, 60].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes
                </option>
              ))}
            </select>
          </label>
          <label>
            Buffer before (minutes)
            <input type="number" min={0} max={240} value={form.bufferBeforeMinutes} onChange={num("bufferBeforeMinutes")} />
          </label>
          <label>
            Buffer after (minutes)
            <input type="number" min={0} max={240} value={form.bufferAfterMinutes} onChange={num("bufferAfterMinutes")} />
          </label>
          <p className="ops-note ops-form-wide">Which days take bookings is set in Working hours.</p>

          <div className="ops-form-wide" data-testid="booking-calendar">
            {form.calendarEntitled ? (
              <label className="ops-check">
                <input
                  type="checkbox"
                  checked={form.calendarBookingEnabled}
                  onChange={(e) => setForm({ ...form, calendarBookingEnabled: e.target.checked })}
                />
                Book straight into a connected calendar (connect it in Business Settings)
              </label>
            ) : (
              <div className="ops-locked">
                <div className="ops-locked-title">
                  <span aria-hidden="true">🔒 </span>Live calendar booking
                </div>
                <p className="ops-note">
                  Your plan takes booking requests for your team to confirm. Live availability and automatic booking
                  are available on {form.calendarRequiredPlan ? PLAN_CATALOG[form.calendarRequiredPlan].name : "a higher plan"}.
                </p>
              </div>
            )}
          </div>
        </fieldset>
      )}
    </StateBlock>
  );
}

/* ----------------------------- 6. Escalation ----------------------------- */

export function EscalationStep() {
  const { businessId, canEdit } = useStep();
  const state = useAsync(() => setup.escalation(businessId), [businessId]);
  const profile = useAsync(() => setup.profile(businessId), [businessId]);
  const [form, setForm] = useState<EscalationSettings | null>(null);
  useEffect(() => setForm(state.data), [state.data]);

  useRegisterSave(
    form && canEdit
      ? async () => {
          const saved = await setup.saveEscalation(businessId, {
            humanEscalationEnabled: form.humanEscalationEnabled,
            escalationPhone: form.escalationPhone ?? "",
            escalationEmail: form.escalationEmail ?? "",
            fallbackMessage: form.fallbackMessage ?? ""
          } as Partial<EscalationSettings>);
          setForm(saved);
        }
      : null,
    [form, canEdit]
  );

  const hint = profile.data ? INDUSTRY_TEMPLATES[profile.data.industry as Industry]?.escalationHint : null;

  return (
    <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
      {form && (
        <fieldset className="ops-form" disabled={!canEdit} data-testid="step-escalation">
          {hint && <p className="ops-note ops-form-wide">{hint}</p>}
          <label className="ops-check ops-form-wide">
            <input
              type="checkbox"
              checked={form.humanEscalationEnabled}
              onChange={(e) => setForm({ ...form, humanEscalationEnabled: e.target.checked })}
            />
            Hand callers to your team when they ask for a person
          </label>
          <label>
            Team phone for handoffs
            <input type="tel" value={form.escalationPhone ?? ""} onChange={(e) => setForm({ ...form, escalationPhone: e.target.value })} />
          </label>
          <label>
            Team email for handoffs
            <input type="email" value={form.escalationEmail ?? ""} onChange={(e) => setForm({ ...form, escalationEmail: e.target.value })} />
          </label>
          <label className="ops-form-wide">
            Fallback message
            <textarea
              rows={2}
              maxLength={300}
              placeholder="What callers hear when Reception can't help or is paused."
              value={form.fallbackMessage ?? ""}
              onChange={(e) => setForm({ ...form, fallbackMessage: e.target.value })}
            />
          </label>
          <p className="ops-note ops-form-wide">
            Handoffs appear in your Escalations queue and notify your team in Veyra Console. Reception doesn't send
            texts or WhatsApp messages.
          </p>
        </fieldset>
      )}
    </StateBlock>
  );
}

/* -------------------------------- 7. Team -------------------------------- */

export function TeamStep() {
  const { businessId, canEdit } = useStep();
  const members = useAsync(() => listMembers(businessId), [businessId]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"ADMIN" | "OPERATOR" | "VIEWER">("OPERATOR");
  const [error, setError] = useState<string | null>(null);

  return (
    <StateBlock loading={members.loading} error={members.error} onRetry={members.reload}>
      <div data-testid="step-team">
        <ul className="ops-feature-list">
          {members.data?.map((member) => (
            <li key={member.membershipId}>
              {member.name} <span className="ops-tag">{member.role}</span>
            </li>
          ))}
        </ul>
        {canEdit && (
          <form
            className="ops-actions"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              addMember(businessId, email.trim(), role)
                .then(() => {
                  setEmail("");
                  members.reload();
                })
                .catch((err) =>
                  setError(
                    err instanceof ApiError && err.code === "PLAN_LIMIT_REACHED" && err.requiredPlan
                      ? `${err.message} ${PLAN_CATALOG[err.requiredPlan].name} allows more.`
                      : message(err, "Could not add that person")
                  )
                );
            }}
          >
            <input type="email" aria-label="Team member email" placeholder="colleague@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select aria-label="Team member role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="ADMIN">Admin</option>
              <option value="OPERATOR">Operator</option>
              <option value="VIEWER">Viewer</option>
            </select>
            <button type="submit" disabled={!email.trim()}>
              Add
            </button>
          </form>
        )}
        <p className="ops-note">
          Invitation emails aren't available yet: the person needs to create a Veyra account first, then you can add them
          here. Your plan's team size is shown under Business Settings → Plan &amp; usage.
        </p>
        {error && <p className="ops-state ops-state-error" role="alert">{error}</p>}
      </div>
    </StateBlock>
  );
}

/* ---------------------------- 8. Integrations ---------------------------- */

export function IntegrationsStep() {
  const { businessId } = useStep();
  const calendar = useAsync(() => getCalendarSettings(businessId), [businessId]);

  return (
    <StateBlock loading={calendar.loading} error={calendar.error} onRetry={calendar.reload}>
      {calendar.data && (
        <ul className="ops-integrations" data-testid="step-integrations">
          <li>
            <strong>Google Calendar</strong>
            <span className="ops-note">
              {!calendar.data.entitled
                ? ` Available on ${calendar.data.requiredPlan ? PLAN_CATALOG[calendar.data.requiredPlan].name : "a higher plan"}. Not needed to go live — booking requests work on every plan.`
                : calendar.data.live
                  ? " Connected and live."
                  : " Included in your plan. Connect it in Business Settings → Calendar whenever you're ready."}
            </span>
            {calendar.data.entitled && !calendar.data.live && (
              <Link to={`/dashboard/${businessId}/settings`}> Open calendar settings</Link>
            )}
          </li>
          <li>
            <strong>Voice reception</strong>
            <span className="ops-note"> Coming soon (Max). Nothing to set up yet.</span>
          </li>
          <li>
            <strong>WhatsApp and SMS</strong>
            <span className="ops-note"> Not available yet.</span>
          </li>
        </ul>
      )}
    </StateBlock>
  );
}

/* ------------------------------- 9. Review ------------------------------- */

export function ReviewStep() {
  const { businessId, canEdit } = useStep();
  const knowledge = useAsync(() => setup.knowledge(businessId), [businessId]);
  const reception = useAsync(() => setup.reception(businessId), [businessId]);
  const [form, setForm] = useState<ReceptionSettings | null>(null);
  useEffect(() => setForm(reception.data), [reception.data]);

  useRegisterSave(
    form && canEdit
      ? async () => {
          const saved = await setup.saveReception(businessId, {
            assistantName: form.assistantName?.trim() ? form.assistantName.trim() : null,
            greeting: form.greeting,
            tone: form.tone,
            closingStyle: form.closingStyle
          });
          setForm(saved);
        }
      : null,
    [form, canEdit]
  );

  const k = knowledge.data;

  return (
    <div data-testid="step-review">
      <h3>How Reception sounds</h3>
      <StateBlock loading={reception.loading} error={reception.error} onRetry={reception.reload}>
        {form && (
          <fieldset className="ops-form" disabled={!canEdit}>
            <label>
              Assistant name (optional)
              <input maxLength={40} value={form.assistantName ?? ""} onChange={(e) => setForm({ ...form, assistantName: e.target.value })} />
            </label>
            <label>
              Tone
              <select value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value as ReceptionSettings["tone"] })}>
                {RECEPTION_TONES.map((tone) => (
                  <option key={tone.key} value={tone.key}>
                    {tone.label} — {tone.description}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Closing line
              <select
                value={form.closingStyle}
                onChange={(e) => setForm({ ...form, closingStyle: e.target.value as ReceptionSettings["closingStyle"] })}
              >
                {CLOSING_STYLES.map((style) => (
                  <option key={style.key} value={style.key}>
                    {style.label}
                    {style.example ? ` — “${style.example}”` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="ops-form-wide">
              Greeting
              <input maxLength={240} value={form.greeting} onChange={(e) => setForm({ ...form, greeting: e.target.value })} />
            </label>
          </fieldset>
        )}
      </StateBlock>

      <h3>What Reception knows</h3>
      <StateBlock loading={knowledge.loading} error={knowledge.error} onRetry={knowledge.reload}>
        {k && (
          <dl className="ops-detail" data-testid="knowledge-preview">
            <dt>Business</dt>
            <dd>
              {k.business.name} · {k.business.timezone}
              {k.business.address && ` · ${k.business.address}`}
            </dd>
            <dt>Contact</dt>
            <dd>{[k.business.phone, k.business.email, k.business.website].filter(Boolean).join(" · ") || "—"}</dd>
            <dt>Hours</dt>
            <dd>{k.hoursSummary || "Not set"}</dd>
            <dt>Services</dt>
            <dd>
              {k.services.length === 0
                ? "No services yet"
                : k.services.map((s) => `${s.name}${s.price ? ` (${s.price}${s.priceNote ? ` ${s.priceNote}` : ""})` : ""}`).join(", ")}
            </dd>
            <dt>FAQs</dt>
            <dd>{k.faqs.length === 0 ? "No FAQs yet" : `${k.faqs.length} answered`}</dd>
            <dt>Booking</dt>
            <dd>
              {k.booking.liveCalendar
                ? "Live calendar booking"
                : k.booking.requestsEnabled
                  ? "Booking requests for your team to confirm"
                  : "Off"}
            </dd>
            <dt>Handoff</dt>
            <dd>
              {k.escalation.enabled
                ? `To your team${k.escalation.phone ? ` · ${k.escalation.phone}` : ""}${k.escalation.email ? ` · ${k.escalation.email}` : ""}`
                : "Off"}
            </dd>
            {k.planRestrictions.length > 0 && (
              <>
                <dt>Plan</dt>
                <dd>{k.planRestrictions.join(" ")}</dd>
              </>
            )}
          </dl>
        )}
      </StateBlock>
    </div>
  );
}

/* ------------------------------ 10. Go live ------------------------------ */

export function GoLiveStep() {
  const { businessId, canEdit } = useStep();
  const readiness = useAsync(() => setup.readiness(businessId), [businessId]);
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setReport(readiness.data), [readiness.data]);

  async function change(action: "activate" | "pause") {
    setBusy(true);
    setError(null);
    try {
      await (action === "activate" ? setup.activate(businessId) : setup.pause(businessId));
      setReport(await setup.readiness(businessId));
    } catch (err) {
      setError(message(err, "Could not change Reception's status"));
    } finally {
      setBusy(false);
    }
  }

  const STATUS_TEXT = { draft: "Not live yet", active: "Live", paused: "Paused" } as const;

  return (
    <StateBlock loading={readiness.loading} error={readiness.error} onRetry={readiness.reload}>
      {report && (
        <div data-testid="step-go-live">
          <p>
            Reception is{" "}
            <span
              className={`ops-pill ops-pill-${report.status === "active" ? "enabled" : report.status === "paused" ? "warning" : "disabled"}`}
              data-testid="reception-status"
            >
              {STATUS_TEXT[report.status]}
            </span>
          </p>
          <ul className="ops-readiness" data-testid="readiness-checks">
            {report.checks.map((check) => (
              <li key={check.key} className={`ops-readiness-${check.level}`}>
                <span aria-hidden="true">{check.level === "ready" ? "✓" : check.level === "warning" ? "!" : "✕"} </span>
                {check.message}
              </li>
            ))}
          </ul>

          {canEdit && (
            <div className="ops-actions">
              {report.status !== "active" && (
                <button
                  type="button"
                  className="ops-primary"
                  disabled={!report.canActivate || busy}
                  onClick={() => void change("activate")}
                >
                  {report.status === "paused" ? "Resume Reception" : "Go live"}
                </button>
              )}
              {report.status === "active" && (
                <button type="button" disabled={busy} onClick={() => void change("pause")}>
                  Pause Reception
                </button>
              )}
            </div>
          )}
          {!report.canActivate && (
            <p className="ops-note" data-testid="golive-blocked">Fix the items marked ✕ to go live.</p>
          )}
          {report.status === "paused" && (
            <p className="ops-note">While paused, callers are given your contact details instead of the assistant.</p>
          )}
          {error && <p className="ops-state ops-state-error" role="alert">{error}</p>}
        </div>
      )}
    </StateBlock>
  );
}
