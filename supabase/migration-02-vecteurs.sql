-- ============================================================
-- Migration 02 : recherche vectorielle
-- ============================================================
-- Chaque ligne recoit un vecteur de 384 nombres qui encode son sens.
-- Deux lignes parlant de sujets proches auront des vecteurs proches,
-- meme si elles n'emploient aucun mot en commun.
--
-- Le modele qui calcule ces vecteurs (multilingual-e5-small) tourne
-- en local : aucune donnee de la base ne sort du poste pour cette etape.
-- ============================================================

create extension if not exists vector;

alter table public.connaissances
    add column if not exists embedding  vector(384),
    add column if not exists indexe_le  timestamptz;

comment on column public.connaissances.embedding is
    'Vecteur semantique calcule localement par multilingual-e5-small.';

-- Index HNSW : rend la recherche par proximite rapide meme si la base
-- grossit. La distance cosinus est celle attendue par le modele.
create index if not exists idx_connaissances_embedding
    on public.connaissances
    using hnsw (embedding vector_cosine_ops);

-- ------------------------------------------------------------
-- Recherche des lignes les plus proches d'une question
-- ------------------------------------------------------------
-- Renvoie les voisins classes du plus proche au plus lointain, avec
-- leur similarite (1 = identique, 0 = sans rapport). Le chatbot ne
-- verra que ces lignes : il ne peut pas repondre au-dela.

create or replace function public.chercher_voisins(
    vecteur vector(384),
    nombre  int default 6
)
returns table (
    id           uuid,
    nom          text,
    resume       text,
    texte        text,
    note_alex    text,
    url          text,
    source_url   text,
    source_titre text,
    etiquettes   text[],
    similarite   double precision
)
language sql
stable
as $$
    select
        c.id, c.nom, c.resume, c.texte, c.note_alex,
        c.url, c.source_url, c.source_titre, c.etiquettes,
        (1 - (c.embedding <=> vecteur))::double precision as similarite
    from public.connaissances c
    where c.embedding is not null
    order by c.embedding <=> vecteur
    limit nombre;
$$;
