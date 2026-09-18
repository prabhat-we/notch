import { useState, useRef, useEffect, useCallback } from "react";
import {
  LayoutDashboard, ListTodo, Settings, Plus, Mic, Play, Pause,
  Clock, Users, Check, X, Volume2, StopCircle,
  Trash2, Bell, TrendingUp, ChevronRight, ChevronLeft,
  Shield, Pencil, Image as ImageIcon, LogOut, Send, Loader2, Zap
} from "lucide-react";
import { useAuth } from "./auth/AuthContext";
import AuthScreen from "./auth/AuthScreen";
import NoOrgAccess from "./auth/NoOrgAccess";
import CompleteProfileScreen from "./auth/CompleteProfileScreen";
import { supabase } from "../lib/supabase";
import { getToday } from "../lib/date";
import { format, addDays } from "date-fns";
import { uploadTaskMedia, resolveSignedUrl } from "../lib/storage";


/* ─── Types ───────────────────────────────────────────────── */
// Lifecycle: draft -> assigned -> accepted -> working -> completed -> closed.
// completed -> assigned is a reopen/reassign, logged as a "reassigned"
// task_event rather than being a status of its own.
type TaskStatus = "draft" | "assigned" | "accepted" | "working" | "completed" | "closed";
type TaskEventType = "status_change" | "reassigned";
type Priority = "low" | "medium" | "high";
type View = "dashboard" | "tasks" | "settings";
type AppRole = "owner" | "employee";
type SortMode = "priority" | "dueDate" | "custom";

interface Employee {
  id: string;
  name: string;
  role: string;
  color: string;
  email: string;
  /** True when this membership row has no linked user_id yet — invited but not signed up. */
  pending?: boolean;
}
interface Comment {
  id: string;
  authorId: string;
  text: string;
  createdAt: string;
  imageUrls?: string[];
}
interface Task {
  id: string;
  title: string;
  description: string;
  assigneeId: string | null;
  createdById: string | null;
  status: TaskStatus;
  priority: Priority;
  dueDate: string;
  voiceNoteUrl: string | null;
  imageUrls: string[];
  createdAt: string;
  comments: Comment[];
  order: number;
}

/* ─── Config ──────────────────────────────────────────────── */
const P_CFG: Record<Priority, { label: string; text: string; bg: string; strip: string }> = {
  high:   { label: "High",   text: "text-red-600",   bg: "bg-red-50",    strip: "bg-red-500"   },
  medium: { label: "Medium", text: "text-amber-600", bg: "bg-amber-50",  strip: "bg-amber-400" },
  low:    { label: "Low",    text: "text-slate-500", bg: "bg-slate-100", strip: "bg-slate-400" },
};
const S_CFG: Record<TaskStatus, { label: string; text: string; bg: string }> = {
  draft:     { label: "Draft",       text: "text-slate-500",   bg: "bg-slate-100"  },
  assigned:  { label: "Assigned",    text: "text-amber-600",   bg: "bg-amber-50"   },
  accepted:  { label: "Accepted",    text: "text-sky-600",     bg: "bg-sky-50"     },
  working:   { label: "In Progress", text: "text-indigo-600",  bg: "bg-indigo-50"  },
  completed: { label: "Completed",   text: "text-emerald-600", bg: "bg-emerald-50" },
  closed:    { label: "Closed",      text: "text-slate-500",   bg: "bg-slate-200"  },
};
// A task is no longer "active" once it's completed or closed — used
// everywhere the old model checked `status === "done"`.
const isFinished = (s: TaskStatus) => s === "completed" || s === "closed";
// Collapses the 6-state lifecycle onto the 3 buckets used by list
// filters, dashboard stats, and sort ordering (unchanged from before —
// only the states feeding each bucket changed): To Do = draft/assigned,
// In Progress = accepted/working, Done = completed/closed.
const isInProgress = (s: TaskStatus) => s === "accepted" || s === "working";
const isNotYetStarted = (s: TaskStatus) => s === "draft" || s === "assigned";
const AVATAR_COLORS = ["#7C3AED","#0891B2","#059669","#DC2626","#D97706","#4F46E5","#DB2777"];

/* ─── Helpers ─────────────────────────────────────────────── */
const initials = (n: string) => n.split(" ").map(p => p[0]).join("").toUpperCase().slice(0, 2);
function relDate(d: string) {
  const diff = Math.floor((new Date(d).getTime() - getToday().getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  return `${diff}d left`;
}
const isOverdue = (d: string, s: TaskStatus) => new Date(d) < getToday() && !isFinished(s);
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Deterministic avatar color from a membership id — there's no color-picker UI
// anymore (invites are just an email), so every real team member still gets a
// distinct, stable color instead of everyone sharing the DB default.
function colorForId(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// Maps a `memberships` row to the `Employee` shape the existing task-assignee
// UI already speaks — full_name if set, otherwise email, per the "complete
// your profile" flow.
interface MembershipRow {
  id: string;
  email: string;
  full_name: string | null;
  role: AppRole;
  user_id?: string | null;
}
function toEmployee(m: MembershipRow): Employee {
  return {
    id: m.id,
    name: m.full_name?.trim() || m.email,
    role: m.role === "owner" ? "Owner" : "Team Member",
    color: colorForId(m.id),
    email: m.email,
    pending: m.user_id == null,
  };
}

// Maps `tasks`/`comments` rows to the Task/Comment shapes the existing UI
// already speaks. Comments are fetched alongside their task's org and
// merged in client-side (see fetchTasks in AuthenticatedApp) rather than
// lazily per-open-task, since task list cards show comment counts too.
interface TaskRow {
  id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  created_by: string | null;
  status: TaskStatus;
  priority: Priority;
  due_date: string | null;
  voice_note_url: string | null;
  image_urls: string[];
  sort_order: number;
  created_at: string;
}
interface CommentRow {
  id: string;
  task_id: string;
  author_id: string | null;
  text: string;
  image_urls: string[];
  created_at: string;
}
function toComment(c: CommentRow): Comment {
  return {
    id: c.id,
    authorId: c.author_id ?? "",
    text: c.text,
    createdAt: c.created_at,
    imageUrls: c.image_urls,
  };
}
function toTask(t: TaskRow, comments: Comment[]): Task {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    assigneeId: t.assignee_id,
    createdById: t.created_by,
    status: t.status,
    priority: t.priority,
    dueDate: t.due_date ?? "",
    voiceNoteUrl: t.voice_note_url,
    imageUrls: t.image_urls ?? [],
    createdAt: t.created_at,
    comments,
    order: t.sort_order,
  };
}

/* ─── BottomSheet wrapper ─────────────────────────────────── */
function BottomSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(true); }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        style={{ opacity: open ? 1 : 0, transition: "opacity 0.25s" }}
        onClick={onClose}
      />
      <div
        className="relative w-full max-w-[430px] mx-auto bg-white rounded-t-3xl shadow-2xl max-h-[90vh] flex flex-col"
        style={{ transform: open ? "translateY(0)" : "translateY(100%)", transition: "transform 0.3s cubic-bezier(0.32,0.72,0,1)" }}
      >
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-9 h-1 bg-slate-200 rounded-full" />
        </div>
        {children}
      </div>
    </div>
  );
}

/* ─── VoiceRecorder ───────────────────────────────────────── */
function VoiceRecorder({ orgId, taskId, onRecorded, existingUrl, onUploadingChange }: {
  orgId: string;
  taskId: string;
  onRecorded: (path: string | null) => void;
  existingUrl?: string | null;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [path, setPath] = useState<string | null>(existingUrl ?? null);
  const [playing, setPlaying] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null | undefined>(undefined);
  const mr = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { onUploadingChange?.(uploading); }, [uploading, onUploadingChange]);

  // Re-resolve a fresh signed URL for playback whenever the underlying
  // path changes — a signed URL is never stored, only generated on demand.
  useEffect(() => {
    audioEl.current = null;
    setPlaying(false);
    if (!path) { setSignedUrl(null); return; }
    let cancelled = false;
    setSignedUrl(undefined);
    resolveSignedUrl(path).then(url => { if (!cancelled) setSignedUrl(url); });
    return () => { cancelled = true; };
  }, [path]);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      mr.current = rec;
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        stream.getTracks().forEach(t => t.stop());
        setUploading(true);
        setUploadError(null);
        try {
          const uploadedPath = await uploadTaskMedia(orgId, taskId, blob, "webm");
          setPath(uploadedPath);
          onRecorded(uploadedPath);
        } catch {
          setUploadError("Couldn't upload voice note — try recording again.");
        } finally {
          setUploading(false);
        }
      };
      rec.start();
      setRecording(true);
      setSecs(0);
      timer.current = setInterval(() => setSecs(s => s + 1), 1000);
    } catch { /* mic denied */ }
  };

  const stop = () => {
    mr.current?.stop();
    setRecording(false);
    if (timer.current) clearInterval(timer.current);
  };

  const togglePlay = () => {
    if (!signedUrl) return;
    if (!audioEl.current) {
      audioEl.current = new Audio(signedUrl);
      audioEl.current.onended = () => setPlaying(false);
    }
    if (playing) { audioEl.current.pause(); setPlaying(false); }
    else { audioEl.current.play(); setPlaying(true); }
  };

  const clear = () => {
    audioEl.current?.pause();
    setPath(null); setSecs(0); setPlaying(false); setUploadError(null);
    onRecorded(null);
  };

  if (uploading) {
    return (
      <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3">
        <Loader2 size={16} className="text-indigo-400 animate-spin flex-shrink-0" />
        <p className="text-xs font-semibold text-indigo-600">Uploading voice note…</p>
      </div>
    );
  }

  if (path) {
    return (
      <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3">
        <button type="button" onClick={togglePlay} disabled={!signedUrl}
          className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm disabled:opacity-40"
        >
          {playing ? <Pause size={13} className="text-white" /> : <Play size={13} className="text-white ml-0.5" />}
        </button>
        <div className="flex-1">
          <p className="text-xs font-semibold text-indigo-700">Voice note</p>
          <p className="text-[11px] text-indigo-400 font-mono">
            {signedUrl === undefined ? "Loading…" : signedUrl === null ? "Couldn't load audio" : "tap to play"}
          </p>
        </div>
        <button type="button" onClick={clear} className="text-slate-300 hover:text-red-400 transition-colors">
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button type="button" onClick={recording ? stop : start}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
            recording ? "bg-red-500 text-white" : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
          }`}
        >
          {recording ? <StopCircle size={15} /> : <Mic size={15} />}
          {recording ? `Recording ${fmtTime(secs)}` : "Record voice note"}
        </button>
        {recording && (
          <div className="flex items-end gap-0.5">
            {[4, 8, 12, 8, 6, 10, 4].map((h, i) => (
              <div key={i} className="w-1 bg-red-400 rounded-full animate-bounce" style={{ height: h, animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        )}
      </div>
      {uploadError && <p className="text-[11px] font-semibold text-red-500">{uploadError}</p>}
    </div>
  );
}

/* ─── ImagePicker ─────────────────────────────────────────── *
 * `upload` is opt-in: when provided (task attachments), picked files
 * are uploaded to Storage and `onChange` receives the resulting object
 * paths, resolved to signed URLs for display via SignedTaskImage. When
 * omitted (comment composer), behavior is unchanged — local blob: URLs
 * only, never persisted — comment attachments are a separate, tracked
 * gap outside this pass. */
function ImagePicker({ images, onChange, size = "md", upload, onUploadingChange }: {
  images: string[];
  onChange: (urls: string[]) => void;
  size?: "md" | "sm";
  upload?: { orgId: string; taskId: string };
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const dim = size === "sm" ? "w-12 h-12" : "w-16 h-16";
  const [pendingCount, setPendingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => { onUploadingChange?.(pendingCount > 0); }, [pendingCount, onUploadingChange]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    if (!upload) {
      const urls = Array.from(files).map(f => URL.createObjectURL(f));
      onChange([...images, ...urls]);
      return;
    }
    setUploadError(null);
    const fileList = Array.from(files);
    setPendingCount(c => c + fileList.length);
    try {
      const paths = await Promise.all(fileList.map(f => uploadTaskMedia(upload.orgId, upload.taskId, f, extFromFile(f))));
      onChange([...images, ...paths]);
    } catch {
      setUploadError("Couldn't upload one or more images — try again.");
    } finally {
      setPendingCount(c => c - fileList.length);
    }
  };

  const remove = (url: string) => onChange(images.filter(u => u !== url));

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {images.map(url => (
          <div key={url} className={`relative ${dim} rounded-xl overflow-hidden flex-shrink-0 bg-slate-100`}>
            {upload ? (
              <SignedTaskImage path={url} className="w-full h-full" />
            ) : (
              <img src={url} alt="Attached" className="w-full h-full object-cover" />
            )}
            <button type="button" onClick={() => remove(url)}
              className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center"
            >
              <X size={11} className="text-white" />
            </button>
          </div>
        ))}
        {Array.from({ length: pendingCount }).map((_, i) => (
          <div key={`pending-${i}`} className={`${dim} rounded-xl flex-shrink-0 bg-slate-100 flex items-center justify-center`}>
            <Loader2 size={14} className="text-slate-400 animate-spin" />
          </div>
        ))}
        <button type="button" onClick={() => fileInput.current?.click()}
          className={`${dim} rounded-xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center gap-1 text-slate-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/50 transition-colors flex-shrink-0`}
        >
          <ImageIcon size={size === "sm" ? 14 : 16} />
          <span className="text-[9px] font-bold">Add image</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={e => { handleFiles(e.target.files); e.target.value = ""; }}
        />
      </div>
      {uploadError && <p className="text-[11px] font-semibold text-red-500 mt-2">{uploadError}</p>}
    </div>
  );
}

function extFromFile(file: File): string {
  const dot = file.name.lastIndexOf(".");
  if (dot > 0 && dot < file.name.length - 1) return file.name.slice(dot + 1).toLowerCase();
  return (file.type.split("/")[1] || "bin").toLowerCase();
}

/* ─── SignedTaskImage ─────────────────────────────────────── *
 * Resolves a task-media storage path to a fresh signed URL on mount /
 * whenever `path` changes, and renders a loading/error placeholder in
 * the meantime — the signed URL itself is never cached or stored. */
function SignedTaskImage({ path, className, alt = "Task attachment", fit = "cover" }: {
  path: string;
  className: string;
  alt?: string;
  fit?: "cover" | "contain";
}) {
  const [signedUrl, setSignedUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setSignedUrl(undefined);
    resolveSignedUrl(path).then(url => { if (!cancelled) setSignedUrl(url); });
    return () => { cancelled = true; };
  }, [path]);

  if (signedUrl === undefined) return <div className="w-16 h-16 rounded-xl bg-slate-100 animate-pulse flex-shrink-0" />;
  if (signedUrl === null) return (
    <div className="w-16 h-16 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
      <ImageIcon size={14} className="text-red-300" />
    </div>
  );
  const fitClass = fit === "contain" ? "object-contain" : "object-cover";
  return <img src={signedUrl} alt={alt} className={`${className} ${fitClass}`} />;
}

/* ─── VoiceNotePlayer (read-only playback) ────────────────── *
 * `path` is a storage object path, not a URL — a fresh signed URL is
 * resolved on mount / whenever the path changes, never stored. */
function VoiceNotePlayer({ path }: { path: string }) {
  const [playing, setPlaying] = useState(false);
  const [signedUrl, setSignedUrl] = useState<string | null | undefined>(undefined);
  const audioEl = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSignedUrl(undefined);
    resolveSignedUrl(path).then(url => { if (!cancelled) setSignedUrl(url); });
    return () => { cancelled = true; };
  }, [path]);

  const toggle = () => {
    if (!signedUrl) return;
    if (!audioEl.current) {
      audioEl.current = new Audio(signedUrl);
      audioEl.current.onended = () => setPlaying(false);
    }
    if (playing) { audioEl.current.pause(); setPlaying(false); }
    else { audioEl.current.play(); setPlaying(true); }
  };

  if (signedUrl === null) {
    return (
      <div className="flex items-center gap-3 bg-red-50 border border-red-100 rounded-2xl px-4 py-3">
        <Volume2 size={15} className="text-red-300 flex-shrink-0" />
        <p className="text-xs font-semibold text-red-500">Couldn't load voice note</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3">
      <button type="button" onClick={toggle} disabled={!signedUrl}
        className="w-9 h-9 bg-indigo-600 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm disabled:opacity-40"
      >
        {playing ? <Pause size={14} className="text-white" /> : <Play size={14} className="text-white ml-0.5" />}
      </button>
      <div className="flex-1">
        <p className="text-xs font-semibold text-indigo-700">Voice instructions</p>
        <p className="text-[11px] text-indigo-400 font-medium">{signedUrl === undefined ? "Loading…" : playing ? "Playing…" : "Tap to listen"}</p>
      </div>
      <Volume2 size={15} className="text-indigo-300 flex-shrink-0" />
    </div>
  );
}

/* ─── TaskFormFields (shared by Add + Edit) ───────────────── */
function TaskFormFields({
  title, setTitle, desc, setDesc, priority, setPriority,
  dueDate, setDueDate, assigneeId, setAssigneeId,
  voiceNoteUrl, setVoice, imageUrls, setImageUrls, employees, requireTitle,
  orgId, taskId, onUploadingChange,
}: {
  title: string; setTitle: (v: string) => void;
  desc: string; setDesc: (v: string) => void;
  priority: Priority; setPriority: (v: Priority) => void;
  dueDate: string; setDueDate: (v: string) => void;
  assigneeId: string | null; setAssigneeId: (v: string | null) => void;
  voiceNoteUrl: string | null; setVoice: (v: string | null) => void;
  imageUrls: string[]; setImageUrls: (v: string[]) => void;
  employees: Employee[];
  // Status is no longer freely editable here — it's exclusively driven by
  // the guarded lifecycle transition buttons in the read-only view.
  requireTitle: boolean;
  orgId: string; taskId: string;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const titleOptional = !requireTitle && !title.trim() && (!!voiceNoteUrl || imageUrls.length > 0);
  const [voiceUploading, setVoiceUploading] = useState(false);
  const [imagesUploading, setImagesUploading] = useState(false);
  useEffect(() => { onUploadingChange?.(voiceUploading || imagesUploading); }, [voiceUploading, imagesUploading, onUploadingChange]);

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Task Title</label>
          {titleOptional && <span className="text-[10px] font-bold text-indigo-400">Optional — you added {voiceNoteUrl && imageUrls.length ? "a voice note & image" : voiceNoteUrl ? "a voice note" : "an image"}</span>}
        </div>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs to be done?"
          className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:bg-white transition-all"
        />
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Details</label>
        <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Add instructions or context..." rows={3}
          className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:bg-white transition-all resize-none"
        />
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Priority</label>
        <div className="flex gap-2">
          {(["high", "medium", "low"] as Priority[]).map(p => (
            <button key={p} type="button" onClick={() => setPriority(p)}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
                priority === p ? `${P_CFG[p].bg} ${P_CFG[p].text} ring-2 ring-current ring-offset-1` : "bg-slate-100 text-slate-400"
              }`}
            >
              {P_CFG[p].label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Due Date</label>
        <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
          className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:bg-white transition-all"
        />
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Assign To</label>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setAssigneeId(null)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${!assigneeId ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}
          >
            Self
          </button>
          {employees.map(emp => (
            <button key={emp.id} type="button" onClick={() => setAssigneeId(emp.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                assigneeId === emp.id ? "bg-indigo-50 text-indigo-700 ring-2 ring-indigo-400" : "bg-slate-100 text-slate-600"
              }`}
            >
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-black" style={{ backgroundColor: emp.color }}>
                {initials(emp.name)}
              </span>
              {emp.name.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Voice Instructions</label>
        <VoiceRecorder orgId={orgId} taskId={taskId} onRecorded={setVoice} existingUrl={voiceNoteUrl} onUploadingChange={setVoiceUploading} />
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Images</label>
        <ImagePicker images={imageUrls} onChange={setImageUrls} upload={{ orgId, taskId }} onUploadingChange={setImagesUploading} />
      </div>
    </div>
  );
}

/* ─── AddTaskModal ────────────────────────────────────────── */
function AddTaskModal({ employees, orgId, defaultAssigneeId, assignLabel, onAdd, onClose }: {
  employees: Employee[];
  orgId: string;
  defaultAssigneeId?: string | null;
  assignLabel?: string;
  onAdd: (t: Omit<Task, "createdAt" | "comments" | "order">) => void;
  onClose: () => void;
}) {
  // Generated up front so voice/image uploads have a stable path
  // ({org_id}/{task_id}/...) to land in before the task row exists —
  // this same id is then used as the row's primary key on insert.
  const [taskId]                    = useState(() => crypto.randomUUID());
  const [title, setTitle]           = useState("");
  const [desc, setDesc]             = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(defaultAssigneeId ?? null);
  const [priority, setPriority]     = useState<Priority>("medium");
  const [dueDate, setDueDate]       = useState(() => addDays(getToday(), 3).toISOString().slice(0, 10));
  const [voiceNoteUrl, setVoice]    = useState<string | null>(null);
  const [imageUrls, setImageUrls]   = useState<string[]>([]);
  const [mediaUploading, setMediaUploading] = useState(false);

  const hasContent = !!title.trim() || !!voiceNoteUrl || imageUrls.length > 0;

  const submit = () => {
    if (!hasContent || mediaUploading) return;
    const finalTitle = title.trim() || (voiceNoteUrl ? "Voice note task" : "Image task");
    onAdd({ id: taskId, title: finalTitle, description: desc, assigneeId, createdById: defaultAssigneeId ?? null, priority, dueDate, voiceNoteUrl, imageUrls });
    onClose();
  };

  const assigneeName = employees.find(e => e.id === assigneeId)?.name.split(" ")[0];

  return (
    <BottomSheet onClose={onClose}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-shrink-0">
        <div>
          <h2 className="text-base font-bold text-slate-800">New Task</h2>
          {assignLabel && <p className="text-[11px] text-slate-400 font-medium mt-0.5">{assignLabel}</p>}
        </div>
        <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
          <X size={15} className="text-slate-500" />
        </button>
      </div>
      <div className="overflow-y-auto flex-1 p-5 pb-6" style={{ scrollbarWidth: "none" }}>
        <TaskFormFields
          title={title} setTitle={setTitle}
          desc={desc} setDesc={setDesc}
          priority={priority} setPriority={setPriority}
          dueDate={dueDate} setDueDate={setDueDate}
          assigneeId={assigneeId} setAssigneeId={setAssigneeId}
          voiceNoteUrl={voiceNoteUrl} setVoice={setVoice}
          imageUrls={imageUrls} setImageUrls={setImageUrls}
          employees={employees} requireTitle={false}
          orgId={orgId} taskId={taskId} onUploadingChange={setMediaUploading}
        />
        <button type="button" onClick={submit} disabled={!hasContent || mediaUploading}
          className="w-full mt-5 bg-indigo-600 text-white py-4 rounded-2xl text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-700 active:bg-indigo-800 transition-colors shadow-lg shadow-indigo-600/20"
        >
          {mediaUploading ? "Uploading…" : assigneeName ? `Create & Notify ${assigneeName}` : "Create Task"}
        </button>
      </div>
    </BottomSheet>
  );
}

/* ─── EditTaskModal ───────────────────────────────────────── */
function EditTaskModal({ task, employees, orgId, canEdit, onSave, onDelete, onCloseTask, onReopen, onClose }: {
  task: Task;
  employees: Employee[];
  orgId: string;
  canEdit: boolean;
  onSave: (updated: Task) => void;
  onDelete: (id: string) => void;
  onCloseTask: (id: string) => void;
  onReopen: (id: string, newAssigneeId: string | null) => void;
  onClose: () => void;
}) {
  const [mode, setMode]             = useState<"view" | "edit">("view");
  const [title, setTitle]           = useState(task.title);
  const [desc, setDesc]             = useState(task.description);
  const [assigneeId, setAssigneeId] = useState<string | null>(task.assigneeId);
  const [priority, setPriority]     = useState<Priority>(task.priority);
  const [dueDate, setDueDate]       = useState(task.dueDate);
  const [voiceNoteUrl, setVoice]    = useState<string | null>(task.voiceNoteUrl);
  const [imageUrls, setImageUrls]   = useState<string[]>(task.imageUrls);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [reopenPickerOpen, setReopenPickerOpen] = useState(false);

  const assignee = employees.find(e => e.id === task.assigneeId);
  const done = isFinished(task.status);

  const startEdit = () => {
    setTitle(task.title);
    setDesc(task.description);
    setAssigneeId(task.assigneeId);
    setPriority(task.priority);
    setDueDate(task.dueDate);
    setVoice(task.voiceNoteUrl);
    setImageUrls(task.imageUrls);
    setMode("edit");
  };

  const cancel = () => setMode("view");

  const save = () => {
    if (!title.trim() || mediaUploading) return;
    onSave({ ...task, title, description: desc, assigneeId, priority, dueDate, voiceNoteUrl, imageUrls });
    setMode("view");
  };

  const handleDelete = () => {
    onDelete(task.id);
    onClose();
  };

  return (
    <>
    <BottomSheet onClose={onClose}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-shrink-0">
        <h2 className="text-base font-bold text-slate-800">{mode === "edit" ? "Edit Task" : "Task Details"}</h2>
        <div className="flex items-center gap-2">
          {canEdit && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center"
            >
              <Trash2 size={14} className="text-red-500" />
            </button>
          )}
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
            <X size={15} className="text-slate-500" />
          </button>
        </div>
      </div>

      {confirmDelete ? (
        <div className="p-6 flex flex-col items-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center">
            <Trash2 size={24} className="text-red-500" />
          </div>
          <div>
            <p className="font-bold text-slate-800 text-base">Delete this task?</p>
            <p className="text-sm text-slate-400 mt-1 leading-relaxed">
              "{task.title}" will be permanently removed.
            </p>
          </div>
          <div className="flex gap-3 w-full">
            <button onClick={() => setConfirmDelete(false)}
              className="flex-1 py-3.5 rounded-2xl text-sm font-bold bg-slate-100 text-slate-600"
            >
              Cancel
            </button>
            <button onClick={handleDelete}
              className="flex-1 py-3.5 rounded-2xl text-sm font-bold bg-red-500 text-white"
            >
              Delete
            </button>
          </div>
        </div>
      ) : mode === "view" ? (
        <div className="overflow-y-auto flex-1 p-5 pb-6 space-y-5" style={{ scrollbarWidth: "none" }}>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full tracking-wide ${P_CFG[task.priority].bg} ${P_CFG[task.priority].text}`}>{P_CFG[task.priority].label}</span>
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${S_CFG[task.status].bg} ${S_CFG[task.status].text}`}>{S_CFG[task.status].label}</span>
            </div>
            <p className={`font-bold text-lg leading-snug ${done ? "line-through text-slate-300" : "text-slate-800"}`}>{task.title}</p>
            {task.description && <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">{task.description}</p>}
            <p className={`flex items-center gap-1 text-xs font-semibold mt-2 ${isOverdue(task.dueDate, task.status) ? "text-red-500" : "text-slate-400"}`}>
              <Clock size={11} /> Due {relDate(task.dueDate)}
            </p>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Assigned To</label>
            <div className="flex items-center gap-2 bg-slate-50 rounded-xl px-3 py-2.5">
              {assignee ? (
                <span className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-black" style={{ backgroundColor: assignee.color }}>
                  {initials(assignee.name)}
                </span>
              ) : <Users size={14} className="text-slate-400" />}
              <span className="text-sm font-semibold text-slate-700">{assignee ? assignee.name : "Unassigned"}</span>
            </div>
          </div>

          {task.voiceNoteUrl && <VoiceNotePlayer path={task.voiceNoteUrl} />}

          {task.imageUrls.length > 0 && (
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                Images {task.imageUrls.length > 1 && `(${task.imageUrls.length})`}
              </label>
              <div className="flex flex-wrap gap-2">
                {task.imageUrls.map(path => (
                  <button key={path} type="button" onClick={() => setLightboxUrl(path)}
                    className="w-16 h-16 rounded-xl overflow-hidden flex-shrink-0"
                  >
                    <SignedTaskImage path={path} className="w-full h-full" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {task.status === "completed" && (
            <div className="space-y-2">
              <button type="button" onClick={() => onCloseTask(task.id)}
                className="w-full py-3.5 rounded-2xl text-sm font-bold bg-slate-800 text-white flex items-center justify-center gap-2 hover:bg-slate-900 transition-colors"
              >
                Close
              </button>
              <button type="button" onClick={() => setReopenPickerOpen(o => !o)}
                className="w-full py-3.5 rounded-2xl text-sm font-bold bg-amber-50 text-amber-700 flex items-center justify-center gap-2 hover:bg-amber-100 transition-colors"
              >
                {reopenPickerOpen ? "Cancel" : "Reopen"}
              </button>
              {reopenPickerOpen && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button"
                    onClick={() => { onReopen(task.id, task.assigneeId); setReopenPickerOpen(false); }}
                    className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                  >
                    Keep {assignee ? assignee.name.split(" ")[0] : "unassigned"}
                  </button>
                  {employees.filter(e => e.id !== task.assigneeId).map(emp => (
                    <button key={emp.id} type="button"
                      onClick={() => { onReopen(task.id, emp.id); setReopenPickerOpen(false); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                    >
                      <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-black" style={{ backgroundColor: emp.color }}>
                        {initials(emp.name)}
                      </span>
                      {emp.name.split(" ")[0]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {canEdit && (
            <button type="button" onClick={startEdit}
              className="w-full py-3.5 rounded-2xl text-sm font-bold bg-indigo-50 text-indigo-600 flex items-center justify-center gap-2 hover:bg-indigo-100 transition-colors"
            >
              <Pencil size={14} /> Edit Task
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-y-auto flex-1 p-5 pb-6" style={{ scrollbarWidth: "none" }}>
          <TaskFormFields
            title={title} setTitle={setTitle}
            desc={desc} setDesc={setDesc}
            priority={priority} setPriority={setPriority}
            dueDate={dueDate} setDueDate={setDueDate}
            assigneeId={assigneeId} setAssigneeId={setAssigneeId}
            voiceNoteUrl={voiceNoteUrl} setVoice={setVoice}
            imageUrls={imageUrls} setImageUrls={setImageUrls}
            employees={employees} requireTitle={true}
            orgId={orgId} taskId={task.id} onUploadingChange={setMediaUploading}
          />
          <div className="flex gap-3 mt-5">
            <button type="button" onClick={cancel}
              className="flex-1 py-4 rounded-2xl text-sm font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button type="button" onClick={save} disabled={!title.trim() || mediaUploading}
              className="flex-1 bg-indigo-600 text-white py-4 rounded-2xl text-sm font-bold disabled:opacity-30 hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/20"
            >
              {mediaUploading ? "Uploading…" : "Save Changes"}
            </button>
          </div>
        </div>
      )}
    </BottomSheet>

    {lightboxUrl && (
      <div
        className="fixed inset-0 z-[70] bg-black/85 flex items-center justify-center p-6"
        onClick={() => setLightboxUrl(null)}
      >
        <SignedTaskImage path={lightboxUrl} className="max-w-full max-h-full rounded-2xl" fit="contain" />
        <button
          type="button"
          onClick={() => setLightboxUrl(null)}
          className="absolute top-5 right-5 w-9 h-9 rounded-full bg-white/10 flex items-center justify-center"
        >
          <X size={18} className="text-white" />
        </button>
      </div>
    )}
    </>
  );
}

/* ─── SwipeableTaskCard ───────────────────────────────────── */
function SwipeCard({
  task, employees, onDelete, onEdit, onVoicePlay
}: {
  task: Task;
  employees: Employee[];
  onDelete: (id: string) => void;
  onEdit: (task: Task) => void;
  onVoicePlay?: (url: string) => void;
}) {
  const [swipeX, setSwipeX] = useState(0);
  const dragging = useRef(false);
  const startX = useRef(0);
  const totalMove = useRef(0);
  const THRESH = 72;

  const assignee = employees.find(e => e.id === task.assigneeId);
  const p = P_CFG[task.priority];
  const s = S_CFG[task.status];

  const onDown = (e: React.PointerEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    totalMove.current = 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - startX.current;
    totalMove.current = Math.abs(delta);
    // Status transitions now happen only via the guarded action buttons in
    // the task detail view — swipe here is delete-only.
    setSwipeX(Math.max(-110, Math.min(0, delta)));
  };
  const onUp = () => {
    if (totalMove.current < 8) {
      // tap — open detail
      onEdit(task);
    } else if (swipeX < -THRESH) {
      onDelete(task.id);
    }
    setSwipeX(0);
    dragging.current = false;
  };

  const showLeft  = swipeX < -18;

  return (
    <div className="relative mb-3 rounded-2xl overflow-hidden" style={{ minHeight: 96 }}>
      <div className={`absolute inset-0 flex items-center justify-end pr-5 bg-red-400 rounded-2xl transition-opacity duration-100 ${showLeft ? "opacity-100" : "opacity-0"}`}>
        <span className="text-white text-sm font-bold mr-2">Delete</span>
        <Trash2 size={18} className="text-white" />
      </div>

      <div
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: dragging.current ? "none" : "transform 0.28s cubic-bezier(0.34,1.56,0.64,1)",
          touchAction: "pan-y",
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="bg-white rounded-2xl shadow-[0_1px_6px_rgba(15,23,42,0.07)] select-none cursor-grab active:cursor-grabbing"
      >
        <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl ${p.strip}`} />

        <div className="p-4 pl-5">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full tracking-wide ${p.bg} ${p.text}`}>{p.label}</span>
                {task.voiceNoteUrl && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onVoicePlay?.(task.voiceNoteUrl!); }}
                    className="flex items-center gap-1 text-[11px] text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full font-semibold"
                  >
                    <Volume2 size={10} /> Voice
                  </button>
                )}
              </div>
              <p className={`font-bold text-[13px] leading-snug ${isFinished(task.status) ? "line-through text-slate-300" : "text-slate-800"}`}>
                {task.title}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1 leading-relaxed">{task.description}</p>
            </div>

            <div className="flex flex-col items-end gap-2 flex-shrink-0">
              <div className="flex items-center gap-1.5">
                {assignee ? (
                  <>
                    <span className="text-[11px] font-semibold text-slate-600 max-w-[88px] truncate text-right leading-tight">
                      {assignee.name}
                    </span>
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold ring-2 ring-white flex-shrink-0" style={{ backgroundColor: assignee.color }}>
                      {initials(assignee.name)}
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-[11px] font-semibold text-slate-400">Self</span>
                    <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Users size={12} className="text-slate-400" />
                    </div>
                  </>
                )}
              </div>
              {/* Edit hint */}
              <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center">
                <Pencil size={10} className="text-slate-400" />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between mt-3">
            <span className={`flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full ${s.bg} ${s.text}`}>
              {isFinished(task.status) ? <Check size={11} strokeWidth={3} /> : (task.status === "accepted" || task.status === "working") ? <TrendingUp size={11} /> : <Clock size={11} />}
              {s.label}
            </span>
            <span className={`flex items-center gap-1 text-[11px] font-semibold ${isOverdue(task.dueDate, task.status) ? "text-red-500" : "text-slate-400"}`}>
              <Clock size={10} />{relDate(task.dueDate)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── DashboardView ───────────────────────────────────────── */
function DashboardView({ tasks, employees, userName, onView, onSelectMember, onOpenTask }: {
  tasks: Task[]; employees: Employee[]; userName: string; onView: (v: View) => void;
  onSelectMember: (id: string) => void; onOpenTask: (task: Task) => void;
}) {
  const counts = {
    inProgress: tasks.filter(t => isInProgress(t.status)).length,
    done:       tasks.filter(t => isFinished(t.status)).length,
    overdue:    tasks.filter(t => isOverdue(t.dueDate, t.status)).length,
    todo:       tasks.filter(t => isNotYetStarted(t.status)).length,
    total:      tasks.length,
  };
  const activeTasks = tasks.filter(t => !isFinished(t.status)).slice(0, 4);

  return (
    <div className="p-5">
      <div className="mb-6">
        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{format(new Date(), "EEEE, MMMM d, yyyy")}</p>
        <h1 className="text-2xl font-black text-slate-800 mt-1 leading-tight">Good morning,<br />{userName.split(" ")[0]} 👋</h1>
        <p className="text-sm text-slate-500 mt-2 leading-relaxed">Here's your team's progress today.</p>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-5">
        <div className="bg-indigo-600 rounded-xl p-3">
          <p className="text-2xl font-black text-white leading-none">{counts.inProgress}</p>
          <p className="text-[10px] font-bold text-indigo-200 mt-0.5">In Progress</p>
        </div>
        <div className="bg-emerald-500 rounded-xl p-3">
          <p className="text-2xl font-black text-white leading-none">{counts.done}</p>
          <p className="text-[10px] font-bold text-emerald-100 mt-0.5">Completed</p>
        </div>
        <div className={`rounded-xl p-3 ${counts.overdue > 0 ? "bg-red-500" : "bg-slate-700"}`}>
          <p className="text-2xl font-black text-white leading-none">{counts.overdue > 0 ? counts.overdue : counts.todo}</p>
          <p className={`text-[10px] font-bold mt-0.5 ${counts.overdue > 0 ? "text-red-100" : "text-slate-300"}`}>
            {counts.overdue > 0 ? "Overdue" : "To Do"}
          </p>
        </div>
        <div className="bg-amber-400 rounded-xl p-3">
          <p className="text-2xl font-black text-white leading-none">{counts.total}</p>
          <p className="text-[10px] font-bold text-amber-100 mt-0.5">Total Tasks</p>
        </div>
      </div>

      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-black text-slate-700 uppercase tracking-wide">Team</h2>
          <button onClick={() => onView("settings")} className="text-xs font-bold text-indigo-500 flex items-center gap-0.5">
            Manage <ChevronRight size={13} />
          </button>
        </div>
        <div className="space-y-2">
          {employees.map(emp => {
            const empTasks = tasks.filter(t => t.assigneeId === emp.id);
            const done = empTasks.filter(t => isFinished(t.status)).length;
            const pct = empTasks.length ? (done / empTasks.length) * 100 : 0;
            return (
              <button key={emp.id} type="button" onClick={() => onSelectMember(emp.id)}
                className="w-full text-left bg-white rounded-2xl p-3.5 flex items-center gap-3 shadow-[0_1px_6px_rgba(15,23,42,0.06)] hover:shadow-[0_1px_6px_rgba(15,23,42,0.1)] active:scale-[0.99] transition-all"
              >
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-xs font-black flex-shrink-0" style={{ backgroundColor: emp.color }}>
                  {initials(emp.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center">
                    <p className="text-sm font-bold text-slate-800 truncate">{emp.name}</p>
                    <span className="text-[11px] font-semibold text-slate-400 ml-2 flex-shrink-0">{done}/{empTasks.length}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-400 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-[10px] text-slate-400 font-semibold flex-shrink-0 truncate max-w-[70px]">{emp.role}</p>
                  </div>
                </div>
                <ChevronRight size={15} className="text-slate-300 flex-shrink-0" />
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-black text-slate-700 uppercase tracking-wide">Active Tasks</h2>
          <button onClick={() => onView("tasks")} className="text-xs font-bold text-indigo-500 flex items-center gap-0.5">
            All <ChevronRight size={13} />
          </button>
        </div>
        {activeTasks.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
            <p className="text-sm text-slate-400 font-medium">No active tasks — great work!</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeTasks.map(task => {
              const p = P_CFG[task.priority];
              const s = S_CFG[task.status];
              const emp = employees.find(e => e.id === task.assigneeId);
              return (
                <button key={task.id} type="button" onClick={() => onOpenTask(task)}
                  className="w-full text-left bg-white rounded-2xl px-4 py-3.5 shadow-[0_1px_6px_rgba(15,23,42,0.06)] hover:shadow-[0_1px_6px_rgba(15,23,42,0.1)] active:scale-[0.99] transition-all flex items-center gap-3"
                >
                  <div className={`w-1 h-9 rounded-full flex-shrink-0 ${p.strip}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-slate-800 truncate">{task.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-[11px] font-semibold ${s.text}`}>{s.label}</span>
                      <span className="text-slate-200">·</span>
                      <span className={`text-[11px] font-semibold ${isOverdue(task.dueDate, task.status) ? "text-red-500" : "text-slate-400"}`}>{relDate(task.dueDate)}</span>
                    </div>
                  </div>
                  {emp ? (
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-black flex-shrink-0" style={{ backgroundColor: emp.color }}>
                      {initials(emp.name)}
                    </div>
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Users size={12} className="text-slate-400" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── TeamMemberPage ──────────────────────────────────────── */
function TeamMemberPage({ employee, tasks, onBack, onOpenTask }: {
  employee: Employee;
  tasks: Task[];
  onBack: () => void;
  onOpenTask: (task: Task) => void;
}) {
  const empTasks = tasks.filter(t => t.assigneeId === employee.id)
    .slice()
    .sort((a, b) => isFinished(a.status) && !isFinished(b.status) ? 1 : !isFinished(a.status) && isFinished(b.status) ? -1 : 0);
  const done       = empTasks.filter(t => isFinished(t.status)).length;
  const inProgress = empTasks.filter(t => isInProgress(t.status)).length;
  const todo       = empTasks.filter(t => isNotYetStarted(t.status)).length;
  const overdue    = empTasks.filter(t => isOverdue(t.dueDate, t.status)).length;
  const pct = empTasks.length ? (done / empTasks.length) * 100 : 0;

  return (
    <div className="absolute inset-0 bg-[#EEF0F7] z-30 flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-slate-100 flex-shrink-0">
        <button onClick={onBack} className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
          <ChevronLeft size={17} className="text-slate-600" />
        </button>
        <h1 className="text-base font-bold text-slate-800">Team Member</h1>
      </div>

      <div className="flex-1 overflow-y-auto hide-scroll p-5">
        {/* Profile */}
        <div className="bg-indigo-600 rounded-2xl p-5 mb-5 flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center text-white text-xl font-black flex-shrink-0">
            {initials(employee.name)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-lg font-black text-white truncate">{employee.name}</p>
            <p className="text-xs text-indigo-200 font-semibold">{employee.role}</p>
            <p className="text-[11px] text-indigo-200/80 font-medium mt-0.5 truncate">{employee.email}</p>
          </div>
        </div>

        {/* Progress */}
        <div className="bg-white rounded-2xl p-4 mb-5 shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold text-slate-500">Overall Progress</p>
            <p className="text-xs font-black text-slate-800">{done}/{empTasks.length} done</p>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-400 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-2 mt-4">
            <div className="bg-indigo-50 rounded-xl p-2.5 text-center">
              <p className="text-lg font-black text-indigo-600 leading-none">{inProgress}</p>
              <p className="text-[9px] font-bold text-indigo-400 mt-1 uppercase tracking-wide">In Progress</p>
            </div>
            <div className="bg-slate-100 rounded-xl p-2.5 text-center">
              <p className="text-lg font-black text-slate-600 leading-none">{todo}</p>
              <p className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-wide">To Do</p>
            </div>
            <div className={`rounded-xl p-2.5 text-center ${overdue > 0 ? "bg-red-50" : "bg-emerald-50"}`}>
              <p className={`text-lg font-black leading-none ${overdue > 0 ? "text-red-500" : "text-emerald-500"}`}>{overdue > 0 ? overdue : done}</p>
              <p className={`text-[9px] font-bold mt-1 uppercase tracking-wide ${overdue > 0 ? "text-red-400" : "text-emerald-400"}`}>{overdue > 0 ? "Overdue" : "Done"}</p>
            </div>
          </div>
        </div>

        {/* Assigned tasks */}
        <div>
          <h2 className="text-sm font-black text-slate-700 uppercase tracking-wide mb-3">
            Assigned Tasks {empTasks.length > 0 && `(${empTasks.length})`}
          </h2>
          {empTasks.length === 0 ? (
            <div className="bg-white rounded-2xl p-8 text-center shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
              <p className="text-sm text-slate-400 font-medium">No tasks assigned yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {empTasks.map(task => {
                const p = P_CFG[task.priority];
                const s = S_CFG[task.status];
                return (
                  <button key={task.id} type="button" onClick={() => onOpenTask(task)}
                    className="w-full text-left bg-white rounded-2xl px-4 py-3.5 shadow-[0_1px_6px_rgba(15,23,42,0.06)] hover:shadow-[0_1px_6px_rgba(15,23,42,0.1)] active:scale-[0.99] transition-all flex items-center gap-3"
                  >
                    <div className={`w-1 h-9 rounded-full flex-shrink-0 ${p.strip}`} />
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-bold truncate ${isFinished(task.status) ? "line-through text-slate-300" : "text-slate-800"}`}>{task.title}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-[11px] font-semibold ${s.text}`}>{s.label}</span>
                        <span className="text-slate-200">·</span>
                        <span className={`text-[11px] font-semibold ${isOverdue(task.dueDate, task.status) ? "text-red-500" : "text-slate-400"}`}>{relDate(task.dueDate)}</span>
                      </div>
                    </div>
                    <ChevronRight size={15} className="text-slate-300 flex-shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── TasksView ───────────────────────────────────────────── */
type TaskBucket = "all" | "todo" | "active" | "done";
// Collapses the 6-state lifecycle onto the 3 filter tabs this view has
// always had — same bucketing as the dashboard stats.
const inBucket = (t: Task, b: TaskBucket) =>
  b === "all" ? true : b === "todo" ? isNotYetStarted(t.status) : b === "active" ? isInProgress(t.status) : isFinished(t.status);

function TasksView({ tasks, employees, loading, onDelete, onEdit }: {
  tasks: Task[];
  employees: Employee[];
  loading: boolean;
  onDelete: (id: string) => void;
  onEdit: (task: Task) => void;
}) {
  const [filter, setFilter] = useState<TaskBucket>("all");
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);

  const filtered = tasks.filter(t => inBucket(t, filter));
  const activeFiltered = filtered.filter(t => !isFinished(t.status));
  const doneFiltered = filtered.filter(t => isFinished(t.status));
  const tabs: { id: TaskBucket; label: string }[] = [
    { id: "all", label: "All" },
    { id: "todo", label: "To Do" },
    { id: "active", label: "Active" },
    { id: "done", label: "Done" },
  ];

  const handleVoicePlay = async (path: string) => {
    if (playingUrl === path) { audioEl.current?.pause(); setPlayingUrl(null); return; }
    audioEl.current?.pause();
    const url = await resolveSignedUrl(path);
    if (!url) return;
    const a = new Audio(url);
    a.onended = () => setPlayingUrl(null);
    a.play();
    audioEl.current = a;
    setPlayingUrl(path);
  };

  return (
    <div className="p-5">
      <div className="mb-4">
        <h1 className="text-xl font-black text-slate-800">Tasks</h1>
        <p className="text-[11px] text-slate-400 mt-0.5 font-medium">Tap to view · Swipe left to delete</p>
      </div>

      <div className="flex gap-2 mb-5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {tabs.map(tab => {
          const cnt = tasks.filter(t => inBucket(t, tab.id)).length;
          return (
            <button key={tab.id} onClick={() => setFilter(tab.id)}
              className={`flex-shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                filter === tab.id
                  ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20"
                  : "bg-white text-slate-500 shadow-[0_1px_4px_rgba(15,23,42,0.06)]"
              }`}
            >
              {tab.label}
              <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${filter === tab.id ? "bg-white/20" : "bg-slate-100 text-slate-400"}`}>
                {cnt}
              </span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl p-10 text-center shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
          <Loader2 size={18} className="text-indigo-300 animate-spin mx-auto" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl p-10 text-center shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
          <p className="text-sm text-slate-400 font-medium">{tasks.length === 0 ? "No tasks yet." : "No tasks here yet."}</p>
        </div>
      ) : (
        <>
          {activeFiltered.map(task => (
            <SwipeCard
              key={task.id}
              task={task}
              employees={employees}
              onDelete={onDelete}
              onEdit={onEdit}
              onVoicePlay={handleVoicePlay}
            />
          ))}
          {activeFiltered.length > 0 && doneFiltered.length > 0 && (
            <h2 className="text-sm font-black text-slate-700 uppercase tracking-wide mb-2 mt-1">Done</h2>
          )}
          {doneFiltered.map(task => (
            <SwipeCard
              key={task.id}
              task={task}
              employees={employees}
              onDelete={onDelete}
              onEdit={onEdit}
              onVoicePlay={handleVoicePlay}
            />
          ))}
        </>
      )}
    </div>
  );
}

/* ─── InviteEmployeeCard ──────────────────────────────────── */
function InviteEmployeeCard({ orgId, onInvited }: { orgId: string; onInvited: () => void }) {
  const [email, setEmail]         = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult]       = useState<{ ok: boolean; msg: string } | null>(null);

  const submit = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setResult(null);
    const { error } = await supabase
      .from("memberships")
      .insert({ org_id: orgId, email: trimmed, role: "employee" });
    setSubmitting(false);
    if (error) {
      setResult({ ok: false, msg: error.message });
      return;
    }
    setResult({ ok: true, msg: `Invite created for ${trimmed}. Share the app link with them manually — they'll set their password on first sign-in.` });
    setEmail("");
    onInvited();
  };

  return (
    <div className="bg-white rounded-2xl shadow-[0_1px_6px_rgba(15,23,42,0.06)] p-4 mb-4">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Add Employee</p>
      <form
        className="flex items-center gap-2"
        onSubmit={e => { e.preventDefault(); submit(); }}
      >
        <input
          type="email"
          value={email}
          onChange={e => { setEmail(e.target.value); setResult(null); }}
          placeholder="employee@work.com"
          className="flex-1 bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:bg-white transition-all"
        />
        <button
          type="submit"
          disabled={!email.trim() || submitting}
          className="w-11 h-11 rounded-xl bg-indigo-600 text-white flex items-center justify-center disabled:opacity-30 hover:bg-indigo-700 transition-colors flex-shrink-0"
        >
          {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />}
        </button>
      </form>
      {result && (
        <p className={`text-xs font-semibold mt-3 leading-relaxed ${result.ok ? "text-emerald-600" : "text-red-500"}`}>
          {result.msg}
        </p>
      )}
    </div>
  );
}

/* ─── SettingsView ────────────────────────────────────────── */
function SettingsView({ tasks, employees, employeesLoading, ownerName, orgId, autoAssign, onAutoAssignChange, onInvited, onSignOut }: {
  tasks: Task[];
  employees: Employee[];
  employeesLoading: boolean;
  ownerName: string;
  orgId: string;
  autoAssign: boolean;
  onAutoAssignChange: (v: boolean) => void;
  onInvited: () => void;
  onSignOut: () => void;
}) {
  const [notifs, setNotifs]           = useState(true);
  const [voiceRec, setVoiceRec]       = useState(true);

  return (
    <div className="p-5">
      <h1 className="text-xl font-black text-slate-800 mb-5">Settings</h1>

      {/* Owner card */}
      <div className="bg-indigo-600 rounded-2xl p-4 mb-4 flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-white font-black text-lg flex-shrink-0">
          {ownerName ? ownerName[0].toUpperCase() : "?"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-black text-white truncate">{ownerName}</p>
          <p className="text-xs text-indigo-200 font-semibold">Business Owner</p>
        </div>
        <div className="flex items-center gap-1 bg-white/20 px-3 py-1.5 rounded-xl flex-shrink-0">
          <Shield size={11} className="text-white" />
          <span className="text-xs font-bold text-white">Admin</span>
        </div>
      </div>

      <InviteEmployeeCard orgId={orgId} onInvited={onInvited} />

      {/* Preferences */}
      <div className="bg-white rounded-2xl shadow-[0_1px_6px_rgba(15,23,42,0.06)] divide-y divide-slate-100 mb-4">
        {[
          { label: "Task Notifications", sub: "Alert employees on assignment", val: notifs, set: setNotifs, icon: Bell },
          { label: "Voice Instructions", sub: "Record audio notes for tasks",  val: voiceRec, set: setVoiceRec, icon: Mic },
          { label: "Auto Assign", sub: "Skip manual accept — tasks go straight to Accepted",
            val: autoAssign, set: (fn: (v: boolean) => boolean) => onAutoAssignChange(fn(autoAssign)), icon: Zap },
        ].map((item, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-4">
            <div className="w-9 h-9 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0">
              <item.icon size={15} className="text-indigo-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-bold text-slate-800">{item.label}</p>
              <p className="text-[11px] text-slate-400 font-medium">{item.sub}</p>
            </div>
            <button onClick={() => item.set((v: boolean) => !v)}
              className={`w-12 h-6 rounded-full transition-colors relative flex-shrink-0 ${item.val ? "bg-indigo-600" : "bg-slate-200"}`}
            >
              <span className="absolute top-[2px] w-5 h-5 bg-white rounded-full shadow-sm transition-all" style={{ left: item.val ? "26px" : "2px" }} />
            </button>
          </div>
        ))}
      </div>

      {/* Team */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-black text-slate-700 uppercase tracking-wide">Team Members</h2>
          {employeesLoading && <Loader2 size={13} className="text-slate-300 animate-spin" />}
        </div>

        <div className="space-y-2">
          {employees.map(emp => {
            const empTasks = tasks.filter(t => t.assigneeId === emp.id);
            const active = empTasks.filter(t => !isFinished(t.status)).length;
            return (
              <div key={emp.id} className="bg-white rounded-2xl p-4 shadow-[0_1px_6px_rgba(15,23,42,0.06)] flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-black flex-shrink-0" style={{ backgroundColor: emp.color }}>
                  {initials(emp.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-bold text-slate-800 truncate">{emp.name}</p>
                    {emp.pending && (
                      <span className="text-[9px] font-black uppercase tracking-wide bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded-full flex-shrink-0">
                        Pending
                      </span>
                    )}
                  </div>
                  {emp.email && <p className="text-[11px] text-slate-300 font-mono truncate">{emp.email}</p>}
                </div>
                {active > 0 && (
                  <span className="text-[11px] font-bold bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full flex-shrink-0">
                    {active} active
                  </span>
                )}
              </div>
            );
          })}

          {!employeesLoading && employees.length === 0 && (
            <div className="bg-white rounded-2xl p-8 text-center shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
              <Users size={24} className="text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400 font-medium">No team members yet.</p>
              <p className="text-xs text-slate-300 mt-1">Invite your first employee above.</p>
            </div>
          )}
        </div>
      </div>

      {/* App info */}
      <div className="bg-white rounded-2xl p-4 shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">About</p>
        <div className="space-y-2.5">
          {[
            { label: "App Version", val: "1.0.0" },
            { label: "Team Size",   val: `${employees.length} member${employees.length !== 1 ? "s" : ""}` },
            { label: "Total Tasks", val: String(tasks.length) },
          ].map((row, i) => (
            <div key={i} className="flex justify-between items-center">
              <span className="text-sm text-slate-600 font-medium">{row.label}</span>
              <span className="text-sm text-slate-400 font-mono">{row.val}</span>
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onSignOut}
        className="w-full flex items-center justify-center gap-2 bg-white rounded-2xl shadow-[0_1px_6px_rgba(15,23,42,0.06)] py-3.5 mt-4 text-sm font-bold text-red-500 hover:bg-red-50 transition-colors"
      >
        <LogOut size={15} /> Sign Out
      </button>
    </div>
  );
}

/* ─── EmployeeTaskCard ────────────────────────────────────── */
function EmployeeTaskCard({
  task, employees, isSelf, sortMode, canMoveUp, canMoveDown, onOpen, onMove,
}: {
  task: Task;
  employees: Employee[];
  isSelf: boolean;
  sortMode: SortMode;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onOpen: (task: Task) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const assignee = employees.find(e => e.id === task.assigneeId);
  const p = P_CFG[task.priority];
  const done = isFinished(task.status);

  return (
    <div className="flex items-stretch gap-2 mb-2.5">
      {sortMode === "custom" && (
        <div className="flex flex-col justify-center gap-1 flex-shrink-0">
          <button
            type="button" disabled={!canMoveUp} onClick={() => onMove(task.id, -1)}
            className={`w-6 h-5 rounded-md flex items-center justify-center text-[10px] font-black ${canMoveUp ? "bg-white text-slate-500 shadow-[0_1px_4px_rgba(15,23,42,0.08)]" : "text-slate-200"}`}
          >▲</button>
          <button
            type="button" disabled={!canMoveDown} onClick={() => onMove(task.id, 1)}
            className={`w-6 h-5 rounded-md flex items-center justify-center text-[10px] font-black ${canMoveDown ? "bg-white text-slate-500 shadow-[0_1px_4px_rgba(15,23,42,0.08)]" : "text-slate-200"}`}
          >▼</button>
        </div>
      )}

      <div
        onClick={() => onOpen(task)}
        className="relative flex-1 bg-white rounded-2xl shadow-[0_1px_6px_rgba(15,23,42,0.07)] p-4 pl-5 cursor-pointer"
      >
        <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl ${p.strip}`} />
        <div className="flex items-start gap-3">
          <div
            className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
              done ? "bg-emerald-500 border-emerald-500" : "border-slate-300"
            }`}
          >
            {done && <Check size={13} className="text-white" strokeWidth={3} />}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full tracking-wide ${p.bg} ${p.text}`}>{p.label}</span>
              {!isSelf && assignee && (
                <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full">
                  <Users size={10} /> {assignee.name.split(" ")[0]}
                </span>
              )}
              {task.comments.length > 0 && (
                <span className="text-[11px] font-semibold text-slate-400">💬 {task.comments.length}</span>
              )}
            </div>
            <p className={`font-bold text-[13px] leading-snug ${done ? "line-through text-slate-300" : "text-slate-800"}`}>{task.title}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`text-[11px] font-semibold ${S_CFG[task.status].text}`}>{S_CFG[task.status].label}</span>
              <span className="text-slate-200">·</span>
              <span className={`flex items-center gap-1 text-[11px] font-semibold ${isOverdue(task.dueDate, task.status) ? "text-red-500" : "text-slate-400"}`}>
                <Clock size={10} />{relDate(task.dueDate)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── EmployeeTasksView ───────────────────────────────────── */
function EmployeeTasksView({ tasks, employees, currentEmployeeId, loading, onReorder, onOpenTask }: {
  tasks: Task[];
  employees: Employee[];
  currentEmployeeId: string;
  loading: boolean;
  onReorder: (assigneeId: string | null, orderedIds: string[]) => void;
  onOpenTask: (task: Task) => void;
}) {
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const me = employees.find(e => e.id === currentEmployeeId);
  const myTasks = tasks.filter(t => t.assigneeId === currentEmployeeId);

  const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...myTasks].sort((a, b) => {
    if (isFinished(a.status) && !isFinished(b.status)) return 1;
    if (isFinished(b.status) && !isFinished(a.status)) return -1;
    if (sortMode === "priority") return priorityRank[a.priority] - priorityRank[b.priority];
    if (sortMode === "dueDate") return a.dueDate.localeCompare(b.dueDate);
    return a.order - b.order; // custom
  });
  const activeSorted = sorted.filter(t => !isFinished(t.status));
  const doneSorted = sorted.filter(t => isFinished(t.status));

  const move = (id: string, dir: -1 | 1) => {
    const ids = sorted.map(t => t.id);
    const idx = ids.indexOf(id);
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= ids.length) return;
    [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
    onReorder(currentEmployeeId, ids);
  };

  const sortTabs: { id: SortMode; label: string }[] = [
    { id: "priority", label: "Priority" },
    { id: "dueDate",  label: "Due Date" },
    { id: "custom",   label: "My Order" },
  ];

  return (
    <div className="p-5">
      <div className="mb-4">
        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{format(new Date(), "EEEE, MMMM d, yyyy")}</p>
        <h1 className="text-xl font-black text-slate-800 mt-1">
          {me ? `${me.name.split(" ")[0]}'s Tasks` : "My Tasks"}
        </h1>
        <p className="text-[11px] text-slate-400 mt-0.5 font-medium">Tap a task for details, comments & reassignment</p>
      </div>

      <div className="flex gap-2 mb-4">
        {sortTabs.map(tab => (
          <button key={tab.id} onClick={() => setSortMode(tab.id)}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
              sortMode === tab.id ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20" : "bg-white text-slate-500 shadow-[0_1px_4px_rgba(15,23,42,0.06)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {sortMode === "custom" && (
        <p className="text-[11px] text-indigo-400 font-semibold mb-3 -mt-1">Use ▲▼ to arrange tasks in your own order</p>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl p-10 text-center shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
          <Loader2 size={18} className="text-indigo-300 animate-spin mx-auto" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="bg-white rounded-2xl p-10 text-center shadow-[0_1px_6px_rgba(15,23,42,0.06)]">
          <p className="text-sm text-slate-400 font-medium">No tasks assigned to you yet.</p>
        </div>
      ) : (
        <>
          {activeSorted.map(task => {
            const i = sorted.indexOf(task);
            return (
              <EmployeeTaskCard
                key={task.id}
                task={task}
                employees={employees}
                isSelf
                sortMode={sortMode}
                canMoveUp={i > 0}
                canMoveDown={i < sorted.length - 1}
                onOpen={onOpenTask}
                onMove={move}
              />
            );
          })}
          {activeSorted.length > 0 && doneSorted.length > 0 && (
            <h2 className="text-sm font-black text-slate-700 uppercase tracking-wide mb-2.5 mt-1">Done</h2>
          )}
          {doneSorted.map(task => {
            const i = sorted.indexOf(task);
            return (
              <EmployeeTaskCard
                key={task.id}
                task={task}
                employees={employees}
                isSelf
                sortMode={sortMode}
                canMoveUp={i > 0}
                canMoveDown={i < sorted.length - 1}
                onOpen={onOpenTask}
                onMove={move}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

/* ─── EmployeeTaskModal (detail + comments + reassign) ────── */
function EmployeeTaskModal({ task, employees, orgId, currentEmployeeId, canEdit, onAccept, onStart, onComplete, onReopen, onReassign, onAddComment, onSave, onClose }: {
  task: Task;
  employees: Employee[];
  orgId: string;
  currentEmployeeId: string;
  canEdit: boolean;
  onAccept: (id: string) => void;
  onStart: (id: string) => void;
  onComplete: (id: string) => void;
  onReopen: (id: string, newAssigneeId: string | null) => void;
  onReassign: (taskId: string, newAssigneeId: string) => void;
  onAddComment: (taskId: string, authorId: string, text: string, imageUrls?: string[]) => void;
  onSave: (updated: Task) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [commentText, setCommentText] = useState("");
  const [commentImages, setCommentImages] = useState<string[]>([]);
  const commentFileInput = useRef<HTMLInputElement | null>(null);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reopenPickerOpen, setReopenPickerOpen] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [title, setTitle]           = useState(task.title);
  const [desc, setDesc]             = useState(task.description);
  const [assigneeId, setAssigneeId] = useState<string | null>(task.assigneeId);
  const [priority, setPriority]     = useState<Priority>(task.priority);
  const [dueDate, setDueDate]       = useState(task.dueDate);
  const [voiceNoteUrl, setVoice]    = useState<string | null>(task.voiceNoteUrl);
  const [imageUrls, setImageUrls]   = useState<string[]>(task.imageUrls);
  const [mediaUploading, setMediaUploading] = useState(false);
  const assignee = employees.find(e => e.id === task.assigneeId);
  const done = isFinished(task.status);
  const peers = employees.filter(e => e.id !== task.assigneeId);
  const isAssignee = currentEmployeeId === task.assigneeId;
  const isCreator = currentEmployeeId === task.createdById;

  const submitComment = () => {
    if (!commentText.trim() && commentImages.length === 0) return;
    onAddComment(task.id, currentEmployeeId, commentText, commentImages);
    setCommentText("");
    setCommentImages([]);
  };

  const startEdit = () => {
    setTitle(task.title);
    setDesc(task.description);
    setAssigneeId(task.assigneeId);
    setPriority(task.priority);
    setDueDate(task.dueDate);
    setVoice(task.voiceNoteUrl);
    setImageUrls(task.imageUrls);
    setMode("edit");
  };

  const cancelEdit = () => setMode("view");

  const saveEdit = () => {
    if (!title.trim() || mediaUploading) return;
    onSave({ ...task, title, description: desc, assigneeId, priority, dueDate, voiceNoteUrl, imageUrls });
    setMode("view");
  };

  return (
    <>
    <BottomSheet onClose={onClose}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-shrink-0">
        <h2 className="text-base font-bold text-slate-800">{mode === "edit" ? "Edit Task" : "Task Details"}</h2>
        <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
          <X size={15} className="text-slate-500" />
        </button>
      </div>

      {mode === "edit" ? (
        <div className="overflow-y-auto flex-1 p-5 pb-6" style={{ scrollbarWidth: "none" }}>
          <TaskFormFields
            title={title} setTitle={setTitle}
            desc={desc} setDesc={setDesc}
            priority={priority} setPriority={setPriority}
            dueDate={dueDate} setDueDate={setDueDate}
            assigneeId={assigneeId} setAssigneeId={setAssigneeId}
            voiceNoteUrl={voiceNoteUrl} setVoice={setVoice}
            imageUrls={imageUrls} setImageUrls={setImageUrls}
            employees={employees} requireTitle={false}
            orgId={orgId} taskId={task.id} onUploadingChange={setMediaUploading}
          />
          <div className="flex gap-3 mt-5">
            <button type="button" onClick={cancelEdit}
              className="flex-1 py-4 rounded-2xl text-sm font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button type="button" onClick={saveEdit} disabled={!title.trim() || mediaUploading}
              className="flex-1 bg-indigo-600 text-white py-4 rounded-2xl text-sm font-bold disabled:opacity-30 hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/20"
            >
              {mediaUploading ? "Uploading…" : "Save Changes"}
            </button>
          </div>
        </div>
      ) : (
      <div className="overflow-y-auto flex-1 p-5 pb-6 space-y-5" style={{ scrollbarWidth: "none" }}>
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full tracking-wide ${P_CFG[task.priority].bg} ${P_CFG[task.priority].text}`}>{P_CFG[task.priority].label}</span>
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${S_CFG[task.status].bg} ${S_CFG[task.status].text}`}>{S_CFG[task.status].label}</span>
          </div>
          <p className={`font-bold text-lg leading-snug ${done ? "line-through text-slate-300" : "text-slate-800"}`}>{task.title}</p>
          {task.description && <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">{task.description}</p>}
          <p className={`flex items-center gap-1 text-xs font-semibold mt-2 ${isOverdue(task.dueDate, task.status) ? "text-red-500" : "text-slate-400"}`}>
            <Clock size={11} /> Due {relDate(task.dueDate)}
          </p>
        </div>

        {canEdit && (
          <button type="button" onClick={startEdit}
            className="w-full py-3.5 rounded-2xl text-sm font-bold bg-indigo-50 text-indigo-600 flex items-center justify-center gap-2 hover:bg-indigo-100 transition-colors"
          >
            <Pencil size={14} /> Edit Task
          </button>
        )}

        {/* Voice note */}
        {task.voiceNoteUrl && <VoiceNotePlayer path={task.voiceNoteUrl} />}

        {/* Images */}
        {task.imageUrls.length > 0 && (
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              Images {task.imageUrls.length > 1 && `(${task.imageUrls.length})`}
            </label>
            <div className="flex flex-wrap gap-2">
              {task.imageUrls.map(path => (
                <button key={path} type="button" onClick={() => setLightboxUrl(path)}
                  className="w-16 h-16 rounded-xl overflow-hidden flex-shrink-0"
                >
                  <SignedTaskImage path={path} className="w-full h-full" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Lifecycle action — only ever the one next step for this viewer */}
        {isAssignee && task.status === "assigned" && (
          <button type="button" onClick={() => onAccept(task.id)}
            className="w-full py-3.5 rounded-2xl text-sm font-bold bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 transition-colors"
          >
            why notch
          </button>
        )}
        {isAssignee && task.status === "accepted" && (
          <button type="button" onClick={() => onStart(task.id)}
            className="w-full py-3.5 rounded-2xl text-sm font-bold bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
          >
            <TrendingUp size={15} /> Start
          </button>
        )}
        {isAssignee && task.status === "working" && (
          <button type="button" onClick={() => onComplete(task.id)}
            className="w-full py-3.5 rounded-2xl text-sm font-bold bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 transition-colors flex items-center justify-center gap-2"
          >
            <Check size={15} strokeWidth={3} /> Mark complete
          </button>
        )}

        {/* Reopen — creator (non-admin owners see this in EditTaskModal instead) */}
        {isCreator && task.status === "completed" && (
          <div className="space-y-2">
            <button type="button" onClick={() => setReopenPickerOpen(o => !o)}
              className="w-full py-3.5 rounded-2xl text-sm font-bold bg-amber-50 text-amber-700 flex items-center justify-center gap-2 hover:bg-amber-100 transition-colors"
            >
              {reopenPickerOpen ? "Cancel" : "Reopen"}
            </button>
            {reopenPickerOpen && (
              <div className="flex flex-wrap gap-2">
                <button type="button"
                  onClick={() => { onReopen(task.id, task.assigneeId); setReopenPickerOpen(false); }}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                >
                  Keep {assignee ? assignee.name.split(" ")[0] : "unassigned"}
                </button>
                {employees.filter(e => e.id !== task.assigneeId).map(emp => (
                  <button key={emp.id} type="button"
                    onClick={() => { onReopen(task.id, emp.id); setReopenPickerOpen(false); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                  >
                    <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-black" style={{ backgroundColor: emp.color }}>
                      {initials(emp.name)}
                    </span>
                    {emp.name.split(" ")[0]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Reassign */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Assigned To</label>
            <button onClick={() => setReassignOpen(o => !o)} className="text-[11px] font-bold text-indigo-500">
              {reassignOpen ? "Cancel" : "Reassign"}
            </button>
          </div>
          <div className="flex items-center gap-2 bg-slate-50 rounded-xl px-3 py-2.5">
            {assignee ? (
              <span className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-black" style={{ backgroundColor: assignee.color }}>
                {initials(assignee.name)}
              </span>
            ) : <Users size={14} className="text-slate-400" />}
            <span className="text-sm font-semibold text-slate-700">{assignee ? assignee.name : "Self"}</span>
          </div>
          {reassignOpen && (
            <div className="flex flex-wrap gap-2 mt-2">
              {peers.map(emp => (
                <button key={emp.id} type="button"
                  onClick={() => { onReassign(task.id, emp.id); setReassignOpen(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                >
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-black" style={{ backgroundColor: emp.color }}>
                    {initials(emp.name)}
                  </span>
                  {emp.name.split(" ")[0]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Comments */}
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
            Comments {task.comments.length > 0 && `(${task.comments.length})`}
          </label>
          <div className="space-y-2.5 mb-3">
            {task.comments.length === 0 && (
              <p className="text-xs text-slate-300 font-medium">No comments yet — start the thread.</p>
            )}
            {task.comments.map(c => {
              const author = employees.find(e => e.id === c.authorId);
              return (
                <div key={c.id} className="flex items-start gap-2.5">
                  <span className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[9px] font-black flex-shrink-0 mt-0.5" style={{ backgroundColor: author?.color ?? "#94A3B8" }}>
                    {author ? initials(author.name) : "?"}
                  </span>
                  <div className="flex-1 bg-slate-50 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
                    <p className="text-[11px] font-bold text-slate-600">{author?.name ?? "Unknown"}</p>
                    {c.text && <p className="text-sm text-slate-700 mt-0.5 leading-relaxed">{c.text}</p>}
                    {c.imageUrls && c.imageUrls.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {c.imageUrls.map(url => (
                          <img key={url} src={url} alt="Attached" className="w-14 h-14 rounded-lg object-cover" />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {commentImages.length > 0 && (
            <div className="mb-2">
              <ImagePicker images={commentImages} onChange={setCommentImages} size="sm" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => commentFileInput.current?.click()}
              className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 text-slate-400 flex items-center justify-center flex-shrink-0 hover:text-indigo-500 hover:border-indigo-200 transition-colors"
            >
              <ImageIcon size={16} />
            </button>
            <input
              ref={commentFileInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={e => {
                const files = e.target.files;
                if (files && files.length) {
                  setCommentImages(imgs => [...imgs, ...Array.from(files).map(f => URL.createObjectURL(f))]);
                }
                e.target.value = "";
              }}
            />
            <input
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submitComment(); }}
              placeholder="Add a comment..."
              className="flex-1 bg-slate-50 border border-slate-100 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:bg-white transition-all"
            />
            <button type="button" onClick={submitComment} disabled={!commentText.trim() && commentImages.length === 0}
              className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center disabled:opacity-30 flex-shrink-0"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
      )}
    </BottomSheet>

    {lightboxUrl && (
      <div
        className="fixed inset-0 z-[70] bg-black/85 flex items-center justify-center p-6"
        onClick={() => setLightboxUrl(null)}
      >
        <SignedTaskImage path={lightboxUrl} className="max-w-full max-h-full rounded-2xl" fit="contain" />
        <button
          type="button"
          onClick={() => setLightboxUrl(null)}
          className="absolute top-5 right-5 w-9 h-9 rounded-full bg-white/10 flex items-center justify-center"
        >
          <X size={18} className="text-white" />
        </button>
      </div>
    )}
    </>
  );
}

/* ─── EmployeeProfileView ─────────────────────────────────── */
function EmployeeProfileView({ tasks, employees, currentEmployeeId, employeeEmail, onSignOut }: {
  tasks: Task[];
  employees: Employee[];
  currentEmployeeId: string;
  employeeEmail: string;
  onSignOut: () => void;
}) {
  const me = employees.find(e => e.id === currentEmployeeId);
  const myTasks = tasks.filter(t => t.assigneeId === currentEmployeeId);
  const done = myTasks.filter(t => isFinished(t.status)).length;

  return (
    <div className="p-5">
      <h1 className="text-xl font-black text-slate-800 mb-5">Profile</h1>

      <div className="bg-indigo-600 rounded-2xl p-4 mb-4 flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-white font-black text-lg flex-shrink-0">
          {me ? initials(me.name) : "?"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-black text-white truncate">{me?.name ?? employeeEmail}</p>
          <p className="text-xs text-indigo-200 font-semibold truncate">{me?.role ?? employeeEmail}</p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-lg font-black text-white">{done}/{myTasks.length}</p>
          <p className="text-[10px] text-indigo-200 font-semibold">done</p>
        </div>
      </div>

      <button
        type="button"
        onClick={onSignOut}
        className="w-full flex items-center justify-center gap-2 bg-white rounded-2xl shadow-[0_1px_6px_rgba(15,23,42,0.06)] py-3.5 text-sm font-bold text-red-500 hover:bg-red-50 transition-colors"
      >
        <LogOut size={15} /> Sign Out
      </button>
    </div>
  );
}

/* ─── AuthenticatedApp ────────────────────────────────────── *
 * Renders once we know the signed-in user's real role & org.
 * `employees` and `tasks` (with their comments) are both live
 * queries against Supabase. `currentEmployeeId` is the signed-in
 * user's own real membership id (from useAuth), not a guess by
 * email match or array index. */
function AuthenticatedApp({ role, orgId }: { role: AppRole; orgId: string }) {
  const { user, membershipId, membershipEmail, fullName, signOut } = useAuth();
  const [view, setView]           = useState<View>(role === "owner" ? "dashboard" : "tasks");
  const [tasks, setTasks]         = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [showAdd, setShowAdd]     = useState(false);
  const [editTask, setEditTask]   = useState<Task | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [toast, setToast]         = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoAssign, setAutoAssign] = useState(false);

  const currentEmployeeId = membershipId ?? "";

  useEffect(() => {
    let cancelled = false;
    supabase.from("organizations").select("auto_assign").eq("id", orgId).maybeSingle()
      .then(({ data }) => { if (!cancelled && data) setAutoAssign(data.auto_assign); });
    return () => { cancelled = true; };
  }, [orgId]);

  const handleAutoAssignChange = async (v: boolean) => {
    setAutoAssign(v);
    const { error } = await supabase.from("organizations").update({ auto_assign: v }).eq("id", orgId);
    if (error) { showToast(error.message); setAutoAssign(!v); }
  };

  const fetchEmployees = useCallback(async () => {
    setEmployeesLoading(true);
    const { data, error } = await supabase
      .from("memberships")
      .select("id, email, full_name, role, user_id")
      .eq("org_id", orgId)
      .eq("role", "employee")
      .order("invited_at", { ascending: true });
    if (!error && data) {
      setEmployees(data.map(toEmployee));
    }
    setEmployeesLoading(false);
  }, [orgId]);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  // Tasks + their comments, both live against Supabase. Comments are
  // fetched in a second query keyed off the task ids from the first —
  // there's no org_id on `comments` directly — and merged in client-side
  // so every task card (not just an opened one) has a real comment count.
  const fetchTasks = useCallback(async () => {
    setTasksLoading(true);
    const { data: taskRows, error: tasksError } = await supabase
      .from("tasks")
      .select("id, title, description, assignee_id, created_by, status, priority, due_date, voice_note_url, image_urls, sort_order, created_at")
      .eq("org_id", orgId)
      .order("sort_order", { ascending: true });

    if (tasksError || !taskRows) {
      setTasks([]);
      setTasksLoading(false);
      return;
    }

    const taskIds = taskRows.map(t => t.id);
    let commentsByTask = new Map<string, Comment[]>();
    if (taskIds.length > 0) {
      const { data: commentRows, error: commentsError } = await supabase
        .from("comments")
        .select("id, task_id, author_id, text, image_urls, created_at")
        .in("task_id", taskIds)
        .order("created_at", { ascending: true });
      if (!commentsError && commentRows) {
        commentsByTask = commentRows.reduce((map, c) => {
          const list = map.get(c.task_id) ?? [];
          list.push(toComment(c));
          map.set(c.task_id, list);
          return map;
        }, new Map<string, Comment[]>());
      }
    }

    setTasks(taskRows.map(t => toTask(t, commentsByTask.get(t.id) ?? [])));
    setTasksLoading(false);
  }, [orgId]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  // Cross-profile sync: whenever this tab/window regains focus, re-pull
  // tasks (and every task's comments, since they're fetched together)
  // so a change made from another signed-in device/tab shows up here
  // without needing realtime subscriptions.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") fetchTasks(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", fetchTasks);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", fetchTasks);
    };
  }, [fetchTasks]);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  // Every mutation below hits Supabase first, then re-pulls the full task
  // list (fetchTasks) so the acting user's own screen reflects the change
  // immediately — same refetch path the focus/visibility listener uses for
  // cross-profile sync. voice_note_url/image_urls store the task-media
  // Storage object PATH, never a URL — VoiceRecorder/ImagePicker upload to
  // Storage themselves and hand back the path; signed URLs are resolved
  // fresh at render time by VoiceNotePlayer/SignedTaskImage, never stored.
  const logEvent = async (taskId: string, eventType: TaskEventType, detail: Record<string, unknown> = {}) => {
    await supabase.from("task_events").insert({
      task_id: taskId,
      event_type: eventType,
      actor_id: currentEmployeeId || null,
      detail,
    });
  };

  // Guarded one-step lifecycle transitions. Each writes the new status
  // then logs a task_events row — every transition is auditable, and
  // there is no free-form status setter left anywhere in the app.
  const handleAccept = async (id: string) => {
    const { error } = await supabase.from("tasks").update({ status: "accepted" }).eq("id", id);
    if (error) { showToast(error.message); return; }
    await logEvent(id, "status_change", { from: "assigned", to: "accepted" });
    await fetchTasks();
    showToast("Accepted");
  };
  const handleStart = async (id: string) => {
    const { error } = await supabase.from("tasks").update({ status: "working" }).eq("id", id);
    if (error) { showToast(error.message); return; }
    await logEvent(id, "status_change", { from: "accepted", to: "working" });
    await fetchTasks();
    showToast("Task started");
  };
  const handleComplete = async (id: string) => {
    const { error } = await supabase.from("tasks").update({ status: "completed" }).eq("id", id);
    if (error) { showToast(error.message); return; }
    await logEvent(id, "status_change", { from: "working", to: "completed" });
    await fetchTasks();
    showToast("Marked complete!");
  };
  const handleCloseTask = async (id: string) => {
    const { error } = await supabase.from("tasks").update({ status: "closed" }).eq("id", id);
    if (error) { showToast(error.message); return; }
    await logEvent(id, "status_change", { from: "completed", to: "closed" });
    await fetchTasks();
    showToast("Task closed");
  };
  // Completed -> Assigned reopen/reassign. Not a "status_change" event —
  // logged as its own "reassigned" type per the spec. Comments and
  // attachments are untouched: this only updates status/assignee_id.
  const handleReopenReassign = async (id: string, newAssigneeId: string | null) => {
    const current = tasks.find(t => t.id === id);
    const { error } = await supabase.from("tasks").update({ status: "assigned", assignee_id: newAssigneeId }).eq("id", id);
    if (error) { showToast(error.message); return; }
    await logEvent(id, "reassigned", { from_assignee: current?.assigneeId ?? null, to_assignee: newAssigneeId });
    await fetchTasks();
    const emp = employees.find(e => e.id === newAssigneeId);
    if (emp && newAssigneeId !== current?.assigneeId) { showToast(`Reopened and reassigned to ${emp.name} 🔔`); return; }
    showToast("Task reopened");
  };
  const handleDeleteTask = async (id: string) => {
    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) { showToast(error.message); return; }
    await fetchTasks();
    showToast("Task deleted");
  };
  const handleSaveTask = async (updated: Task) => {
    const { error } = await supabase
      .from("tasks")
      .update({
        title: updated.title,
        description: updated.description,
        assignee_id: updated.assigneeId,
        status: updated.status,
        priority: updated.priority,
        due_date: updated.dueDate || null,
        voice_note_url: updated.voiceNoteUrl,
        image_urls: updated.imageUrls,
      })
      .eq("id", updated.id);
    if (error) { showToast(error.message); return; }
    await fetchTasks();
    showToast("Task saved");
  };
  const handleAddTask = async (data: Omit<Task, "status" | "createdAt" | "comments" | "order">) => {
    // Draft -> Assigned happens by creating with an assignee here (no
    // separate "save as draft" flow yet — that's the next sprint item).
    // Assigned -> Accepted is automatic when the org has auto-assign on.
    const initialStatus: TaskStatus = autoAssign ? "accepted" : "assigned";
    const { error } = await supabase.from("tasks").insert({
      id: data.id,
      org_id: orgId,
      title: data.title,
      description: data.description,
      assignee_id: data.assigneeId,
      created_by: currentEmployeeId || null,
      status: initialStatus,
      priority: data.priority,
      due_date: data.dueDate || null,
      voice_note_url: data.voiceNoteUrl,
      image_urls: data.imageUrls,
    });
    if (error) { showToast(error.message); return; }
    await fetchTasks();
    if (data.assigneeId && data.assigneeId !== currentEmployeeId) {
      const emp = employees.find(e => e.id === data.assigneeId);
      if (emp) { showToast(`Notified ${emp.name} 🔔`); return; }
    }
    showToast("Task created");
  };

  const handleAddComment = async (taskId: string, authorId: string, text: string, imageUrls?: string[]) => {
    const trimmed = text.trim();
    const hasImages = imageUrls && imageUrls.length > 0;
    if (!trimmed && !hasImages) return;
    const { error } = await supabase.from("comments").insert({
      task_id: taskId,
      author_id: authorId,
      text: trimmed,
    });
    if (error) { showToast(error.message); return; }
    await fetchTasks();
  };

  const handleReassign = async (taskId: string, newAssigneeId: string) => {
    const { error } = await supabase.from("tasks").update({ assignee_id: newAssigneeId }).eq("id", taskId);
    if (error) { showToast(error.message); return; }
    await fetchTasks();
    const emp = employees.find(e => e.id === newAssigneeId);
    showToast(emp ? `Reassigned to ${emp.name.split(" ")[0]}` : "Reassigned");
  };

  const handleReorder = async (_assigneeId: string | null, orderedIds: string[]) => {
    const results = await Promise.all(
      orderedIds.map((id, idx) => supabase.from("tasks").update({ sort_order: idx }).eq("id", id))
    );
    const failed = results.find(r => r.error);
    if (failed?.error) { showToast(failed.error.message); return; }
    await fetchTasks();
  };


  const NAV = role === "owner"
    ? [
        { id: "dashboard" as View, label: "Dashboard", Icon: LayoutDashboard },
        { id: "tasks"     as View, label: "Tasks",     Icon: ListTodo         },
        { id: "settings"  as View, label: "Settings",  Icon: Settings         },
      ]
    : [
        { id: "tasks"     as View, label: "My Tasks", Icon: ListTodo  },
        { id: "settings"  as View, label: "Profile",  Icon: Settings  },
      ];
  const myTasksCount = tasks.filter(t => t.assigneeId === currentEmployeeId && !isFinished(t.status)).length;
  const activeTasks = role === "owner" ? tasks.filter(t => !isFinished(t.status)).length : myTasksCount;

  return (
    <>
      <div className="size-full flex items-center justify-center bg-slate-300/50">
        <div className="relative w-full max-w-[430px] h-full max-h-[900px] flex flex-col bg-[#EEF0F7] overflow-hidden shadow-2xl shadow-slate-900/20">

          {/* Toast */}
          {toast && (
            <div className="absolute top-4 left-4 right-4 z-50 toast-in">
              <div className="bg-slate-800 text-white text-sm font-bold px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2">
                <Check size={15} className="text-emerald-400" strokeWidth={3} />
                {toast}
              </div>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto pb-24 hide-scroll">
            {role === "owner" && view === "dashboard" && (
              <DashboardView
                tasks={tasks} employees={employees}
                userName={fullName?.trim() || user?.email || ""}
                onView={setView}
                onSelectMember={setSelectedMemberId}
                onOpenTask={task => setEditTask(task)}
              />
            )}
            {role === "owner" && view === "tasks" && (
              <TasksView
                tasks={tasks} employees={employees} loading={tasksLoading}
                onDelete={handleDeleteTask} onEdit={setEditTask}
              />
            )}
            {role === "owner" && view === "settings" && (
              <SettingsView
                tasks={tasks} employees={employees} employeesLoading={employeesLoading}
                ownerName={fullName?.trim() || user?.email || ""}
                orgId={orgId}
                autoAssign={autoAssign}
                onAutoAssignChange={handleAutoAssignChange}
                onInvited={fetchEmployees}
                onSignOut={signOut}
              />
            )}

            {role === "employee" && view === "tasks" && (
              <EmployeeTasksView
                tasks={tasks} employees={employees}
                currentEmployeeId={currentEmployeeId}
                loading={tasksLoading}
                onReorder={handleReorder}
                onOpenTask={setEditTask}
              />
            )}
            {role === "employee" && view === "settings" && (
              <EmployeeProfileView
                tasks={tasks} employees={employees}
                currentEmployeeId={currentEmployeeId}
                employeeEmail={membershipEmail ?? user?.email ?? ""}
                onSignOut={signOut}
              />
            )}
          </div>

          {/* FAB */}
          {view !== "settings" && (
            <button
              onClick={() => setShowAdd(true)}
              className="absolute bottom-[82px] right-4 w-14 h-14 bg-indigo-600 rounded-full flex items-center justify-center z-20 shadow-xl shadow-indigo-600/35 hover:bg-indigo-700 active:scale-95 transition-all"
            >
              <Plus size={24} className="text-white" strokeWidth={2.5} />
            </button>
          )}

          {/* Bottom Nav */}
          <nav className="absolute bottom-0 left-0 right-0 bg-white border-t border-slate-100/80 flex items-center px-3 pt-2.5 pb-4 z-10">
            {NAV.map(({ id, label, Icon }) => {
              const active = view === id;
              return (
                <button key={id} onClick={() => setView(id)} className="flex-1 flex flex-col items-center gap-1 relative">
                  <div className={`relative p-2 rounded-xl transition-all ${active ? "bg-indigo-50" : ""}`}>
                    <Icon size={21} className={active ? "text-indigo-600" : "text-slate-400"} strokeWidth={active ? 2.5 : 2} />
                    {id === "tasks" && activeTasks > 0 && !active && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-white text-[9px] font-black flex items-center justify-center">
                        {activeTasks > 9 ? "9+" : activeTasks}
                      </span>
                    )}
                  </div>
                  <span className={`text-[10px] font-black transition-colors ${active ? "text-indigo-600" : "text-slate-400"}`}>
                    {label}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Team Member Page */}
          {selectedMemberId && role === "owner" && (() => {
            const member = employees.find(e => e.id === selectedMemberId);
            return member ? (
              <TeamMemberPage
                employee={member}
                tasks={tasks}
                onBack={() => setSelectedMemberId(null)}
                onOpenTask={task => setEditTask(task)}
              />
            ) : null;
          })()}
        </div>
      </div>

      {/* Modals */}
      {showAdd && (
        <AddTaskModal
          employees={employees}
          orgId={orgId}
          defaultAssigneeId={role === "employee" ? currentEmployeeId : null}
          assignLabel={role === "employee" ? "Assign to yourself or a teammate" : undefined}
          onAdd={handleAddTask}
          onClose={() => setShowAdd(false)}
        />
      )}
      {editTask && role === "owner" && (() => {
        const current = tasks.find(t => t.id === editTask.id) ?? editTask;
        return (
          <EditTaskModal
            task={current}
            employees={employees}
            orgId={orgId}
            canEdit={role === "owner" || (current.createdById === currentEmployeeId && isNotYetStarted(current.status))}
            onSave={handleSaveTask}
            onDelete={id => { handleDeleteTask(id); setEditTask(null); }}
            onCloseTask={handleCloseTask}
            onReopen={handleReopenReassign}
            onClose={() => setEditTask(null)}
          />
        );
      })()}
      {editTask && role === "employee" && (() => {
        const current = tasks.find(t => t.id === editTask.id) ?? editTask;
        return (
          <EmployeeTaskModal
            task={current}
            employees={employees}
            orgId={orgId}
            currentEmployeeId={currentEmployeeId}
            canEdit={current.createdById === currentEmployeeId && isNotYetStarted(current.status)}
            onAccept={handleAccept}
            onStart={handleStart}
            onComplete={handleComplete}
            onReopen={handleReopenReassign}
            onReassign={handleReassign}
            onAddComment={handleAddComment}
            onSave={handleSaveTask}
            onClose={() => setEditTask(null)}
          />
        );
      })()}
    </>
  );
}

/* ─── LoadingScreen ───────────────────────────────────────── */
function LoadingScreen() {
  return (
    <div className="size-full flex items-center justify-center bg-slate-300/50">
      <div className="relative w-full max-w-[430px] h-full max-h-[900px] flex items-center justify-center bg-[#EEF0F7] overflow-hidden shadow-2xl shadow-slate-900/20">
        <Loader2 size={22} className="text-indigo-400 animate-spin" />
      </div>
    </div>
  );
}

/* ─── App ─────────────────────────────────────────────────── *
 * Top-level auth gate: shows the auth screen when signed out,
 * a "no access" screen when signed in but unaffiliated with an
 * org, and the real app once we have a role + org to render it
 * with. Real role/org come from `useAuth()` — no more manual
 * "Preview App As" switcher. */
export default function App() {
  const { user, role, orgId, loading, noMembership, needsProfile } = useAuth();

  // DEBUG: fires on every render of the gate — shows the exact state combo
  // that decided which screen got shown, and whether this render happened
  // while the membership query was still in flight (loading=true) vs after
  // it resolved.
  console.log("[App gate] render", {
    loading,
    hasUser: !!user,
    userId: user?.id ?? null,
    role,
    orgId,
    noMembership,
    needsProfile,
    decision: loading ? "LoadingScreen" : !user ? "AuthScreen" : (noMembership || !role || !orgId) ? "NoOrgAccess" : needsProfile ? "CompleteProfileScreen" : "AuthenticatedApp",
  });

  return (
    <>
      <style>{`
        body { font-family: 'DM Sans', system-ui, sans-serif; }
        .hide-scroll::-webkit-scrollbar { display: none; }
        .hide-scroll { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes slideDown {
          from { transform: translateY(-12px); opacity: 0; }
          to   { transform: translateY(0);     opacity: 1; }
        }
        .toast-in { animation: slideDown 0.25s cubic-bezier(0.32,0.72,0,1) forwards; }
      `}</style>

      {loading ? (
        <LoadingScreen />
      ) : !user ? (
        <AuthScreen />
      ) : noMembership || !role || !orgId ? (
        <NoOrgAccess />
      ) : needsProfile ? (
        <CompleteProfileScreen />
      ) : (
        <AuthenticatedApp role={role} orgId={orgId} />
      )}
    </>
  );
}
