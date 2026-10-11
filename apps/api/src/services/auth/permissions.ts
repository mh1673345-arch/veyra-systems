import type { MembershipRole, Permission } from "@veyra/shared";

/**
 * The single place roles are turned into capabilities. Routes ask for a
 * permission, never for a role, so authorization rules live here rather than
 * being scattered as role comparisons across handlers.
 */
const ROLE_PERMISSIONS: Record<MembershipRole, Permission[]> = {
  OWNER: [
    "dashboard:read",
    "operations:write",
    "settings:read",
    "members:read",
    "members:write",
    "members:manage_owners",
    "calendar:manage",
    "subscription:read",
    // Only the owner commits the business to a payment. ADMIN can see billing
    // (subscription:read) but not start checkout, change or cancel the plan.
    "billing:manage",
    "pilot:read",
    "pilot:manage",
    "pilot:report",
    "pilot:triage",
    "settings:write"
  ],
  ADMIN: [
    "dashboard:read",
    "operations:write",
    "settings:read",
    "members:read",
    "members:write",
    // Connecting a calendar grants Veyra access to a business's real schedule,
    // so it stays with the two administrative roles. An OPERATOR runs the day
    // to day (including cancelling a booking) but cannot re-point or revoke
    // the connection itself.
    "calendar:manage",
    "subscription:read",
    // A pilot is run day to day by whoever is closest to it, so ADMIN gets the
    // same pilot management as OWNER. It grants no billing and no plan change.
    "pilot:read",
    "pilot:manage",
    "pilot:report",
    "pilot:triage",
    // Business configuration and going live/pausing are administrative too.
    "settings:write"
  ],
  // An OPERATOR runs the day to day: they see the pilot, report what Veyra got
  // wrong and work the issue queue — but cannot change pilot targets, status or
  // safety controls.
  OPERATOR: ["dashboard:read", "operations:write", "settings:read", "pilot:read", "pilot:report", "pilot:triage"],
  // Read-only analytics, nothing else.
  VIEWER: ["dashboard:read", "settings:read", "pilot:read"]
};

export const MEMBERSHIP_ROLES: MembershipRole[] = ["OWNER", "ADMIN", "OPERATOR", "VIEWER"];

export function isMembershipRole(value: string): value is MembershipRole {
  return (MEMBERSHIP_ROLES as string[]).includes(value);
}

export function permissionsForRole(role: string): Permission[] {
  return isMembershipRole(role) ? ROLE_PERMISSIONS[role] : [];
}

export function roleHasPermission(role: string, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}
