// Import du CSV vers Supabase.
//
// Regles retenues :
//   - une ligne entierement vide est ignoree (le CSV en contient quelques-unes)
//   - une ligne sans nom mais avec du contenu est conservee : c'est de la donnee
//   - les etiquettes "ai, artiste" deviennent un tableau ['ai','artiste']
//   - rien n'est invente : les champs vides du CSV restent vides en base,
//     avec le statut 'en_attente' que l'enrichissement viendra traiter
//
// Par securite, l'import refuse d'ecrire dans une table deja peuplee.
// Utiliser --remplacer pour vider la table au prealable.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const FICHIER = 'base de connaissance.csv';
const LOT = 100;

const remplacer = process.argv.includes('--remplacer');

const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

// --- Lecture du CSV -------------------------------------------------

const brut = await readFile(FICHIER, 'utf8');
const lignes = parse(brut, {
    columns: true,
    bom: true,            // le fichier commence par un BOM UTF-8
    skip_empty_lines: true,
    relax_column_count: true,
});

console.log(`\nLecture de "${FICHIER}" : ${lignes.length} lignes\n`);

const vide = (v) => !v || !String(v).trim();
const propre = (v) => (vide(v) ? null : String(v).trim());

const etiquettes = (v) =>
    vide(v)
        ? []
        : String(v)
              .split(',')
              .map((e) => e.trim())
              .filter(Boolean);

let ignorees = 0;

const enregistrements = lignes
    .map((ligne, i) => {
        const champs = {
            nom:          propre(ligne['Nom']),
            note_alex:    propre(ligne['Note Alex']),
            texte:        propre(ligne['Texte']),
            url:          propre(ligne['URL']),
            date_maj_n8n: propre(ligne['date de mise à jour n8n']),
            etiquettes:   etiquettes(ligne['Étiquettes']),
            ligne_csv:    i + 2,   // +2 : ligne 1 = en-tetes, indices a partir de 1
        };

        const totalementVide =
            !champs.nom && !champs.note_alex && !champs.texte &&
            !champs.url && champs.etiquettes.length === 0;

        if (totalementVide) {
            ignorees++;
            return null;
        }
        return champs;
    })
    .filter(Boolean);

console.log(`  ${enregistrements.length} lignes a importer`);
console.log(`  ${ignorees} lignes vides ignorees`);

const avecNom = enregistrements.filter((e) => e.nom).length;
const aEnrichir = enregistrements.filter(
    (e) => e.nom && (!e.texte || !e.url)
).length;

console.log(`  ${avecNom} lignes portent un nom`);
console.log(`  ${aEnrichir} lignes seront candidates a l'enrichissement\n`);

// --- Verification de l'etat de la table -----------------------------

const { count, error: errCount } = await db
    .from('connaissances')
    .select('*', { count: 'exact', head: true });

if (errCount) {
    console.error(`Lecture de la table impossible : ${errCount.message}`);
    process.exit(1);
}

if (count > 0 && !remplacer) {
    console.error(
        `La table contient deja ${count} lignes.\n` +
        `Relance avec --remplacer pour la vider et reimporter :\n` +
        `    npm run importer -- --remplacer\n`
    );
    process.exit(1);
}

if (count > 0 && remplacer) {
    console.log(`Suppression des ${count} lignes existantes...`);
    const { error } = await db
        .from('connaissances')
        .delete()
        .not('id', 'is', null);
    if (error) {
        console.error(`Suppression impossible : ${error.message}`);
        process.exit(1);
    }
}

// --- Insertion par lots ---------------------------------------------

let inseres = 0;

for (let i = 0; i < enregistrements.length; i += LOT) {
    const lot = enregistrements.slice(i, i + LOT);
    const { error } = await db.from('connaissances').insert(lot);

    if (error) {
        console.error(`\nEchec sur le lot ${i / LOT + 1} : ${error.message}`);
        process.exit(1);
    }

    inseres += lot.length;
    console.log(`  ${inseres}/${enregistrements.length} lignes inserees`);
}

// --- Controle final --------------------------------------------------

const { count: final } = await db
    .from('connaissances')
    .select('*', { count: 'exact', head: true });

const { count: candidates } = await db
    .from('a_enrichir')
    .select('*', { count: 'exact', head: true });

console.log(`\nImport termine.`);
console.log(`  ${final} lignes en base`);
console.log(`  ${candidates} en attente d'enrichissement`);
console.log(`\nEtape suivante : npm run enrichir\n`);
