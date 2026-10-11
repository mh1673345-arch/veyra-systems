import { NavLink, Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { NotificationBell } from "./NotificationBell";

/** Sends unauthenticated visitors to /login, remembering where they were going. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="ops-gate">
        <p className="ops-state">Loading…</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

export function DashboardLayout() {
  const { session, signOut, membershipFor, can } = useAuth();
  const { businessId } = useParams();

  // Only businesses this user is a member of — there is no global picker.
  const memberships = session?.memberships ?? [];

  if (!businessId) {
    if (memberships.length === 1) {
      return <Navigate to={`/dashboard/${memberships[0].businessId}`} replace />;
    }

    return (
      <div className="ops-gate">
        <div className="ops-login-card">
          <div className="ops-brand">
            <span className="ops-brand-mark">Veyra</span>
            <span className="ops-brand-sub">Operations</span>
          </div>
          <p className="ops-state">Signed in as {session?.user.email}</p>

          {memberships.length === 0 ? (
            <>
              <p className="ops-state">You don't have a business in Veyra yet.</p>
              <NavLink to="/dashboard/new" className="ops-primary-link" data-testid="create-workspace-link">
                Set up your business
              </NavLink>
              <p className="ops-note">Joining a colleague's business instead? Ask an owner to add you.</p>
            </>
          ) : (
            <ul className="ops-business-list">
              {memberships.map((membership) => (
                <li key={membership.businessId}>
                  <NavLink to={`/dashboard/${membership.businessId}`}>
                    {membership.businessName}
                    <span className="ops-tag">{membership.role}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}

          {memberships.length > 0 && (
            <NavLink to="/dashboard/new" className="ops-linkish">
              Create another business
            </NavLink>
          )}
          <button type="button" className="ops-linkish" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const membership = membershipFor(businessId);

  // Signed in, but not a member of the business in the URL.
  if (!membership) {
    return (
      <div className="ops-gate">
        <div className="ops-login-card">
          <h1>Not available</h1>
          <p className="ops-state">
            This business doesn't exist or your account doesn't have access to it.
          </p>
          <NavLink to="/dashboard" className="ops-linkish">
            Back to your businesses
          </NavLink>
        </div>
      </div>
    );
  }

  return (
    <div className="ops-shell">
      <aside className="ops-sidebar">
        <div className="ops-brand">
          <span className="ops-brand-mark">Veyra</span>
          <span className="ops-brand-sub">Operations</span>
        </div>
        <p className="ops-business-name">
          {membership.businessName}
          <span className="ops-tag">{membership.role}</span>
        </p>
        <NotificationBell />
        <nav>
          <NavLink end to={`/dashboard/${businessId}`}>
            Overview
          </NavLink>
          <NavLink to={`/dashboard/${businessId}/setup`}>Setup</NavLink>
          <NavLink to={`/dashboard/${businessId}/work-queue`}>Work queue</NavLink>
          <NavLink to={`/dashboard/${businessId}/conversations`}>Conversations</NavLink>
          <NavLink to={`/dashboard/${businessId}/bookings`}>Bookings</NavLink>
          <NavLink to={`/dashboard/${businessId}/escalations`}>Escalations</NavLink>
          <NavLink to={`/dashboard/${businessId}/calls`}>Calls</NavLink>
          {can(businessId, "pilot:read") && <NavLink to={`/dashboard/${businessId}/pilot`}>Pilot</NavLink>}
          <NavLink to={`/dashboard/${businessId}/settings`}>Business Settings</NavLink>
          <NavLink to={`/dashboard/${businessId}/account`}>Account</NavLink>
          {can(businessId, "members:read") && (
            <NavLink to={`/dashboard/${businessId}/members`}>Members</NavLink>
          )}
        </nav>
        <div className="ops-sidebar-footer">
          {memberships.length > 1 && <NavLink to="/dashboard">Switch business</NavLink>}
          <span className="ops-signed-in">{session?.user.name}</span>
          <a href="/">Reception demo</a>
          <button type="button" className="ops-linkish" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="ops-main">
        <Outlet />
      </main>
    </div>
  );
}
