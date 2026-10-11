// Types for testDbTarget.mjs, which stays plain JavaScript so the reset script
// can run with no build step.
export type ResetTarget =
  | { ok: true; name: string; host: string }
  | { ok: false; reason: string };

export function checkResetTarget(databaseUrl: string | undefined): ResetTarget;
