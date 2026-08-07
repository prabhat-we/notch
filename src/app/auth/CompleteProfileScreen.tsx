import { useState } from "react";
import { UserRound } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "./AuthContext";

/* Shown once, right after a user's first login (signup or first sign-in),
 * when their membership row has no full_name yet. Sets it and gets out of
 * the way — no avatar upload, initials are generated from the name. */
export default function CompleteProfileScreen() {
  const { user, refreshMembership, signOut } = useAuth();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || !user) {
      setError("Enter your name to continue.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const { error } = await supabase
      .from("memberships")
      .update({ full_name: trimmed })
      .eq("user_id", user.id);
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    await refreshMembership();
  };

  return (
    <div className="size-full flex items-center justify-center bg-slate-300/50">
      <div className="relative w-full max-w-[430px] h-full max-h-[900px] flex flex-col bg-[#EEF0F7] overflow-hidden shadow-2xl shadow-slate-900/20">
        <div className="flex-1 overflow-y-auto hide-scroll px-6 py-10 flex flex-col">
          <div className="mb-10 mt-4">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/25 mb-5">
              <UserRound size={22} className="text-white" strokeWidth={2.5} />
            </div>
            <h1 className="text-2xl font-black text-slate-800 leading-tight">Welcome — one last thing</h1>
            <p className="text-sm text-slate-500 mt-2 leading-relaxed">
              What should your teammates call you? This is shown on tasks and your profile.
            </p>
          </div>

          <form className="space-y-4" onSubmit={e => { e.preventDefault(); submit(); }}>
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Full Name</label>
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Jane Doe"
                className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:bg-white transition-all"
              />
            </div>

            {error && (
              <p className="text-xs font-semibold text-red-500 leading-relaxed">{error}</p>
            )}

            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="w-full bg-indigo-600 text-white py-4 rounded-2xl text-sm font-bold disabled:opacity-40 hover:bg-indigo-700 active:bg-indigo-800 transition-colors shadow-lg shadow-indigo-600/20"
            >
              {submitting ? "Saving…" : "Continue"}
            </button>
          </form>

          <button
            type="button"
            onClick={signOut}
            className="mt-6 text-xs font-bold text-slate-400 self-center"
          >
            Sign out instead
          </button>
        </div>
      </div>
    </div>
  );
}
