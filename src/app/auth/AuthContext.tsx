import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";
import type { MembershipRole } from "../../lib/database.types";

interface AuthContextValue {
  user: User | null;
  role: MembershipRole | null;
  orgId: string | null;
  /** The signed-in user's own membership row id — the stable identity to use
   *  for "which membership is me" instead of matching by email or array index. */
  membershipId: string | null;
  /** The signed-in user's own membership email (useful before user_id is linked). */
  membershipEmail: string | null;
  /** The signed-in user's display name, set via the "complete your profile" step. Null until set. */
  fullName: string | null;
  /** True while the initial session/membership lookup is in flight. */
  loading: boolean;
  /** True once we know the user is signed in but has no membership row. */
  noMembership: boolean;
  /** True once we know the user has a membership row but hasn't set full_name yet. */
  needsProfile: boolean;
  /** Re-run the membership lookup — call after updating the row (e.g. after setting full_name). */
  refreshMembership: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [membershipId, setMembershipId] = useState<string | null>(null);
  const [role, setRole] = useState<MembershipRole | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [membershipEmail, setMembershipEmail] = useState<string | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [noMembership, setNoMembership] = useState(false);

  const loadMembership = useCallback(async (userId: string, callSite: string) => {
    // DEBUG: unique tag per invocation so overlapping calls (e.g. getSession()
    // racing with onAuthStateChange's INITIAL_SESSION event) are distinguishable
    // in the console instead of interleaving into one confusing stream.
    const callId = `${callSite}:${userId.slice(0, 8)}:${Date.now()}`;
    console.log(`[useAuth][${callId}] loadMembership called`, { userId, callSite });

    // STEP 2: the exact query being run. Note the filter is our own copy of
    // the user id (from the session object), not literally auth.uid() — that
    // value is derived server-side by PostgREST from the JWT the supabase-js
    // client attaches to the request. Logging both here lets us confirm they
    // actually match at request time.
    console.log(`[useAuth][${callId}] querying memberships`, {
      table: "memberships",
      select: "id, org_id, role, email, full_name",
      filter: `user_id.eq.${userId}`,
      "note: auth.uid() used by RLS": "derived server-side from the request JWT, not shown client-side",
    });

    const { data, error, status, statusText } = await supabase
      .from("memberships")
      .select("id, org_id, role, email, full_name")
      .eq("user_id", userId)
      .maybeSingle();

    // STEP 3: raw response.
    console.log(`[useAuth][${callId}] raw response`, { data, error, status, statusText });

    if (error || !data) {
      console.log(`[useAuth][${callId}] DECISION: setting noMembership=true`, {
        reason: error ? "query returned an error" : "query returned no row (data is null)",
        error,
        data,
      });
      setMembershipId(null);
      setRole(null);
      setOrgId(null);
      setMembershipEmail(null);
      setFullName(null);
      setNoMembership(true);
      return;
    }
    console.log(`[useAuth][${callId}] DECISION: membership found, setting noMembership=false`, { data });
    setMembershipId(data.id);
    setRole(data.role);
    setOrgId(data.org_id);
    setMembershipEmail(data.email);
    setFullName(data.full_name);
    setNoMembership(false);
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      // STEP 1: session detection (initial getSession() call).
      console.log("[useAuth][getSession] resolved", {
        active,
        hasSession: !!session,
        userId: session?.user?.id ?? null,
        userEmail: session?.user?.email ?? null,
        expiresAt: session?.expires_at ?? null,
        session,
      });
      if (!active) return;
      setSession(session);
      if (session?.user) {
        await loadMembership(session.user.id, "getSession");
      }
      if (active) setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      // STEP 1: session detection (auth state change listener). `event` is
      // the important bit here — supabase-js fires this listener immediately
      // on subscribe (often with "INITIAL_SESSION"), in addition to the
      // getSession() call above resolving separately. That means this
      // callback and the getSession().then() above can both call
      // loadMembership for the same user concurrently — watch the callId
      // tags above to see if that's happening and which one "wins".
      console.log("[useAuth][onAuthStateChange] fired", {
        event,
        active,
        hasSession: !!newSession,
        userId: newSession?.user?.id ?? null,
        userEmail: newSession?.user?.email ?? null,
        expiresAt: newSession?.expires_at ?? null,
        newSession,
      });
      if (!active) return;
      setSession(newSession);
      if (newSession?.user) {
        setLoading(true);
        await loadMembership(newSession.user.id, `onAuthStateChange:${event}`);
        setLoading(false);
      } else {
        console.log("[useAuth][onAuthStateChange] no session — clearing membership state", { event });
        setMembershipId(null);
        setRole(null);
        setOrgId(null);
        setMembershipEmail(null);
        setFullName(null);
        setNoMembership(false);
        setLoading(false);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [loadMembership]);

  const refreshMembership = useCallback(async () => {
    if (!session?.user) return;
    await loadMembership(session.user.id, "manual-refresh");
  }, [session, loadMembership]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const value: AuthContextValue = {
    user: session?.user ?? null,
    role,
    orgId,
    membershipId,
    membershipEmail,
    fullName,
    loading,
    noMembership,
    needsProfile: !noMembership && !!role && !fullName?.trim(),
    refreshMembership,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
