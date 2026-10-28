-- Workforce: time clock, scheduling, task checklists.

create extension if not exists btree_gist;

-- Time clock -----------------------------------------------------------------
-- Punches are the raw record and are never edited. A mistake is fixed by
-- voiding the punch (with a reason) and, if needed, a manager adding the
-- correct one (also with a reason). Timecards are computed from punches.

create table time_punches (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  user_id uuid not null references users (id),
  location_id uuid not null,
  kind text not null check (kind in ('in', 'out', 'break_start', 'break_end')),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  source text not null check (source in ('self', 'manager')),
  reason text,
  created_by uuid not null references users (id),
  device_id uuid references devices (id),
  voided_at timestamptz,
  voided_by uuid references users (id),
  void_reason text,
  check (source = 'self' or reason is not null),
  check ((voided_at is null) = (void_reason is null)),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);
create index time_punches_user_time on time_punches (tenant_id, user_id, occurred_at);

-- A manager signing off a person's week. If punches change afterwards the
-- approval shows as out of date.
create table timecard_approvals (
  tenant_id uuid not null references tenants (id) on delete cascade,
  user_id uuid not null references users (id),
  week_start date not null,
  worked_minutes integer not null,
  approved_by uuid not null references users (id),
  approved_at timestamptz not null default now(),
  primary key (tenant_id, user_id, week_start)
);

-- Scheduling -----------------------------------------------------------------

create table shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  -- Null is an open shift anyone can be given later.
  user_id uuid references users (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  position text,
  notes text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours'),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  -- Nobody can be scheduled in two places at once.
  exclude using gist (tenant_id with =, user_id with =, tstzrange(starts_at, ends_at) with &&)
);
create index shifts_range on shifts (tenant_id, starts_at);

-- Task checklists ------------------------------------------------------------

create table checklists (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid,
  title text not null check (length(trim(title)) > 0),
  recurrence text not null check (recurrence in ('once', 'daily', 'weekly')),
  -- Weekly: days it runs, 0 = Sunday … 6 = Saturday.
  weekdays smallint[] not null default '{}',
  -- Once: the day it is due.
  due_date date,
  assignee_user_id uuid references users (id),
  assignee_role_key text,
  archived_at timestamptz,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  check (recurrence <> 'once' or due_date is not null),
  check (recurrence <> 'weekly' or cardinality(weekdays) > 0),
  check (assignee_user_id is null or assignee_role_key is null),
  unique (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);

create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  checklist_id uuid not null,
  position integer not null,
  label text not null check (length(trim(label)) > 0),
  archived_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, checklist_id) references checklists (tenant_id, id) on delete cascade
);

-- One run of a checklist for a day (created when someone first opens it).
create table checklist_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  checklist_id uuid not null,
  run_date date not null,
  created_at timestamptz not null default now(),
  unique (checklist_id, run_date),
  unique (tenant_id, id),
  foreign key (tenant_id, checklist_id) references checklists (tenant_id, id) on delete cascade
);

-- Who ticked what and when. Unticking keeps the row (undone_at) as a record.
create table checklist_completions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  run_id uuid not null,
  item_id uuid not null,
  completed_by uuid not null references users (id),
  completed_at timestamptz not null default now(),
  note text,
  undone_at timestamptz,
  undone_by uuid references users (id),
  foreign key (tenant_id, run_id) references checklist_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references checklist_items (tenant_id, id)
);
create unique index checklist_completions_current on checklist_completions (run_id, item_id) where undone_at is null;

do $$
declare t text;
begin
  foreach t in array array['time_punches', 'timecard_approvals', 'shifts', 'checklists', 'checklist_items', 'checklist_runs', 'checklist_completions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())',
      t
    );
  end loop;
end $$;

-- Punches: the app can add them and void them, but never change what was punched.
grant select, insert on time_punches to pos_app;
grant update (voided_at, voided_by, void_reason) on time_punches to pos_app;
grant select, insert, update, delete on timecard_approvals to pos_app;
grant select, insert, update, delete on shifts to pos_app;
grant select, insert, update on checklists, checklist_items to pos_app;
grant select, insert on checklist_runs to pos_app;
grant select, insert, update (undone_at, undone_by) on checklist_completions to pos_app;
