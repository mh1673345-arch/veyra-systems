import { ONBOARDING_STEPS, type OnboardingState, type OnboardingStep } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { evaluateReadiness } from "./readiness.js";

/**
 * Onboarding progress, recorded by the server.
 *
 * A step is only marked complete after the server checks that its data is
 * actually there — the client can't declare a step done. Optional steps can be
 * skipped; required ones can't. "go_live" is completed by activation itself,
 * never by this endpoint.
 */

export async function getOnboardingState(businessId: string): Promise<OnboardingState> {
  const progress = await prisma.onboardingProgress.findUnique({ where: { businessId } });
  const completed = new Set(progress?.completedSteps ?? []);
  const skipped = new Set(progress?.skippedSteps ?? []);

  const steps = ONBOARDING_STEPS.map((step) => ({
    key: step.key,
    label: step.label,
    required: step.required,
    status: completed.has(step.key)
      ? ("complete" as const)
      : skipped.has(step.key)
        ? ("skipped" as const)
        : ("pending" as const)
  }));

  return {
    businessId,
    steps,
    nextStep: steps.find((step) => step.status === "pending")?.key ?? null,
    completedAt: progress?.completedAt?.toISOString() ?? null
  };
}

/** Why a step can't be completed yet, or null if it can. */
async function incompleteReason(businessId: string, step: OnboardingStep): Promise<string | null> {
  switch (step) {
    case "business_details": {
      const readiness = await evaluateReadiness(businessId);
      const blocking = readiness.checks.find(
        (check) => (check.key === "business_profile" || check.key === "contact_method") && check.level === "blocking"
      );
      return blocking ? blocking.message : null;
    }
    case "services":
      return (await prisma.service.count({ where: { businessId, active: true } })) > 0
        ? null
        : "Add at least one service, or skip this step.";
    case "knowledge":
      return (await prisma.faq.count({ where: { businessId, active: true } })) > 0
        ? null
        : "Add at least one FAQ, or skip this step.";
    case "hours":
      return (await prisma.businessHour.count({ where: { businessId } })) > 0
        ? null
        : "Set your opening hours, or skip this step.";
    case "go_live":
      return "Go live by activating Reception.";
    default:
      // Booking, escalation, team, integrations and review have safe defaults:
      // confirming them is enough.
      return null;
  }
}

export async function recordStep(
  businessId: string,
  step: OnboardingStep,
  action: "complete" | "skip"
): Promise<OnboardingState> {
  const definition = ONBOARDING_STEPS.find((candidate) => candidate.key === step)!;

  if (action === "skip") {
    if (definition.required) throw new HttpError(400, `"${definition.label}" can't be skipped.`);
  } else {
    const reason = await incompleteReason(businessId, step);
    if (reason) throw new HttpError(422, reason);
  }

  await markStep(businessId, step, action);
  return getOnboardingState(businessId);
}

/** Internal: records a step without the completion checks (used by activation). */
export async function markStep(businessId: string, step: OnboardingStep, action: "complete" | "skip"): Promise<void> {
  const progress = await prisma.onboardingProgress.upsert({
    where: { businessId },
    create: { businessId },
    update: {}
  });
  const completed = new Set(progress.completedSteps);
  const skipped = new Set(progress.skippedSteps);
  if (action === "complete") {
    completed.add(step);
    skipped.delete(step);
  } else {
    skipped.add(step);
    completed.delete(step);
  }

  const allDone = ONBOARDING_STEPS.every((candidate) => completed.has(candidate.key) || skipped.has(candidate.key));
  await prisma.onboardingProgress.update({
    where: { businessId },
    data: {
      completedSteps: [...completed],
      skippedSteps: [...skipped],
      completedAt: allDone ? progress.completedAt ?? new Date() : null
    }
  });
}
