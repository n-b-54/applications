-- Run this in Supabase SQL Editor to create the purchases table.
-- This replaces the old orders table with a cleaner purchase record.

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  transaction_id text not null unique,
  customer_email text not null,
  product_name text,
  price_id text,
  amount_total text,
  currency text,
  download_path text,
  items jsonb,
  created_at timestamptz not null default now()
);

-- Optional: enable RLS and allow service role to insert (default allows all for service_role).
-- alter table public.purchases enable row level security;
