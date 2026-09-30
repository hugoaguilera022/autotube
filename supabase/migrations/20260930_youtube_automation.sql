-- AutoTube / La Última Clave: persistent YouTube Automation foundation
create table if not exists autotube_channels (
  id uuid primary key default gen_random_uuid(),
  channel_id text unique,
  name text not null,
  handle text,
  language text default 'es',
  timezone text default 'Europe/Madrid',
  niche text,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists autotube_stories (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references autotube_channels(id) on delete cascade,
  title text not null,
  premise text,
  genre text,
  series text,
  characters jsonb not null default '[]'::jsonb,
  setting text,
  twist text,
  script text,
  visual_style text,
  story_fingerprint text,
  source_job_id text,
  youtube_video_id text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists autotube_stories_channel_idx on autotube_stories(channel_id);
create index if not exists autotube_stories_fingerprint_idx on autotube_stories(story_fingerprint);

create table if not exists autotube_jobs (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references autotube_channels(id) on delete cascade,
  type text not null,
  status text not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  last_error text,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists autotube_jobs_queue_idx on autotube_jobs(status, scheduled_at);

create table if not exists autotube_publications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references autotube_jobs(id) on delete set null,
  story_id uuid references autotube_stories(id) on delete set null,
  youtube_video_id text,
  title text,
  description text,
  visibility text,
  publish_at timestamptz,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists autotube_analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  youtube_video_id text not null,
  channel_id text,
  observed_at timestamptz not null default now(),
  views bigint default 0,
  likes bigint default 0,
  comments bigint default 0,
  subscribers_gained bigint default 0,
  watch_time_minutes numeric default 0,
  average_view_duration_seconds numeric default 0,
  average_view_percentage numeric default 0,
  raw jsonb not null default '{}'::jsonb
);
create index if not exists autotube_analytics_video_idx on autotube_analytics_snapshots(youtube_video_id, observed_at desc);