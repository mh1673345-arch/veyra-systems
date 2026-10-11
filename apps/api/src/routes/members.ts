import { Router } from "express";
import { z } from "zod";
import type { BusinessMember, MembershipRole } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { assertWithinLimit } from "../services/access/accessService.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import { MEMBERSHIP_ROLES, roleHasPermission } from "../services/auth/permissions.js";
import { revokeAllSessionsForUser } from "../services/auth/sessions.js";
import { recordAuthEvent } from "../services/auth/authEvents.js";

export const membersRouter = Router();

const roleSchema = z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]);
const addMemberSchema = z.object({ email: z.string().email(), role: roleSchema });
const updateRoleSchema = z.object({ role: roleSchema });

function toMemberDto(membership: {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  user: { email: string; name: string; disabledAt: Date | null };
}): BusinessMember {
  return {
    membershipId: membership.id,
    userId: membership.userId,
    email: membership.user.email,
    name: membership.user.name,
    role: membership.role as MembershipRole,
    disabled: membership.user.disabledAt !== null,
    createdAt: membership.createdAt.toISOString()
  };
}

/**
 * Guards that stop a business being left ownerless, and stop anyone granting
 * themselves more access than they already have. All enforced server-side —
 * the UI hiding a button is not a control.
 */
async function assertOwnerSafety(params: {
  businessId: string;
  actorUserId: string;
  actorRole: MembershipRole;
  targetUserId: string;
  targetRole: MembershipRole;
  nextRole: MembershipRole | null;
}) {
  const { businessId, actorUserId, actorRole, targetUserId, targetRole, nextRole } = params;

  // Only an OWNER may grant or revoke OWNER.
  const touchesOwner = targetRole === "OWNER" || nextRole === "OWNER";
  if (touchesOwner && !roleHasPermission(actorRole, "members:manage_owners")) {
    throw new HttpError(403, "Only an owner can grant or change owner access");
  }

  // Nobody edits their own membership — that's the self-escalation path.
  if (targetUserId === actorUserId) {
    throw new HttpError(403, "You cannot change your own membership");
  }

  // Never leave the business without an owner.
  if (targetRole === "OWNER" && nextRole !== "OWNER") {
    const owners = await prisma.businessMembership.count({
      where: { businessId, role: "OWNER" }
    });
    if (owners <= 1) {
      throw new HttpError(422, "A business must keep at least one owner");
    }
  }
}

membersRouter.get(
  "/ops/businesses/:businessId/members",
  requireAuth,
  requireBusinessPermission("members:read"),
  async (req, res, next) => {
    try {
      const memberships = await prisma.businessMembership.findMany({
        where: { businessId: req.params.businessId },
        include: { user: { select: { email: true, name: true, disabledAt: true } } },
        orderBy: { createdAt: "asc" }
      });
      res.json(memberships.map(toMemberDto));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Adds an existing Veyra user to this business by email.
 *
 * There is no email delivery configured, so this deliberately does NOT pretend
 * to send an invitation — the user must already exist, and an operator shares
 * the sign-in details out of band. Email invitations are deferred, not faked.
 */
membersRouter.post(
  "/ops/businesses/:businessId/members",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("members:write"),
  async (req, res, next) => {
    try {
      const parsed = addMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, `A valid email and one of ${MEMBERSHIP_ROLES.join(", ")} is required`);
      }

      const businessId = req.params.businessId;
      const actorRole = req.membership!.role;

      if (parsed.data.role === "OWNER" && !roleHasPermission(actorRole, "members:manage_owners")) {
        throw new HttpError(403, "Only an owner can grant owner access");
      }

      const user = await prisma.user.findUnique({
        where: { email: parsed.data.email.toLowerCase() }
      });
      if (!user) {
        throw new HttpError(
          404,
          "No Veyra user with that email. Create the user first — invitation emails are not configured yet."
        );
      }

      const existing = await prisma.businessMembership.findUnique({
        where: { userId_businessId: { userId: user.id, businessId } }
      });
      if (existing) {
        throw new HttpError(409, "That user is already a member of this business");
      }

      // Plan limit, checked only after every RBAC and validity check above,
      // so it can never be used to learn anything the caller couldn't already.
      await assertWithinLimit(businessId, "team_members");

      const membership = await prisma.businessMembership.create({
        data: { userId: user.id, businessId, role: parsed.data.role },
        include: { user: { select: { email: true, name: true, disabledAt: true } } }
      });

      res.status(201).json(toMemberDto(membership));
    } catch (err) {
      next(err);
    }
  }
);

membersRouter.patch(
  "/ops/businesses/:businessId/members/:membershipId",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("members:write"),
  async (req, res, next) => {
    try {
      const parsed = updateRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, `Role must be one of ${MEMBERSHIP_ROLES.join(", ")}`);
      }

      const businessId = req.params.businessId;
      const membership = await prisma.businessMembership.findFirst({
        where: { id: req.params.membershipId, businessId }
      });
      if (!membership) {
        throw new HttpError(404, "Membership not found");
      }

      await assertOwnerSafety({
        businessId,
        actorUserId: req.auth!.user.id,
        actorRole: req.membership!.role,
        targetUserId: membership.userId,
        targetRole: membership.role as MembershipRole,
        nextRole: parsed.data.role
      });

      const updated = await prisma.businessMembership.update({
        where: { id: membership.id },
        data: { role: parsed.data.role },
        include: { user: { select: { email: true, name: true, disabledAt: true } } }
      });

      await recordAuthEvent({
        type: "role_changed",
        userId: membership.userId,
        req,
        detail: `${membership.role} -> ${parsed.data.role} by ${req.auth!.user.id}`
      });

      res.json(toMemberDto(updated));
    } catch (err) {
      next(err);
    }
  }
);

membersRouter.delete(
  "/ops/businesses/:businessId/members/:membershipId",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("members:write"),
  async (req, res, next) => {
    try {
      const businessId = req.params.businessId;
      const membership = await prisma.businessMembership.findFirst({
        where: { id: req.params.membershipId, businessId }
      });
      if (!membership) {
        throw new HttpError(404, "Membership not found");
      }

      await assertOwnerSafety({
        businessId,
        actorUserId: req.auth!.user.id,
        actorRole: req.membership!.role,
        targetUserId: membership.userId,
        targetRole: membership.role as MembershipRole,
        nextRole: null
      });

      await prisma.businessMembership.delete({ where: { id: membership.id } });

      // If that was their last membership, existing sessions can no longer
      // reach any business — end them rather than leaving them half-valid.
      const remaining = await prisma.businessMembership.count({
        where: { userId: membership.userId }
      });
      if (remaining === 0) {
        await revokeAllSessionsForUser(membership.userId);
      }

      await recordAuthEvent({
        type: "membership_removed",
        userId: membership.userId,
        req,
        detail: `removed from ${businessId} by ${req.auth!.user.id}`
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);
