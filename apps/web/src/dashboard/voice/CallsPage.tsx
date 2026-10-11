import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CALL_STATUS_LABELS, type CallSummary } from "@veyra/shared";
import { getCall, getVoiceOverview, listCalls, simulateCall, simulateCallerSpeech, simulateHangup } from "../opsClient";
import { StateBlock, formatDateTime } from "../components";
import { useAsync } from "../useAsync";
import { useAuth } from "../AuthContext";

/**
 * Call history.
 *
 * A call is a conversation that happened out loud, so every row links to the
 * ordinary Veyra records it produced — the conversation, the booking, the
 * escalation. Caller numbers are partly masked; audio is never offered,
 * because recording is off.
 */

const OUTCOME_LABELS: Record<CallSummary["outcome"], string> = {
  booking: "Booking",
  handoff: "Handed to a person",
  answered: "Answered",
  missed: "Not answered",
  failed: "Failed",
  no_outcome: "No outcome"
};

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function CallsPage() {
  const { businessId = "" } = useParams();
  const { can } = useAuth();
  const state = useAsync(() => listCalls(businessId), [businessId]);
  const voice = useAsync(() => getVoiceOverview(businessId), [businessId]);

  return (
    <section data-testid="calls-page">
      <header className="ops-page-head">
        <h1>Calls</h1>
      </header>

      {voice.data && !voice.data.entitled && (
        <p className="ops-note" data-testid="calls-locked">
          Veyra answers the phone on Max. This business's plan doesn't include voice, so there are no calls to show.
        </p>
      )}

      {voice.data?.entitled && voice.data.provider.simulated && can(businessId, "operations:write") && (
        <CallSimulator businessId={businessId} onChanged={state.reload} />
      )}

      <StateBlock
        loading={state.loading}
        error={state.error}
        empty={(state.data?.length ?? 0) === 0}
        emptyMessage="No calls yet."
        onRetry={state.reload}
      >
        {state.data && state.data.length > 0 && (
          <table className="ops-table" data-testid="calls-table">
            <thead>
              <tr>
                <th>Caller</th>
                <th>Direction</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Status</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {state.data.map((call) => (
                <tr key={call.id} data-testid={`call-${call.id}`}>
                  <td>
                    <Link to={`/dashboard/${businessId}/calls/${call.id}`}>{call.callerNumber ?? "Unknown"}</Link>
                  </td>
                  <td>{call.direction}</td>
                  <td>{formatDateTime(call.startedAt)}</td>
                  <td>{duration(call.durationSeconds)}</td>
                  <td>
                    <span className={`ops-pill ops-pill-${call.status === "completed" ? "enabled" : call.status === "failed" || call.status === "missed" ? "disabled" : "warning"}`}>
                      {CALL_STATUS_LABELS[call.status]}
                    </span>
                  </td>
                  <td>{OUTCOME_LABELS[call.outcome]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </StateBlock>
    </section>
  );
}

/**
 * The development call simulator: type what a caller would say and see what
 * Veyra says back. It drives the same voice pipeline as a real carrier — the
 * same webhook route, the same Reception turn — so a demo cannot show
 * behaviour the phone line would not.
 */
function CallSimulator({ businessId, onChanged }: { businessId: string; onChanged: () => void }) {
  const [callId, setCallId] = useState<string | null>(null);
  const [lines, setLines] = useState<{ speaker: "caller" | "veyra"; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-panel" data-testid="call-simulator">
      <h2>Simulate a call</h2>
      <p className="ops-note">
        Development provider only. No number is dialled — this puts a made-up caller through the real voice pipeline.
      </p>

      {error && (
        <p className="ops-banner" role="alert" data-testid="simulator-error">
          {error}
        </p>
      )}

      {!callId ? (
        <button
          type="button"
          disabled={busy}
          data-testid="simulate-start"
          onClick={() =>
            run(async () => {
              const started = await simulateCall(businessId);
              setCallId(started.externalCallId);
              setLines(started.spoken.map((text) => ({ speaker: "veyra" as const, text })));
            })
          }
        >
          Start a call
        </button>
      ) : (
        <>
          <ol className="ops-transcript" data-testid="simulator-transcript">
            {lines.map((line, index) => (
              <li key={index} className={`ops-turn ops-turn-${line.speaker === "caller" ? "caller" : "receptionist"}`}>
                <div className="ops-turn-meta">
                  <strong>{line.speaker === "caller" ? "Caller" : "Veyra"}</strong>
                </div>
                <p>{line.text}</p>
              </li>
            ))}
          </ol>
          <div className="ops-actions">
            <input
              type="text"
              value={draft}
              placeholder="What the caller says…"
              aria-label="What the caller says"
              data-testid="simulate-input"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || !draft.trim()}
              data-testid="simulate-say"
              onClick={() =>
                run(async () => {
                  const said = draft.trim();
                  setDraft("");
                  setLines((current) => [...current, { speaker: "caller", text: said }]);
                  const result = await simulateCallerSpeech(businessId, callId, said);
                  setLines((current) => [...current, ...result.spoken.map((text) => ({ speaker: "veyra" as const, text }))]);
                })
              }
            >
              Say it
            </button>
            <button
              type="button"
              disabled={busy}
              data-testid="simulate-hangup"
              onClick={() =>
                run(async () => {
                  await simulateHangup(businessId, callId);
                  setCallId(null);
                  setLines([]);
                })
              }
            >
              Hang up
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** One call: what was said, what it produced, and how quickly Veyra answered. */
export function CallDetailPage() {
  const { businessId = "", callId = "" } = useParams();
  const state = useAsync(() => getCall(businessId, callId), [businessId, callId]);

  return (
    <section data-testid="call-detail">
      <header className="ops-page-head">
        <h1>Call</h1>
        <Link to={`/dashboard/${businessId}/calls`}>← All calls</Link>
      </header>

      <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
        {state.data && (
          <>
            <dl className="ops-detail">
              <dt>Caller</dt>
              <dd>{state.data.callerNumber ?? "Unknown"}</dd>
              <dt>Direction</dt>
              <dd>{state.data.direction}</dd>
              <dt>Started</dt>
              <dd>{formatDateTime(state.data.startedAt)}</dd>
              <dt>Duration</dt>
              <dd data-testid="call-duration">{duration(state.data.durationSeconds)}</dd>
              <dt>Status</dt>
              <dd>{CALL_STATUS_LABELS[state.data.status]}</dd>
              <dt>Outcome</dt>
              <dd data-testid="call-outcome">{OUTCOME_LABELS[state.data.outcome]}</dd>
              {state.data.hangupReason && (
                <>
                  <dt>Ended because</dt>
                  <dd>{state.data.hangupReason}</dd>
                </>
              )}
            </dl>

            <div className="ops-actions" data-testid="call-links">
              {state.data.conversationId && (
                <Link to={`/dashboard/${businessId}/conversations/${state.data.conversationId}`} data-testid="call-conversation-link">
                  Open the conversation
                </Link>
              )}
              {state.data.bookingId && (
                <Link to={`/dashboard/${businessId}/bookings/${state.data.bookingId}`} data-testid="call-booking-link">
                  Booking from this call
                </Link>
              )}
              {state.data.escalationId && (
                <Link to={`/dashboard/${businessId}/escalations/${state.data.escalationId}`} data-testid="call-escalation-link">
                  Handoff from this call
                </Link>
              )}
            </div>

            <h2>What was said</h2>
            {!state.data.transcriptStored ? (
              <p className="ops-note" data-testid="call-transcript-withheld">
                This business keeps call metadata only, so what was said is not stored.
              </p>
            ) : state.data.turns.length === 0 ? (
              <p className="ops-note">Nothing was said on this call.</p>
            ) : (
              <ol className="ops-transcript" data-testid="call-transcript">
                {state.data.turns.map((turn, index) => (
                  <li key={index} className={`ops-turn ops-turn-${turn.speaker === "caller" ? "caller" : "receptionist"}`}>
                    <div className="ops-turn-meta">
                      <strong>{turn.speaker === "caller" ? "Caller" : "Veyra"}</strong>
                      <span>{formatDateTime(turn.at)}</span>
                      {turn.intent && <span className="ops-tag">{turn.intent}</span>}
                      {turn.action && turn.action !== "none" && <span className="ops-tag">{turn.action}</span>}
                      {turn.interrupted && <span className="ops-tag">interrupted</span>}
                      {turn.latency?.totalMs != null && (
                        <span className="ops-note">{Math.round(turn.latency.totalMs)}ms</span>
                      )}
                    </div>
                    <p>{turn.text}</p>
                  </li>
                ))}
              </ol>
            )}

            <h2>Responsiveness</h2>
            <p className="ops-note" data-testid="call-latency">
              {state.data.latencySummary.turns === 0
                ? "No measured turns on this call."
                : `${state.data.latencySummary.turns} turns · median ${state.data.latencySummary.medianTotalMs}ms · p95 ${state.data.latencySummary.p95TotalMs}ms, measured inside Veyra from transcript to spoken reply.`}
            </p>
            {!state.data.recordingEnabled && (
              <p className="ops-note" data-testid="call-no-recording">
                Call recording is off for this business, so there is no audio to play.
              </p>
            )}
          </>
        )}
      </StateBlock>
    </section>
  );
}
