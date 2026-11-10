-- Run once in Supabase > SQL Editor. Saves are stored by an unguessable code and can only be read with the exact code.
create table if not exists public.emerald_saves (
  code text primary key check (code ~ '^[A-Z2-9]{10}$'),
  data text not null check (length(data) between 20 and 300000),
  created_at timestamptz not null default now()
);
alter table public.emerald_saves enable row level security;   -- no policies: the table is closed to direct access

create or replace function public.put_save(p_code text, p_data text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into public.emerald_saves(code, data) values (p_code, p_data);   -- never overwrites an existing code
  return true;
exception when unique_violation then return false;
end $$;

create or replace function public.get_save(p_code text) returns text
language sql security definer stable set search_path = public as $$
  select data from public.emerald_saves where code = p_code;
$$;

revoke all on function public.put_save(text, text), public.get_save(text) from public;
grant execute on function public.put_save(text, text), public.get_save(text) to anon;
