import { useState } from "react";
import { useParams } from "react-router-dom";
import { type MembershipRole, PLAN_CATALOG } from "@veyra/shared";
import { ApiError, addMember, listMembers, removeMember, updateMemberRole } from "./opsClient";
import { useAsync } from "./useAsync";
import { StateBlock, formatDateTime } from "./components";
import { useAuth } from "./AuthContext";

const ROLES: MembershipRole[] = ["OWNER", "ADMIN", "OPERATOR", "VIEWER"];

export function MembersPage() {
  const { businessId = "" } = useParams();
  const { session, can } = useAuth();
  const state = useAsync(() => listMembers(businessId), [businessId]);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MembershipRole>("VIEWER");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canWrite = can(businessId, "members:write");

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
      state.reload();
    } catch (err) {
      // Server-side guards (owner safety, self-escalation, plan limits) surface here.
      if (err instanceof ApiError && err.code === "PLAN_LIMIT_REACHED") {
        setError(
          `${err.message}` +
            (err.requiredPlan
              ? ` ${PLAN_CATALOG[err.requiredPlan].name} allows more — see Plan & usage in Business Settings.`
              : "")
        );
      } else {
        setError(err instanceof Error ? err.message : "Could not update members");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <header className="ops-page-head">
        <h1>Members</h1>
      </header>

      <p className="ops-note">
        Access is granted per business. Email invitations are not configured yet, so a user must
        already have a Veyra account before they can be added here.
      </p>

      <StateBlock
        loading={state.loading}
        error={state.error}
        empty={(state.data?.length ?? 0) === 0}
        emptyMessage="No members yet."
        onRetry={state.reload}
      >
        <table className="ops-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Added</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {state.data?.map((member) => {
              const isSelf = member.userId === session?.user.id;
              return (
                <tr key={member.membershipId}>
                  <td>
                    {member.name}
                    {isSelf && <span className="ops-tag">you</span>}
                    {member.disabled && <span className="ops-tag">disabled</span>}
                  </td>
                  <td>{member.email}</td>
                  <td>
                    {canWrite && !isSelf ? (
                      <select
                        value={member.role}
                        disabled={pending}
                        onChange={(e) =>
                          run(() =>
                            updateMemberRole(
                              businessId,
                              member.membershipId,
                              e.target.value as MembershipRole
                            )
                          )
                        }
                        aria-label={`Role for ${member.email}`}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      member.role
                    )}
                  </td>
                  <td>{formatDateTime(member.createdAt)}</td>
                  {canWrite && (
                    <td>
                      {!isSelf && (
                        <button
                          type="button"
                          className="ops-linkish"
                          disabled={pending}
                          onClick={() => run(() => removeMember(businessId, member.membershipId))}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </StateBlock>

      {canWrite && (
        <>
          <h2>Add a member</h2>
          <form
            className="ops-actions"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await addMember(businessId, email.trim(), role);
                setEmail("");
              });
            }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              aria-label="Member email"
              required
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as MembershipRole)}
              aria-label="Member role"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button type="submit" disabled={pending || !email.trim()}>
              Add member
            </button>
          </form>
        </>
      )}

      {error && <p className="ops-state ops-state-error">{error}</p>}
    </section>
  );
}
