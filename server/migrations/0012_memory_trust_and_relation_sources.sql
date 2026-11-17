alter table qa_memory add column if not exists verified boolean not null default false;
alter table qa_memory add column if not exists memory_score real not null default 0.3;
alter table qa_memory add column if not exists invalid_reason text not null default '';
alter table qa_memory add column if not exists last_verified_at text;
update qa_memory
set verified = (status = 'confirmed'),
    memory_score = case when status = 'confirmed' then 1.0 when status = 'rejected' then 0.0 else 0.3 end,
    last_verified_at = case when status = 'confirmed' then coalesce(last_verified_at, updated_at) else last_verified_at end
where verified = false and memory_score = 0.3;
create index if not exists idx_qa_verified_score on qa_memory (user_id, verified, memory_score);
alter table relations add column if not exists source_chunks jsonb not null default '[]'::jsonb;
create index if not exists idx_relations_source_chunks on relations using gin (source_chunks);
