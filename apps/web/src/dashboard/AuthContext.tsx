import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AuthMembership, AuthSessionResponse, Permission } from "@veyra/shared";
import { getSession, login as apiLogin, logout as apiLogout } from "./opsClient";

interface AuthState {
  session: AuthSessionResponse | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  membershipFor: (businessId: string | undefined) => AuthMembership | null;
  can: (businessId: string | undefined, permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSession(await getSession());
    } catch {
      // 401 simply means "not signed in".
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await apiLogin(email, password);
      await refresh();
    },
    [refresh]
  );

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // An already-expired or revoked session returns 401; either way the user
      // is signed out, so clear local state rather than trapping them.
    }
    setSession(null);
  }, []);

  const membershipFor = useCallback(
    (businessId: string | undefined) =>
      session?.memberships.find((m) => m.businessId === businessId) ?? null,
    [session]
  );

  /**
   * Convenience for hiding controls the user can't use. The server enforces the
   * same rules independently — this only affects what is rendered.
   */
  const can = useCallback(
    (businessId: string | undefined, permission: Permission) =>
      Boolean(membershipFor(businessId)?.permissions.includes(permission)),
    [membershipFor]
  );

  const value = useMemo(
    () => ({ session, loading, signIn, signOut, refresh, membershipFor, can }),
    [session, loading, signIn, signOut, refresh, membershipFor, can]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
