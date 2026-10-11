import { useState } from "react";
import { Link } from "react-router-dom";
import {
  AFTER_HOURS_BEHAVIORS,
  AFTER_HOURS_LABELS,
  PLAN_CATALOG,
  VOICE_PROFILES,
  VOICE_ROLLOUT_NOTE,
  type AfterHoursBehavior,
  type VoiceProfileName,
  type VoiceSettingsDto
} from "@veyra/shared";
import { getVoiceOverview, updateVoiceSettings } from "../opsClient";
import { StateBlock } from "../components";
import { useAsync } from "../useAsync";

/**
 * Voice in Veyra Console.
 *
 * Voice needs four things to be true at once — the Max plan, a configured
 * provider that is healthy, the business's own switch, and a number to answer
 * on. The server decides; this page shows exactly which one is missing rather
 * than implying the phone is ringing.
 *
 * No phone number is ever invented here: a business with nothing configured
 * sees an empty field, not a placeholder that looks real.
 */
export function VoiceSettings({ businessId }: { businessId: string }) {
  const state = useAsync(() => getVoiceOverview(businessId), [businessId]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<VoiceSettingsDto> | null>(null);

  const data = state.data;
  const settings = data?.settings;
  const draft: Partial<VoiceSettingsDto> = { ...(settings ?? {}), ...(form ?? {}) };

  async function save(patch: Partial<VoiceSettingsDto>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await updateVoiceSettings(businessId, patch);
      setForm(null);
      setNotice(message);
      state.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-panel" data-testid="voice-settings" id="voice">
      <h2>Voice</h2>

      <StateBlock loading={state.loading && !data} error={state.error} onRetry={state.reload}>
        {data && (
          <>
            {!data.entitled ? (
              // Locked: shown as a feature of a higher plan, never hidden.
              <div className="ops-locked" data-testid="voice-locked">
                <div className="ops-locked-title">
                  <span aria-hidden="true">🔒 </span>Veyra answers the phone
                </div>
                <p className="ops-note">
                  Voice reception, inbound and outbound calls and call history are part of{" "}
                  {data.requiredPlan ? PLAN_CATALOG[data.requiredPlan].name : "a higher plan"} — Speak.
                </p>
                <p className="ops-note" data-testid="voice-rollout-note">
                  {VOICE_ROLLOUT_NOTE}: a phone number and a telephony provider have to be connected before Veyra can
                  take calls.
                </p>
              </div>
            ) : (
              <>
                <div className="ops-plan-head">
                  <div>
                    <div className="ops-plan-name" data-testid="voice-status">
                      {data.live ? "Voice is live" : "Voice is not live"}
                    </div>
                    {data.blockedReason && (
                      <p className="ops-note" data-testid="voice-blocked-reason">
                        {data.blockedReason}
                      </p>
                    )}
                  </div>
                  <span className={`ops-pill ops-pill-${data.live ? "enabled" : "warning"}`}>
                    {data.live ? "Live" : "Not live"}
                  </span>
                </div>

                {data.provider.simulated && (
                  <p className="ops-note" data-testid="voice-simulated">
                    Development voice provider — no real calls are placed or received on this server.
                  </p>
                )}

                <dl className="ops-detail">
                  <dt>Provider</dt>
                  <dd data-testid="voice-provider">
                    {data.provider.name ?? "None configured"}
                    <span className="ops-note"> · {data.provider.detail}</span>
                  </dd>
                  <dt>Speech</dt>
                  <dd data-testid="voice-speech">
                    Recognition: {data.speech.stt.name ?? "none"}
                    {data.speech.stt.simulated ? " (development)" : ""} · Synthesis: {data.speech.tts.name ?? "none"}
                    {data.speech.tts.simulated ? " (development)" : ""}
                    <span className="ops-note">
                      {" "}
                      {data.speech.stt.detail} {data.speech.tts.detail}
                    </span>
                  </dd>
                  <dt>Minutes this period</dt>
                  <dd data-testid="voice-usage">
                    {data.usage.minutesThisPeriod}
                    {data.usage.limit === null ? " (unlimited)" : ` of ${data.usage.limit}`}
                    <span className="ops-note"> · {data.usage.calls} calls recorded</span>
                  </dd>
                </dl>

                <div className="ops-actions">
                  <button
                    type="button"
                    disabled={busy || !data.canManage}
                    data-testid="voice-toggle"
                    onClick={() =>
                      save({ enabled: !settings?.enabled }, settings?.enabled ? "Voice switched off." : "Voice switched on.")
                    }
                  >
                    {settings?.enabled ? "Switch voice off" : "Switch voice on"}
                  </button>
                  <Link to={`/dashboard/${businessId}/calls`} className="ops-linkish" data-testid="voice-calls-link">
                    Call history
                  </Link>
                </div>

                {data.canManage ? (
                  <>
                    <h3>Configuration</h3>
                    <div className="ops-actions">
                      <label>
                        Phone number callers dial
                        <input
                          type="tel"
                          value={draft.businessPhoneNumber ?? ""}
                          placeholder="Not set"
                          data-testid="voice-number"
                          onChange={(event) => setForm({ ...form, businessPhoneNumber: event.target.value })}
                        />
                      </label>
                      <label>
                        Transfer calls to
                        <input
                          type="tel"
                          value={draft.handoffNumber ?? ""}
                          placeholder="Not set"
                          data-testid="voice-handoff-number"
                          onChange={(event) => setForm({ ...form, handoffNumber: event.target.value })}
                        />
                      </label>
                      <label>
                        Spoken greeting
                        <input
                          type="text"
                          value={draft.greeting ?? ""}
                          placeholder="Uses your written greeting"
                          data-testid="voice-greeting"
                          onChange={(event) => setForm({ ...form, greeting: event.target.value })}
                        />
                      </label>
                      <label>
                        Language
                        <input
                          type="text"
                          value={draft.language ?? "en-US"}
                          data-testid="voice-language"
                          onChange={(event) => setForm({ ...form, language: event.target.value })}
                        />
                      </label>
                      <label>
                        Voice
                        <select
                          value={draft.voiceProfile ?? "neutral"}
                          data-testid="voice-profile"
                          onChange={(event) => setForm({ ...form, voiceProfile: event.target.value as VoiceProfileName })}
                        >
                          {VOICE_PROFILES.map((profile) => (
                            <option key={profile} value={profile}>
                              {profile}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Outside opening hours
                        <select
                          value={draft.afterHoursBehavior ?? "continue"}
                          data-testid="voice-after-hours"
                          onChange={(event) =>
                            setForm({ ...form, afterHoursBehavior: event.target.value as AfterHoursBehavior })
                          }
                        >
                          {AFTER_HOURS_BEHAVIORS.map((behavior) => (
                            <option key={behavior} value={behavior}>
                              {AFTER_HOURS_LABELS[behavior]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Keep what was said
                        <select
                          value={draft.transcriptPolicy ?? "store"}
                          data-testid="voice-transcript-policy"
                          onChange={(event) =>
                            setForm({ ...form, transcriptPolicy: event.target.value as "store" | "metadata_only" })
                          }
                        >
                          <option value="store">Store transcripts</option>
                          <option value="metadata_only">Metadata only</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={busy || form === null}
                        data-testid="voice-save"
                        onClick={() => save(form ?? {}, "Voice settings saved.")}
                      >
                        Save
                      </button>
                    </div>
                    <p className="ops-note">
                      Call recording is <strong>off</strong> and is not enabled from here: recording callers has legal
                      obligations that have to be settled first.
                    </p>
                  </>
                ) : (
                  <p className="ops-note">Only an owner or admin can change voice settings.</p>
                )}
              </>
            )}

            {notice && (
              <p className="ops-banner ops-banner-success" role="status" data-testid="voice-notice">
                {notice}
              </p>
            )}
            {error && (
              <p className="ops-banner" role="alert" data-testid="voice-error">
                {error}
              </p>
            )}
          </>
        )}
      </StateBlock>
    </section>
  );
}
