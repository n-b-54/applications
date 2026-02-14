-- Run this in Supabase SQL Editor to create the orders table.
-- See plan section 2b.

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  transaction_id text not null unique,
  customer_email text not null,
  items jsonb not null,
  download_token text not null,
  created_at timestamptz not null default now()
);

-- Optional: enable RLS and allow service role to insert (default allows all for service_role).
-- alter table public.orders enable row level security;
