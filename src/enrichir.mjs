// Enrichissement en ligne de commande.
//
// La logique vit dans src/enrichissement.mjs, partagee avec le serveur web :
// les deux chemins appliquent donc exactement les memes garde-fous.
//
// Usage :
//   node src/enrichir.mjs              enrichit tout ce qui est en attente
//   node src/enrichir.mjs --limite 5   s'arrete apres 5 lignes (test)
//   node src/enrichir.mjs --simuler    n'ecrit rien en base, affiche seulement

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { creerRedacteur, traiterLigne } from './enrichissement.mjs';

const PAUSE_MS = 350;

const args = process.argv.slice(2);
const valeurArg = (nom) => {
    const i = args.indexOf(nom);
    return i >= 0 ? args[i + 1] : null;
};
const limite = Number(valeurArg('--limite')) || Infinity;
const simuler = args.includes('--simuler');

const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const redacteur = await creerRedacteur();

const { data: lignes, error } = await db
    .from('a_enrichir')
    .select('id, nom, texte, url, etiquettes')
    .order('nom');

if (error) {
    console.error(`Lecture impossible : ${error.message}`);
    process.exit(1);
}

const aTraiter = lignes.slice(0, limite);

console.log(`\n${lignes.length} lignes en attente, ${aTraiter.length} traitees.`);
console.log(`Reformulation : ${redacteur?.modele ?? 'desactivee (pas de cle Anthropic)'}`);
if (simuler) console.log('MODE SIMULATION : rien ne sera ecrit en base.');
console.log('');

const bilan = { enrichi: 0, non_trouve: 0, echec: 0 };

for (const [i, ligne] of aTraiter.entries()) {
    console.log(`[${i + 1}/${aTraiter.length}] ${ligne.nom.slice(0, 55)}`);

    const r = await traiterLigne(db, ligne, redacteur, { simuler });
    bilan[r.statut]++;

    if (r.statut === 'enrichi') {
        const score = r.source.score
            ? ` (score ${r.source.score.toFixed(2)})`
            : ' (page lue directement)';
        console.log(`        ${r.champs.join(', ')} <- ${r.source.url.slice(0, 60)}${score}`);
        if (r.resume) console.log(`        resume : ${r.resume.slice(0, 90)}...`);
    } else {
        console.log(`        ${r.message} -> ${r.statut}`);
    }

    await pause(PAUSE_MS);
}

console.log('\n--- Bilan ---');
console.log(`  ${bilan.enrichi} enrichies`);
console.log(`  ${bilan.non_trouve} sans source exploitable`);
console.log(`  ${bilan.echec} en echec`);
console.log('');
