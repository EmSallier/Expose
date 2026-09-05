-- ============================================================
-- Migration 01 : colonnes du resume redige
-- ============================================================
-- Le choix retenu est d'afficher la source brute et sa reformulation
-- cote a cote. 'texte' recoit l'extrait tel quel, 'resume' la version
-- redigee. On sait toujours lequel est lequel.
-- ============================================================

alter table public.connaissances
    add column if not exists resume         text,     -- reformulation lisible
    add column if not exists resume_modele  text,     -- quel modele l'a redigee
    add column if not exists pertinence     numeric;  -- score de confiance du moteur

comment on column public.connaissances.texte is
    'Extrait brut de la page source, non reformule.';
comment on column public.connaissances.resume is
    'Reformulation du seul extrait ci-dessus. Aucune connaissance externe ajoutee.';
comment on column public.connaissances.pertinence is
    'Score de pertinence renvoye par le moteur de recherche (0 a 1).';
