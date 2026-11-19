create table users (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash bytea primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
create index sessions_user_id_idx on sessions (user_id);

create table saves (
  user_id uuid primary key references users(id) on delete cascade,
  save_id uuid not null,
  revision int not null,
  body jsonb not null,
  updated_at timestamptz not null default now()
);

create table save_archive (
  user_id uuid primary key references users(id) on delete cascade,
  save_id uuid not null,
  revision int not null,
  body jsonb not null,
  archived_at timestamptz not null default now()
);

create table save_revisions (
  user_id uuid not null references users(id) on delete cascade,
  save_id uuid not null,
  revision int not null,
  digest jsonb not null,
  primary key (user_id, save_id, revision)
);

create table actions (
  user_id uuid not null references users(id) on delete cascade,
  save_id uuid not null,
  device_id uuid not null,
  seq int not null,
  entry jsonb not null,
  received_at timestamptz not null default now(),
  primary key (user_id, save_id, device_id, seq)
);
