-- ============================================
-- Tickboxer — Supabase schema (updated)
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
  title text not null default '',                             -- job title, e.g. "Floor Manager"
  color text not null default '#7C3AED',                      -- avatar color (hex)
  manager_id uuid references memberships(id),                 -- for org hierarchy (L1/L2)
  invited_at timestamptz not null default now(),
  joined_at timestamptz -- set when invite is accepted
);
alter table memberships add column if not exists title text not null default '';
alter table memberships add column if not exists color text not null default '#7C3AED';
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
