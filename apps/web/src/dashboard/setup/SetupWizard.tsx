import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ONBOARDING_STEPS, type OnboardingStep, isOnboardingStep } from "@veyra/shared";
import { useAuth } from "../AuthContext";
import { setup } from "../opsClient";
import { StateBlock } from "../components";
import { useAsync } from "../useAsync";
import {
  BookingStep,
  BusinessDetailsStep,
  EscalationStep,
  GoLiveStep,
  HoursStep,
  IntegrationsStep,
  KnowledgeStep,
  ReviewStep,
  ServicesStep,
  TeamStep
} from "./steps";

/**
 * The onboarding wizard, and the place to edit setup afterwards.
 *
 * Progress lives on the server: "Save & continue" saves the step's data, then
 * asks the server to mark the step complete — which it only does once the data
 * is really there. Leaving and coming back resumes at the next unfinished step.
 */

type Saver = () => Promise<void>;

interface StepContextValue {
  businessId: string;
  canEdit: boolean;
  /** A form step registers how to save itself before "Save & continue". */
  registerSave: (save: Saver | null) => void;
}

const StepContext = createContext<StepContextValue | null>(null);

export function useStep(): StepContextValue {
  const value = useContext(StepContext);
  if (!value) throw new Error("useStep outside SetupWizard");
  return value;
}

const STEP_COMPONENTS: Record<OnboardingStep, () => JSX.Element> = {
  business_details: BusinessDetailsStep,
  services: ServicesStep,
  knowledge: KnowledgeStep,
  hours: HoursStep,
  booking: BookingStep,
  escalation: EscalationStep,
  team: TeamStep,
  integrations: IntegrationsStep,
  review: ReviewStep,
  go_live: GoLiveStep
};

export function SetupWizard() {
  const { businessId = "", step } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const canEdit = can(businessId, "settings:write");
  const onboarding = useAsync(() => setup.onboarding(businessId), [businessId]);

  const saveRef = useRef<Saver | null>(null);
  const registerSave = useCallback((save: Saver | null) => {
    saveRef.current = save;
  }, []);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current: OnboardingStep =
    step && isOnboardingStep(step) ? step : (onboarding.data?.nextStep ?? "business_details");
  const index = ONBOARDING_STEPS.findIndex((candidate) => candidate.key === current);
  const definition = ONBOARDING_STEPS[index];
  const next = ONBOARDING_STEPS[index + 1]?.key;
  const previous = ONBOARDING_STEPS[index - 1]?.key;
  const go = (target: OnboardingStep | undefined) => {
    setError(null);
    saveRef.current = null;
    if (target) navigate(`/dashboard/${businessId}/setup/${target}`);
  };

  async function advance(action: "complete" | "skip") {
    setBusy(true);
    setError(null);
    try {
      if (action === "complete") await saveRef.current?.();
      await setup.recordStep(businessId, current, action);
      onboarding.reload();
      go(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this step");
    } finally {
      setBusy(false);
    }
  }

  const Step = STEP_COMPONENTS[current];
  const statusOf = (key: OnboardingStep) => onboarding.data?.steps.find((candidate) => candidate.key === key)?.status;

  return (
    <section className="ops-setup">
      <header className="ops-page-head">
        <h1>Set up Reception</h1>
        {onboarding.data?.completedAt && <span className="ops-pill ops-pill-enabled">Setup complete</span>}
      </header>

      <StateBlock loading={onboarding.loading} error={onboarding.error} onRetry={onboarding.reload}>
        <ol className="ops-steps" data-testid="setup-progress">
          {ONBOARDING_STEPS.map((candidate, position) => (
            <li
              key={candidate.key}
              className={`ops-step ops-step-${statusOf(candidate.key) ?? "pending"}${candidate.key === current ? " ops-step-current" : ""}`}
            >
              <Link to={`/dashboard/${businessId}/setup/${candidate.key}`} aria-current={candidate.key === current ? "step" : undefined}>
                <span className="ops-step-number">{statusOf(candidate.key) === "complete" ? "✓" : position + 1}</span>
                <span className="ops-step-label">{candidate.label}</span>
                {statusOf(candidate.key) === "skipped" && <span className="ops-note"> · skipped</span>}
              </Link>
            </li>
          ))}
        </ol>

        <div className="ops-panel ops-step-panel">
          <h2 data-testid="setup-step-title">{definition.label}</h2>
          {!canEdit && (
            <p className="ops-note" data-testid="setup-readonly">
              You can review setup, but only an owner or admin can change it.
            </p>
          )}

          <StepContext.Provider value={{ businessId, canEdit, registerSave }}>
            <Step key={current} />
          </StepContext.Provider>

          {error && (
            <p className="ops-state ops-state-error" role="alert" data-testid="setup-error">
              {error}
            </p>
          )}

          <div className="ops-actions ops-step-actions">
            <button type="button" onClick={() => go(previous)} disabled={!previous || busy}>
              Back
            </button>
            {canEdit && !definition.required && current !== "go_live" && (
              <button type="button" onClick={() => void advance("skip")} disabled={busy}>
                Skip for now
              </button>
            )}
            {current !== "go_live" &&
              (canEdit ? (
                <button type="button" className="ops-primary" onClick={() => void advance("complete")} disabled={busy}>
                  {busy ? "Saving…" : "Save & continue"}
                </button>
              ) : (
                <button type="button" onClick={() => go(next)} disabled={!next}>
                  Next
                </button>
              ))}
          </div>
          <p className="ops-note">Everything is saved as you go — you can leave and pick up where you left off.</p>
        </div>
      </StateBlock>
    </section>
  );
}
