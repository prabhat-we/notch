import { useState } from "react";
import { CheckCircle2, Lock, Mail } from "lucide-react";
import { supabase } from "../../lib/supabase";

type Tab = "signup" | "login";

/* ─── AuthScreen ──────────────────────────────────────────────
 * Invite-only auth: an owner creates a `memberships` row for an
 * employee's email ahead of time; the employee's first sign-up
 * with that same email gets auto-linked to it by a DB trigger.
 * There is no open self-serve signup — this screen just gives
 * an invited person a way to set their password the first time,
 * or sign back in after that.
 * ──────────────────────────────────────────────────────────── */
export default function AuthScreen() {
  const [tab, setTab] = useState<Tab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);

  const switchTab = (t: Tab) => {
    setTab(t);
    setError(null);
    setCheckEmail(false);
  };

  const submit = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setCheckEmail(false);

    if (tab === "signup") {
      const { data, error } = await supabase.auth.signUp({ email: trimmedEmail, password });
      setSubmitting(false);
      if (error) { setError(error.message); return; }
      if (data.session) return; // auto-confirmed — AuthContext picks up the session
      setCheckEmail(true);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: trimmedEmail, password });
      setSubmitting(false);
      if (error) { setError(error.message); return; }
    }
  };

  return (
    <div className="size-full flex items-center justify-center bg-slate-300/50">
      <div className="relative w-full max-w-[430px] h-full max-h-[900px] flex flex-col bg-[#EEF0F7] overflow-hidden shadow-2xl shadow-slate-900/20">
        <div className="flex-1 overflow-y-auto hide-scroll px-6 py-10 flex flex-col">
          <div className="mb-10 mt-4">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/25 mb-5">
              <CheckCircle2 size={22} className="text-white" strokeWidth={2.5} />
            </div>
            <h1 className="text-2xl font-black text-slate-800 leading-tight">whynotch</h1>
            <p className="text-sm text-slate-500 mt-2 leading-relaxed">
              Task management for your team.
            </p>
          </div>

          <div className="flex gap-2 mb-6">
            <button
              type="button"
              onClick={() => switchTab("login")}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
                tab === "login" ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20" : "bg-white text-slate-500 shadow-[0_1px_4px_rgba(15,23,42,0.06)]"
              }`}
            >
              Signin
            </button>
            <button
              type="button"
              onClick={() => switchTab("signup")}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
                tab === "signup" ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20" : "bg-white text-slate-500 shadow-[0_1px_4px_rgba(15,23,42,0.06)]"
              }`}
            >
              Signup
            </button>
          </div>

          {tab === "signup" && (
            <p className="text-[11px] text-slate-400 font-medium mb-5 -mt-1 leading-relaxed">
              Use the email your employer invited you with.
            </p>
          )}

          {checkEmail ? (
            <div className="bg-white rounded-2xl p-6 text-center shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
              <Mail size={24} className="text-indigo-400 mx-auto mb-3" />
              <p className="text-sm font-bold text-slate-800">Check your email</p>
              <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                We sent a confirmation link to {email.trim()}. Follow it, then come back and sign in.
              </p>
              <button
                type="button"
                onClick={() => switchTab("login")}
                className="mt-4 text-xs font-bold text-indigo-500"
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={e => { e.preventDefault(); submit(); }}
            >
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Email</label>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@work.com"
                  className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:bg-white transition-all"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Password</label>
                <input
                  type="password"
                  autoComplete={tab === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:bg-white transition-all"
                />
              </div>

              {error && (
                <p className="text-xs font-semibold text-red-500 leading-relaxed">{error}</p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-indigo-600 text-white py-4 rounded-2xl text-sm font-bold disabled:opacity-40 hover:bg-indigo-700 active:bg-indigo-800 transition-colors shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2"
              >
                {!submitting && <Lock size={14} />}
                {submitting ? "Please wait…" : tab === "signup" ? "Set password & continue" : "Sign in"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
