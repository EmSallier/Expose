// Indexation : calcule le vecteur semantique de chaque ligne exploitable
// et l'ecrit en base. A relancer apres tout enrichissement, sans quoi les
// nouvelles lignes resteront invisibles au chatbot.
//
// Usage :
//   node src/indexer.mjs           n'indexe que ce qui ne l'est pas encore
//   node src/indexer.mjs --tout    recalcule tous les vecteurs

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { vectoriserPassages, texteRepresentatif } from './vecteurs.mjs';

const LOT = 16; // le modele encode plus vite par petits paquets

const tout = process.argv.includes('--tout');

const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const { data: lignes, error } = await db
    .from('connaissances')
    .select('id, nom, note_alex, resume, texte, etiquettes, embedding')
    .order('nom', { nullsFirst: false });

if (error) {
    console.error(`Lecture impossible : ${error.message}`);
    process.exit(1);
}

// Une ligne sans aucun contenu n'a rien a encoder : l'indexer produirait
// un vecteur sans signification, qui polluerait les resultats.
const candidates = lignes.filter((l) => {
    if (!texteRepresentatif(l).trim()) return false;
    return tout || !l.embedding;
});

console.log(`\n${lignes.length} lignes en base.`);
console.log(`${candidates.length} a indexer${tout ? ' (recalcul complet)' : ''}.\n`);

if (!candidates.length) {
    console.log('Rien a faire. Utiliser --tout pour recalculer.\n');
    process.exit(0);
}

let faits = 0;

for (let i = 0; i < candidates.length; i += LOT) {
    const lot = candidates.slice(i, i + LOT);
    const vecteurs = await vectoriserPassages(lot.map(texteRepresentatif));

    for (const [j, ligne] of lot.entries()) {
        const { error: errMaj } = await db
            .from('connaissances')
            .update({
                embedding: JSON.stringify(vecteurs[j]),
                indexe_le: new Date().toISOString(),
            })
            .eq('id', ligne.id);

        if (errMaj) {
            console.error(`  echec sur "${ligne.nom}" : ${errMaj.message}`);
            process.exit(1);
        }
    }

    faits += lot.length;
    console.log(`  ${faits}/${candidates.length} lignes indexees`);
}

console.log(`\nIndexation terminee. Le chatbot peut interroger ${faits} lignes de plus.\n`);
