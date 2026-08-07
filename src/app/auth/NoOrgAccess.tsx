import { ShieldOff } from "lucide-react";
import { useAuth } from "./AuthContext";

/* Shown when a user is signed in but has no matching `memberships`
 * row — e.g. they signed up with an email nobody invited yet. */
export default function NoOrgAccess() {
  const { user, signOut } = useAuth();

  return (
    <div className="size-full flex items-center justify-center bg-slate-300/50">
      <div className="relative w-full max-w-[430px] h-full max-h-[900px] flex flex-col bg-[#EEF0F7] overflow-hidden shadow-2xl shadow-slate-900/20">
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <div className="w-14 h-14 rounded-full bg-slate-200 flex items-center justify-center mb-5">
            <ShieldOff size={24} className="text-slate-400" />
          </div>
          <h1 className="text-lg font-black text-slate-800">No organization access yet</h1>
          <p className="text-sm text-slate-500 mt-2 leading-relaxed max-w-[280px]">
            {user?.email ? <>We couldn't find an invite for <span className="font-semibold text-slate-600">{user.email}</span>.</> : "We couldn't find an invite for your account."}
            {" "}Contact your admin to get added to a team.
          </p>
          <button
            type="button"
            onClick={signOut}
            className="mt-8 px-5 py-2.5 rounded-xl text-xs font-bold bg-white text-slate-500 shadow-[0_1px_6px_rgba(15,23,42,0.06)]"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
