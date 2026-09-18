-- ============================================
-- whynotch — Supabase schema (updated)
-- Safe to run on a fresh project OR re-run on top
-- of the original schema — every statement is
-- idempotent (IF NOT EXISTS / DROP+CREATE POLICY).
--
-- Changes vs. the original script, based on the
-- current app data model in src/app/App.tsx:
--   • memberships.title  — job title shown in the UI
--                          ("Floor Manager", etc.) —
--                          distinct from memberships.role
--                          which stays owner/employee for
--                          permissions.
--   • memberships.color  — hex avatar color per person.
--   • memberships.full_name — the person's display name,
--                          set once by them via the
--                          "complete your profile" step on
--                          first login. Null until then —
--                          the UI falls back to email.
--   • tasks.image_urls    — photos attached to a task.
--   • comments.image_urls — photos attached to a comment.
--   • DELETE policies for tasks and memberships, and an
--     UPDATE policy so owners can edit teammates' profiles
--     — the original script only allowed self-service
--     invite acceptance, not owner-managed edits/removals.
-- ============================================

-- ============================================
-- ORGANIZATIONS
-- ============================================
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- ============================================
-- MEMBERSHIPS  (a person's role inside one org)
-- ============================================
create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null, -- null until they accept invite
  email text not null,
  role text not null check (role in ('owner','employee')),   -- app permission level
  full_name text,                                             -- set via "complete your profile" on first login
  title text not null default '',                             -- job title, e.g. "Floor Manager"
  color text not null default '#7C3AED',                      -- avatar color (hex)
  manager_id uuid references memberships(id),                 -- for org hierarchy (L1/L2)
  invited_at timestamptz not null default now(),
  joined_at timestamptz -- set when invite is accepted
);
alter table memberships add column if not exists title text not null default '';
alter table memberships add column if not exists color text not null default '#7C3AED';
alter table memberships add column if not exists full_name text;
create index if not exists idx_memberships_org on memberships(org_id);
create index if not exists idx_memberships_user on memberships(user_id);

-- ============================================
-- TASKS
-- ============================================
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  description text not null default '',
  assignee_id uuid references memberships(id) on delete set null,
  created_by uuid references memberships(id) on delete set null,
  status text not null default 'todo' check (status in ('todo','in-progress','done')),
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  due_date date,
  voice_note_url text,
  image_urls text[] not null default '{}',  -- photos attached to the task
  sort_order int not null default 0,        -- powers "My Order" custom sort
  created_at timestamptz not null default now()
);
alter table tasks add column if not exists image_urls text[] not null default '{}';
create index if not exists idx_tasks_org on tasks(org_id);
create index if not exists idx_tasks_assignee on tasks(assignee_id);

-- ============================================
-- COMMENTS
-- ============================================
create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  author_id uuid references memberships(id) on delete set null,
  text text not null,
  image_urls text[] not null default '{}', -- photos attached to the comment
  created_at timestamptz not null default now()
);
alter table comments add column if not exists image_urls text[] not null default '{}';
create index if not exists idx_comments_task on comments(task_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table organizations enable row level security;
alter table memberships   enable row level security;
alter table tasks         enable row level security;
alter table comments      enable row level security;

-- Members can see their own org
drop policy if exists "org select for members" on organizations;
create policy "org select for members" on organizations
  for select using (
    exists (select 1 from memberships m where m.org_id = organizations.id and m.user_id = (select auth.uid()))
  );

-- Members can see other memberships in their org
drop policy if exists "memberships select for org members" on memberships;
create policy "memberships select for org members" on memberships
  for select using (
    exists (select 1 from memberships m where m.org_id = memberships.org_id and m.user_id = (select auth.uid()))
  );

-- Only owners can invite (insert) new memberships
drop policy if exists "owners can invite" on memberships;
create policy "owners can invite" on memberships
  for insert with check (
    exists (select 1 from memberships m where m.org_id = memberships.org_id and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

-- A user can claim their own pending invite (set user_id/joined_at on their email match)
drop policy if exists "user can accept own invite" on memberships;
create policy "user can accept own invite" on memberships
  for update using (
    email = (select email from auth.users where id = (select auth.uid()))
  );

-- Owners can edit teammates' profiles (name/title/color/role) — the Settings > edit-employee flow
drop policy if exists "owners can update member profiles" on memberships;
create policy "owners can update member profiles" on memberships
  for update using (
    exists (select 1 from memberships m where m.org_id = memberships.org_id and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

-- Owners can remove teammates — the Settings > delete-employee flow
drop policy if exists "owners can remove members" on memberships;
create policy "owners can remove members" on memberships
  for delete using (
    exists (select 1 from memberships m where m.org_id = memberships.org_id and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

-- Tasks: any org member can see tasks in their org
drop policy if exists "tasks select for org members" on tasks;
create policy "tasks select for org members" on tasks
  for select using (
    exists (select 1 from memberships m where m.org_id = tasks.org_id and m.user_id = (select auth.uid()))
  );

drop policy if exists "tasks insert for org members" on tasks;
create policy "tasks insert for org members" on tasks
  for insert with check (
    exists (select 1 from memberships m where m.org_id = tasks.org_id and m.user_id = (select auth.uid()))
  );

drop policy if exists "tasks update for org members" on tasks;
create policy "tasks update for org members" on tasks
  for update using (
    exists (select 1 from memberships m where m.org_id = tasks.org_id and m.user_id = (select auth.uid()))
  );

-- Tasks: any org member can delete — matches the swipe-to-delete gesture in the Tasks list
drop policy if exists "tasks delete for org members" on tasks;
create policy "tasks delete for org members" on tasks
  for delete using (
    exists (select 1 from memberships m where m.org_id = tasks.org_id and m.user_id = (select auth.uid()))
  );

-- Comments: visible/insertable by anyone in the task's org
drop policy if exists "comments select for org members" on comments;
create policy "comments select for org members" on comments
  for select using (
    exists (
      select 1 from tasks t join memberships m on m.org_id = t.org_id
      where t.id = comments.task_id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "comments insert for org members" on comments;
create policy "comments insert for org members" on comments
  for insert with check (
    exists (
      select 1 from tasks t join memberships m on m.org_id = t.org_id
      where t.id = comments.task_id and m.user_id = (select auth.uid())
    )
  );

-- ============================================
-- TASK MEDIA STORAGE (voice notes + image attachments)
-- Private bucket — object path convention is {org_id}/{task_id}/{filename},
-- so RLS can check org membership directly from the path (no signed URL
-- is ever stored; the app calls storage.createSignedUrl() at render time).
-- ============================================
insert into storage.buckets (id, name, public)
values ('task-media', 'task-media', false)
on conflict (id) do nothing;

-- Org members can view media belonging to tasks in their own org — this
-- is what lets the app request a signed URL for a given path at all.
drop policy if exists "task media select for org members" on storage.objects;
create policy "task media select for org members" on storage.objects
  for select using (
    bucket_id = 'task-media'
    and exists (
      select 1 from memberships m
      where m.org_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );

-- Org members can upload media under their own org's path prefix.
drop policy if exists "task media insert for org members" on storage.objects;
create policy "task media insert for org members" on storage.objects
  for insert with check (
    bucket_id = 'task-media'
    and exists (
      select 1 from memberships m
      where m.org_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );

-- Org members can remove media belonging to their own org — mirrors the
-- existing "tasks delete for org members" policy (any org member can
-- delete a task, so they can remove its attachments too). Not currently
-- called from the app (attachment removal today just drops the
-- reference client-side before save), but the policy is here so that
-- capability can be wired up later without another SQL change.
drop policy if exists "task media delete for org members" on storage.objects;
create policy "task media delete for org members" on storage.objects
  for delete using (
    bucket_id = 'task-media'
    and exists (
      select 1 from memberships m
      where m.org_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );

-- ============================================
-- TASK LIFECYCLE STATE MACHINE
-- status: draft -> assigned -> accepted -> working -> completed -> closed
-- (completed -> assigned is a reopen/reassign, logged as a "reassigned"
-- task_event rather than being a status of its own.)
-- ============================================

-- The old constraint (status in ('todo','in-progress','done')) must be
-- dropped BEFORE the data is remapped below — otherwise the very first
-- update (todo -> assigned) violates the old constraint, since it has
-- no way to know 'assigned' is about to become valid.
alter table tasks drop constraint if exists tasks_status_check;

-- Map the old 3-state values onto their closest lifecycle equivalent.
-- Safe to re-run — no rows match the old values a second time.
update tasks set status = 'assigned'  where status = 'todo';
update tasks set status = 'working'   where status = 'in-progress';
update tasks set status = 'completed' where status = 'done';

alter table tasks add constraint tasks_status_check
  check (status in ('draft','assigned','accepted','working','completed','closed'));
alter table tasks alter column status set default 'draft';

-- Org-level setting: when on, Assigned -> Accepted happens automatically
-- at assignment instead of requiring the assignee to tap "why notch".
alter table organizations add column if not exists auto_assign boolean not null default false;

-- organizations had no update policy at all before this — the Settings
-- screen's Auto Assign toggle needs one to actually persist.
drop policy if exists "owners can update their org" on organizations;
create policy "owners can update their org" on organizations
  for update using (
    exists (select 1 from memberships m where m.org_id = organizations.id and m.user_id = (select auth.uid()) and m.role = 'owner')
  );

-- ============================================
-- TASK_EVENTS  (status-change / reassignment history)
-- ============================================
create table if not exists task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  event_type text not null,                 -- 'status_change' | 'reassigned'
  actor_id uuid references memberships(id) on delete set null,
  detail jsonb not null default '{}',       -- e.g. {"from":"accepted","to":"working"}
  created_at timestamptz not null default now()
);
create index if not exists idx_task_events_task on task_events(task_id);

alter table task_events enable row level security;

-- Visible/insertable by anyone in the task's org — same pattern as comments.
drop policy if exists "task events select for org members" on task_events;
create policy "task events select for org members" on task_events
  for select using (
    exists (
      select 1 from tasks t join memberships m on m.org_id = t.org_id
      where t.id = task_events.task_id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "task events insert for org members" on task_events;
create policy "task events insert for org members" on task_events
  for insert with check (
    exists (
      select 1 from tasks t join memberships m on m.org_id = t.org_id
      where t.id = task_events.task_id and m.user_id = (select auth.uid())
    )
  );
