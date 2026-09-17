import { useState, useRef, useEffect, useCallback } from "react";
import {
  LayoutDashboard, ListTodo, Settings, Plus, Mic, Play, Pause,
  Clock, Users, Check, X, Volume2, StopCircle,
  Trash2, Bell, TrendingUp, ChevronRight, ChevronLeft,
  Shield, Pencil, Image as ImageIcon, LogOut, Send, Loader2
} from "lucide-react";
import { useAuth } from "./auth/AuthContext";
import AuthScreen from "./auth/AuthScreen";
import NoOrgAccess from "./auth/NoOrgAccess";
import CompleteProfileScreen from "./auth/CompleteProfileScreen";
import { supabase } from "../lib/supabase";
import { getToday } from "../lib/date";
import { format, addDays } from "date-fns";


/* ─── Types ───────────────────────────────────────────────── */
type TaskStatus = "todo" | "in-progress" | "done";
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
  "todo":        { label: "To Do",       text: "text-slate-600",   bg: "bg-slate-100"  },
  "in-progress": { label: "In Progress", text: "text-indigo-600",  bg: "bg-indigo-50"  },
  "done":        { label: "Done",        text: "text-emerald-600", bg: "bg-emerald-50" },
};
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
const isOverdue = (d: string, s: TaskStatus) => new Date(d) < getToday() && s !== "done";
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
function VoiceRecorder({ onRecorded, existingUrl }: { onRecorded: (url: string | null) => void; existingUrl?: string | null }) {
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [url, setUrl] = useState<string | null>(existingUrl ?? null);
  const [playing, setPlaying] = useState(false);
  const mr = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      mr.current = rec;
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        const blobUrl = URL.createObjectURL(blob);
        setUrl(blobUrl);
        onRecorded(blobUrl);
        stream.getTracks().forEach(t => t.stop());
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
    if (!url) return;
    if (!audioEl.current) {
      audioEl.current = new Audio(url);
      audioEl.current.onended = () => setPlaying(false);
    }
    if (playing) { audioEl.current.pause(); setPlaying(false); }
    else { audioEl.current.play(); setPlaying(true); }
  };

  const clear = () => {
    audioEl.current?.pause();
    setUrl(null); setSecs(0); setPlaying(false);
    onRecorded(null);
  };

  if (url) {
    return (
      <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3">
        <button type="button" onClick={togglePlay} className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm">
          {playing ? <Pause size={13} className="text-white" /> : <Play size={13} className="text-white ml-0.5" />}
        </button>
        <div className="flex-1">
          <p className="text-xs font-semibold text-indigo-700">Voice note</p>
          <p className="text-[11px] text-indigo-400 font-mono">{fmtTime(secs)} · tap to play</p>
        </div>
        <button type="button" onClick={clear} className="text-slate-300 hover:text-red-400 transition-colors">
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
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
  );
}

/* ─── ImagePicker ─────────────────────────────────────────── */
function ImagePicker({ images, onChange, size = "md" }: { images: string[]; onChange: (urls: string[]) => void; size?: "md" | "sm" }) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const dim = size === "sm" ? "w-12 h-12" : "w-16 h-16";

  const handleFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    const urls = Array.from(files).map(f => URL.createObjectURL(f));
    onChange([...images, ...urls]);
  };

  const remove = (url: string) => onChange(images.filter(u => u !== url));

  return (
    <div className="flex flex-wrap gap-2">
      {images.map(url => (
        <div key={url} className={`relative ${dim} rounded-xl overflow-hidden flex-shrink-0 bg-slate-100`}>
          <img src={url} alt="Attached" className="w-full h-full object-cover" />
          <button type="button" onClick={() => remove(url)}
            className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center"
          >
            <X size={11} className="text-white" />
          </button>
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
  );
}

/* ─── VoiceNotePlayer (read-only playback) ────────────────── */
function VoiceNotePlayer({ url }: { url: string }) {
  const [playing, setPlaying] = useState(false);
  const audioEl = useRef<HTMLAudioElement | null>(null);

  const toggle = () => {
    if (!audioEl.current) {
      audioEl.current = new Audio(url);
      audioEl.current.onended = () => setPlaying(false);
    }
    if (playing) { audioEl.current.pause(); setPlaying(false); }
    else { audioEl.current.play(); setPlaying(true); }
  };

  return (
    <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3">
      <button type="button" onClick={toggle} className="w-9 h-9 bg-indigo-600 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm">
        {playing ? <Pause size={14} className="text-white" /> : <Play size={14} className="text-white ml-0.5" />}
      </button>
      <div className="flex-1">
        <p className="text-xs font-semibold text-indigo-700">Voice instructions</p>
        <p className="text-[11px] text-indigo-400 font-medium">{playing ? "Playing…" : "Tap to listen"}</p>
      </div>
      <Volume2 size={15} className="text-indigo-300 flex-shrink-0" />
    </div>
  );
}

/* ─── TaskFormFields (shared by Add + Edit) ───────────────── */
function TaskFormFields({
  title, setTitle, desc, setDesc, priority, setPriority,
  dueDate, setDueDate, assigneeId, setAssigneeId, status, setStatus,
  voiceNoteUrl, setVoice, imageUrls, setImageUrls, employees, showStatus,
}: {
  title: string; setTitle: (v: string) => void;
  desc: string; setDesc: (v: string) => void;
  priority: Priority; setPriority: (v: Priority) => void;
  dueDate: string; setDueDate: (v: string) => void;
  assigneeId: string | null; setAssigneeId: (v: string | null) => void;
  status: TaskStatus; setStatus: (v: TaskStatus) => void;
  voiceNoteUrl: string | null; setVoice: (v: string | null) => void;
  imageUrls: string[]; setImageUrls: (v: string[]) => void;
  employees: Employee[]; showStatus: boolean;
}) {
  const titleOptional = !showStatus && !title.trim() && (!!voiceNoteUrl || imageUrls.length > 0);

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

      {showStatus && (
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Status</label>
          <div className="flex gap-2">
            {(["todo", "in-progress", "done"] as TaskStatus[]).map(s => (
              <button key={s} type="button" onClick={() => setStatus(s)}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
                  status === s ? `${S_CFG[s].bg} ${S_CFG[s].text} ring-2 ring-current ring-offset-1` : "bg-slate-100 text-slate-400"
                }`}
              >
                {S_CFG[s].label}
              </button>
            ))}
          </div>
        </div>
      )}

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
        <VoiceRecorder onRecorded={setVoice} existingUrl={voiceNoteUrl} />
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Images</label>
        <ImagePicker images={imageUrls} onChange={setImageUrls} />
      </div>
    </div>
  );
}

/* ─── AddTaskModal ────────────────────────────────────────── */
function AddTaskModal({ employees, defaultAssigneeId, assignLabel, onAdd, onClose }: {
  employees: Employee[];
  defaultAssigneeId?: string | null;
  assignLabel?: string;
  onAdd: (t: Omit<Task, "id" | "createdAt" | "comments" | "order">) => void;
  onClose: () => void;
}) {
  const [title, setTitle]           = useState("");
  const [desc, setDesc]             = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(defaultAssigneeId ?? null);
  const [priority, setPriority]     = useState<Priority>("medium");
  const [dueDate, setDueDate]       = useState(() => addDays(getToday(), 3).toISOString().slice(0, 10));
  const [status, setStatus]         = useState<TaskStatus>("todo");
  const [voiceNoteUrl, setVoice]    = useState<string | null>(null);
  const [imageUrls, setImageUrls]   = useState<string[]>([]);

  const hasContent = !!title.trim() || !!voiceNoteUrl || imageUrls.length > 0;

  const submit = () => {
    if (!hasContent) return;
    const finalTitle = title.trim() || (voiceNoteUrl ? "Voice note task" : "Image task");
    onAdd({ title: finalTitle, description: desc, assigneeId, createdById: defaultAssigneeId ?? null, status, priority, dueDate, voiceNoteUrl, imageUrls });
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
          status={status} setStatus={setStatus}
          voiceNoteUrl={voiceNoteUrl} setVoice={setVoice}
          imageUrls={imageUrls} setImageUrls={setImageUrls}
          employees={employees} showStatus={false}
        />
        <button type="button" onClick={submit} disabled={!hasContent}
          className="w-full mt-5 bg-indigo-600 text-white py-4 rounded-2xl text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-indigo-700 active:bg-indigo-800 transition-colors shadow-lg shadow-indigo-600/20"
        >
          {assigneeName ? `Create & Notify ${assigneeName}` : "Create Task"}
        </button>
      </div>
    </BottomSheet>
  );
}

/* ─── EditTaskModal ───────────────────────────────────────── */
function EditTaskModal({ task, employees, onSave, onDelete, onClose }: {
  task: Task;
  employees: Employee[];
  onSave: (updated: Task) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle]           = useState(task.title);
  const [desc, setDesc]             = useState(task.description);
  const [assigneeId, setAssigneeId] = useState<string | null>(task.assigneeId);
  const [priority, setPriority]     = useState<Priority>(task.priority);
  const [dueDate, setDueDate]       = useState(task.dueDate);
  const [status, setStatus]         = useState<TaskStatus>(task.status);
  const [voiceNoteUrl, setVoice]    = useState<string | null>(task.voiceNoteUrl);
  const [imageUrls, setImageUrls]   = useState<string[]>(task.imageUrls);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    if (!title.trim()) return;
    onSave({ ...task, title, description: desc, assigneeId, priority, dueDate, status, voiceNoteUrl, imageUrls });
    onClose();
  };

  const handleDelete = () => {
    onDelete(task.id);
    onClose();
  };

  return (
    <BottomSheet onClose={onClose}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-shrink-0">
        <h2 className="text-base font-bold text-slate-800">Edit Task</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setConfirmDelete(true)}
            className="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center"
          >
            <Trash2 size={14} className="text-red-500" />
          </button>
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
      ) : (
        <div className="overflow-y-auto flex-1 p-5 pb-6" style={{ scrollbarWidth: "none" }}>
          <TaskFormFields
            title={title} setTitle={setTitle}
            desc={desc} setDesc={setDesc}
            priority={priority} setPriority={setPriority}
            dueDate={dueDate} setDueDate={setDueDate}
            assigneeId={assigneeId} setAssigneeId={setAssigneeId}
            status={status} setStatus={setStatus}
            voiceNoteUrl={voiceNoteUrl} setVoice={setVoice}
            imageUrls={imageUrls} setImageUrls={setImageUrls}
            employees={employees} showStatus={true}
          />
          <button type="button" onClick={save} disabled={!title.trim()}
            className="w-full mt-5 bg-indigo-600 text-white py-4 rounded-2xl text-sm font-bold disabled:opacity-30 hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/20"
          >
            Save Changes
          </button>
        </div>
      )}
    </BottomSheet>
  );
}

/* ─── SwipeableTaskCard ───────────────────────────────────── */
function SwipeCard({
  task, employees, onStatus, onDelete, onEdit, onVoicePlay
}: {
  task: Task;
  employees: Employee[];
  onStatus: (id: string, s: TaskStatus) => void;
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
  const next: Record<TaskStatus, TaskStatus> = { "todo":"in-progress", "in-progress":"done", "done":"done" };
  const advanceLabel = task.status === "todo" ? "Start" : task.status === "in-progress" ? "Complete" : "Done!";

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
    setSwipeX(Math.max(-110, Math.min(110, delta)));
  };
  const onUp = () => {
    if (totalMove.current < 8) {
      // tap — open edit
      onEdit(task);
    } else if (swipeX > THRESH) {
      onStatus(task.id, next[task.status]);
    } else if (swipeX < -THRESH) {
      onDelete(task.id);
    }
    setSwipeX(0);
    dragging.current = false;
  };

  const showRight = swipeX > 18;
  const showLeft  = swipeX < -18;

  return (
    <div className="relative mb-3 rounded-2xl overflow-hidden" style={{ minHeight: 96 }}>
      <div className={`absolute inset-0 flex items-center pl-5 bg-emerald-500 rounded-2xl transition-opacity duration-100 ${showRight ? "opacity-100" : "opacity-0"}`}>
        <Check size={18} className="text-white" strokeWidth={3} />
        <span className="text-white text-sm font-bold ml-2">{advanceLabel}</span>
      </div>
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
              <p className={`font-bold text-[13px] leading-snug ${task.status === "done" ? "line-through text-slate-300" : "text-slate-800"}`}>
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
              {task.status === "done" ? <Check size={11} strokeWidth={3} /> : task.status === "in-progress" ? <TrendingUp size={11} /> : <Clock size={11} />}
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
    inProgress: tasks.filter(t => t.status === "in-progress").length,
    done:       tasks.filter(t => t.status === "done").length,
    overdue:    tasks.filter(t => isOverdue(t.dueDate, t.status)).length,
    todo:       tasks.filter(t => t.status === "todo").length,
    total:      tasks.length,
  };
  const activeTasks = tasks.filter(t => t.status !== "done").slice(0, 4);

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
            const done = empTasks.filter(t => t.status === "done").length;
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
    .sort((a, b) => a.status === "done" && b.status !== "done" ? 1 : a.status !== "done" && b.status === "done" ? -1 : 0);
  const done       = empTasks.filter(t => t.status === "done").length;
  const inProgress = empTasks.filter(t => t.status === "in-progress").length;
  const todo       = empTasks.filter(t => t.status === "todo").length;
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
                      <p className={`text-sm font-bold truncate ${task.status === "done" ? "line-through text-slate-300" : "text-slate-800"}`}>{task.title}</p>
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
function TasksView({ tasks, employees, loading, onStatus, onDelete, onEdit }: {
  tasks: Task[];
  employees: Employee[];
  loading: boolean;
  onStatus: (id: string, s: TaskStatus) => void;
  onDelete: (id: string) => void;
  onEdit: (task: Task) => void;
}) {
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);

  const filtered = filter === "all" ? tasks : tasks.filter(t => t.status === filter);
  const tabs: { id: TaskStatus | "all"; label: string }[] = [
    { id: "all", label: "All" },
    { id: "todo", label: "To Do" },
    { id: "in-progress", label: "Active" },
    { id: "done", label: "Done" },
  ];

  const handleVoicePlay = (url: string) => {
    if (playingUrl === url) { audioEl.current?.pause(); setPlayingUrl(null); return; }
    audioEl.current?.pause();
    const a = new Audio(url);
    a.onended = () => setPlayingUrl(null);
    a.play();
    audioEl.current = a;
    setPlayingUrl(url);
  };

  return (
    <div className="p-5">
      <div className="mb-4">
        <h1 className="text-xl font-black text-slate-800">Tasks</h1>
        <p className="text-[11px] text-slate-400 mt-0.5 font-medium">Tap to edit · Swipe right to advance · left to delete</p>
      </div>

      <div className="flex gap-2 mb-5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {tabs.map(tab => {
          const cnt = tab.id === "all" ? tasks.length : tasks.filter(t => t.status === tab.id).length;
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
        filtered.map(task => (
          <SwipeCard
            key={task.id}
            task={task}
            employees={employees}
            onStatus={onStatus}
            onDelete={onDelete}
            onEdit={onEdit}
            onVoicePlay={handleVoicePlay}
          />
        ))
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
function SettingsView({ tasks, employees, employeesLoading, ownerName, orgId, onInvited, onSignOut }: {
  tasks: Task[];
  employees: Employee[];
  employeesLoading: boolean;
  ownerName: string;
  orgId: string;
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
            const active = empTasks.filter(t => t.status !== "done").length;
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
  task, employees, isSelf, sortMode, canMoveUp, canMoveDown, onStatus, onOpen, onMove,
}: {
  task: Task;
  employees: Employee[];
  isSelf: boolean;
  sortMode: SortMode;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onStatus: (id: string, s: TaskStatus) => void;
  onOpen: (task: Task) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const assignee = employees.find(e => e.id === task.assigneeId);
  const p = P_CFG[task.priority];
  const done = task.status === "done";

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
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStatus(task.id, done ? "todo" : "done"); }}
            className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${
              done ? "bg-emerald-500 border-emerald-500" : "border-slate-300"
            }`}
          >
            {done && <Check size={13} className="text-white" strokeWidth={3} />}
          </button>

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
function EmployeeTasksView({ tasks, employees, currentEmployeeId, loading, onStatus, onReorder, onOpenTask }: {
  tasks: Task[];
  employees: Employee[];
  currentEmployeeId: string;
  loading: boolean;
  onStatus: (id: string, s: TaskStatus) => void;
  onReorder: (assigneeId: string | null, orderedIds: string[]) => void;
  onOpenTask: (task: Task) => void;
}) {
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const me = employees.find(e => e.id === currentEmployeeId);
  const myTasks = tasks.filter(t => t.assigneeId === currentEmployeeId);

  const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...myTasks].sort((a, b) => {
    if (a.status === "done" && b.status !== "done") return 1;
    if (b.status === "done" && a.status !== "done") return -1;
    if (sortMode === "priority") return priorityRank[a.priority] - priorityRank[b.priority];
    if (sortMode === "dueDate") return a.dueDate.localeCompare(b.dueDate);
    return a.order - b.order; // custom
  });

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
        sorted.map((task, i) => (
          <EmployeeTaskCard
            key={task.id}
            task={task}
            employees={employees}
            isSelf
            sortMode={sortMode}
            canMoveUp={i > 0}
            canMoveDown={i < sorted.length - 1}
            onStatus={onStatus}
            onOpen={onOpenTask}
            onMove={move}
          />
        ))
      )}
    </div>
  );
}

/* ─── EmployeeTaskModal (detail + comments + reassign) ────── */
function EmployeeTaskModal({ task, employees, currentEmployeeId, onStatus, onReassign, onAddComment, onClose }: {
  task: Task;
  employees: Employee[];
  currentEmployeeId: string;
  onStatus: (id: string, s: TaskStatus) => void;
  onReassign: (taskId: string, newAssigneeId: string) => void;
  onAddComment: (taskId: string, authorId: string, text: string, imageUrls?: string[]) => void;
  onClose: () => void;
}) {
  const [commentText, setCommentText] = useState("");
  const [commentImages, setCommentImages] = useState<string[]>([]);
  const commentFileInput = useRef<HTMLInputElement | null>(null);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const assignee = employees.find(e => e.id === task.assigneeId);
  const done = task.status === "done";
  const peers = employees.filter(e => e.id !== task.assigneeId);

  const submitComment = () => {
    if (!commentText.trim() && commentImages.length === 0) return;
    onAddComment(task.id, currentEmployeeId, commentText, commentImages);
    setCommentText("");
    setCommentImages([]);
  };

  return (
    <>
    <BottomSheet onClose={onClose}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-shrink-0">
        <h2 className="text-base font-bold text-slate-800">Task Details</h2>
        <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
          <X size={15} className="text-slate-500" />
        </button>
      </div>

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

        {/* Voice note */}
        {task.voiceNoteUrl && <VoiceNotePlayer url={task.voiceNoteUrl} />}

        {/* Images */}
        {task.imageUrls.length > 0 && (
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              Images {task.imageUrls.length > 1 && `(${task.imageUrls.length})`}
            </label>
            <div className="flex flex-wrap gap-2">
              {task.imageUrls.map(url => (
                <button key={url} type="button" onClick={() => setLightboxUrl(url)}
                  className="w-16 h-16 rounded-xl overflow-hidden flex-shrink-0"
                >
                  <img src={url} alt="Task attachment" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Mark complete */}
        <button
          type="button"
          onClick={() => onStatus(task.id, done ? "in-progress" : "done")}
          className={`w-full py-3.5 rounded-2xl text-sm font-bold transition-colors flex items-center justify-center gap-2 ${
            done ? "bg-slate-100 text-slate-500" : "bg-emerald-500 text-white shadow-lg shadow-emerald-500/20"
          }`}
        >
          <Check size={15} strokeWidth={3} />
          {done ? "Mark as not done" : "Mark as done"}
        </button>

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
    </BottomSheet>

    {lightboxUrl && (
      <div
        className="fixed inset-0 z-[70] bg-black/85 flex items-center justify-center p-6"
        onClick={() => setLightboxUrl(null)}
      >
        <img src={lightboxUrl} alt="Task attachment" className="max-w-full max-h-full rounded-2xl object-contain" />
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
  const done = myTasks.filter(t => t.status === "done").length;

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

  const currentEmployeeId = membershipId ?? "";

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
  // cross-profile sync. Voice notes and image attachments are intentionally
  // left out of every insert/update payload: the picker/recorder above only
  // ever produce local blob: URLs (no upload step yet), so sending them
  // would overwrite voice_note_url/image_urls with values nobody else could
  // load — that wiring is a separate milestone.
  const handleStatus = async (id: string, status: TaskStatus) => {
    const { error } = await supabase.from("tasks").update({ status }).eq("id", id);
    if (error) { showToast(error.message); return; }
    await fetchTasks();
    showToast(status === "done" ? "Marked complete!" : "Status updated");
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
      })
      .eq("id", updated.id);
    if (error) { showToast(error.message); return; }
    await fetchTasks();
    showToast("Task saved");
  };
  const handleAddTask = async (data: Omit<Task, "id" | "createdAt" | "comments" | "order">) => {
    const { error } = await supabase.from("tasks").insert({
      org_id: orgId,
      title: data.title,
      description: data.description,
      assignee_id: data.assigneeId,
      created_by: currentEmployeeId || null,
      status: data.status,
      priority: data.priority,
      due_date: data.dueDate || null,
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
  const myTasksCount = tasks.filter(t => t.assigneeId === currentEmployeeId && t.status !== "done").length;
  const activeTasks = role === "owner" ? tasks.filter(t => t.status !== "done").length : myTasksCount;

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
                onStatus={handleStatus} onDelete={handleDeleteTask} onEdit={setEditTask}
              />
            )}
            {role === "owner" && view === "settings" && (
              <SettingsView
                tasks={tasks} employees={employees} employeesLoading={employeesLoading}
                ownerName={fullName?.trim() || user?.email || ""}
                orgId={orgId}
                onInvited={fetchEmployees}
                onSignOut={signOut}
              />
            )}

            {role === "employee" && view === "tasks" && (
              <EmployeeTasksView
                tasks={tasks} employees={employees}
                currentEmployeeId={currentEmployeeId}
                loading={tasksLoading}
                onStatus={handleStatus}
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
          defaultAssigneeId={role === "employee" ? currentEmployeeId : null}
          assignLabel={role === "employee" ? "Assign to yourself or a teammate" : undefined}
          onAdd={handleAddTask}
          onClose={() => setShowAdd(false)}
        />
      )}
      {editTask && role === "owner" && (
        <EditTaskModal
          task={editTask}
          employees={employees}
          onSave={handleSaveTask}
          onDelete={id => { handleDeleteTask(id); setEditTask(null); }}
          onClose={() => setEditTask(null)}
        />
      )}
      {editTask && role === "employee" && (
        <EmployeeTaskModal
          task={tasks.find(t => t.id === editTask.id) ?? editTask}
          employees={employees}
          currentEmployeeId={currentEmployeeId}
          onStatus={handleStatus}
          onReassign={handleReassign}
          onAddComment={handleAddComment}
          onClose={() => setEditTask(null)}
        />
      )}
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
