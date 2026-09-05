-- ============================================================
-- Base de connaissance - schema Supabase / PostgreSQL
-- ============================================================
-- Principe directeur : toute donnee ajoutee par la machine doit
-- etre tracable jusqu'a sa source. Les colonnes source_* et
-- champs_enrichis existent pour cela : sans source verifiable,
-- une ligne ne peut pas passer au statut 'enrichi'.
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists public.connaissances (
    id              uuid primary key default gen_random_uuid(),

    -- ---- Colonnes issues du CSV d'origine ----
    nom             text,
    note_alex       text,
    texte           text,
    url             text,
    date_maj_n8n    timestamptz,
    etiquettes      text[] default '{}',

    -- ---- Tracabilite de l'enrichissement automatique ----
    statut          text not null default 'en_attente'
                    check (statut in ('en_attente','enrichi','non_trouve','echec')),
    champs_enrichis text[] default '{}',   -- quels champs la machine a remplis
    source_url      text,                  -- page d'ou vient l'information
    source_titre    text,                  -- titre de cette page
    source_extrait  text,                  -- extrait brut renvoye par l'API : la preuve
    moteur          text,                  -- quelle API a fourni le resultat
    enrichi_le      timestamptz,
    erreur          text,                  -- message si statut = 'echec'

    -- ---- Metadonnees ----
    ligne_csv       integer,               -- position d'origine dans le CSV
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- Garde-fou : pas de statut 'enrichi' sans source verifiable.
-- C'est cette contrainte qui rend l'invention impossible au niveau
-- de la base, independamment du code applicatif.
alter table public.connaissances
    drop constraint if exists enrichi_exige_une_source;

alter table public.connaissances
    add constraint enrichi_exige_une_source check (
        statut <> 'enrichi'
        or (source_url is not null and source_extrait is not null)
    );

create index if not exists idx_connaissances_statut
    on public.connaissances (statut);

create index if not exists idx_connaissances_etiquettes
    on public.connaissances using gin (etiquettes);

-- Mise a jour automatique de updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_connaissances_touch on public.connaissances;
create trigger trg_connaissances_touch
    before update on public.connaissances
    for each row execute function public.touch_updated_at();

-- Vue pratique : les lignes qui meritent un enrichissement.
-- On exige un nom : sans intitule, aucune recherche web n'a de sens.
create or replace view public.a_enrichir as
select id, nom, texte, url, etiquettes, statut
from public.connaissances
where nom is not null
  and btrim(nom) <> ''
  and statut = 'en_attente'
  and (texte is null or btrim(texte) = '' or url is null or btrim(url) = '');

-- Securite : RLS active, aucune politique publique.
-- L'application locale se connecte avec la cle service_role,
-- qui contourne RLS. Rien n'est expose a un client anonyme.
alter table public.connaissances enable row level security;
