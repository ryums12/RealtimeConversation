create table if not exists conversations (
  id uuid primary key,
  status text not null check (status in ('active', 'ended')),
  scenario text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists conversation_messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists conversation_analysis (
  id bigserial primary key,
  conversation_id uuid not null unique references conversations(id) on delete cascade,
  result jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_messages_conversation_id_created_at_idx
  on conversation_messages(conversation_id, created_at);

create index if not exists conversation_analysis_conversation_id_idx
  on conversation_analysis(conversation_id);
