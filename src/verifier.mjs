// Diagnostic de connexion : verifie que tout est en place avant d'importer
// quoi que ce soit. Chaque test affiche ce qui va, ce qui bloque, et comment
// le corriger.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const ok = (m) => console.log(`  OK    ${m}`);
const ko = (m, aide) => {
    console.log(`  ECHEC ${m}`);
    if (aide) console.log(`        -> ${aide}`);
};

let echecs = 0;

console.log('\n=== Verification de la configuration ===\n');

// --- 1. Variables d'environnement ---
console.log('[1] Fichier .env');

const url = process.env.SUPABASE_URL;
const cle = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cleTavily = process.env.TAVILY_API_KEY;

if (!url) {
    ko('SUPABASE_URL absente', 'Copie .env.example en .env et renseigne la valeur');
    echecs++;
} else if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url)) {
    ko(`SUPABASE_URL a un format inattendu : ${url}`,
       'Attendu : https://xxxxxxxx.supabase.co');
    echecs++;
} else {
    ok(`SUPABASE_URL = ${url}`);
}

if (!cle) {
    ko('SUPABASE_SERVICE_ROLE_KEY absente',
       'Project Settings > API > service_role (cliquer pour reveler)');
    echecs++;
} else {
    ok(`SUPABASE_SERVICE_ROLE_KEY presente (${cle.length} caracteres)`);
}

if (!cleTavily) {
    ko('TAVILY_API_KEY absente', 'Cle gratuite sur https://app.tavily.com');
    echecs++;
} else {
    ok(`TAVILY_API_KEY presente (${cleTavily.length} caracteres)`);
}

if (!url || !cle) {
    console.log('\nImpossible de continuer sans les identifiants Supabase.\n');
    process.exit(1);
}

// --- 2. Connexion et schema ---
console.log('\n[2] Base Supabase');

const db = createClient(url, cle, { auth: { persistSession: false } });

const { error: errTable, count } = await db
    .from('connaissances')
    .select('*', { count: 'exact', head: true });

if (errTable) {
    if (errTable.code === '42P01' || /does not exist/i.test(errTable.message)) {
        ko("la table 'connaissances' n'existe pas",
           'Ouvre le SQL Editor de Supabase et execute supabase/schema.sql');
    } else {
        ko(`connexion refusee : ${errTable.message}`,
           'Verifie que la cle service_role correspond bien a ce projet');
    }
    echecs++;
} else {
    ok(`table 'connaissances' accessible (${count} ligne${count > 1 ? 's' : ''})`);
}

const { error: errVue } = await db.from('a_enrichir').select('id').limit(1);
if (errVue) {
    ko("la vue 'a_enrichir' est absente", 'Rejoue supabase/schema.sql en entier');
    echecs++;
} else {
    ok("vue 'a_enrichir' accessible");
}

// --- 3. API de recherche web ---
console.log('\n[3] API Tavily');

if (!cleTavily) {
    ko('test ignore : pas de cle');
} else {
    try {
        const rep = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cleTavily}`,
            },
            body: JSON.stringify({ query: 'test de connexion', max_results: 1 }),
        });

        if (rep.ok) {
            const data = await rep.json();
            ok(`recherche fonctionnelle (${data.results?.length ?? 0} resultat)`);
        } else if (rep.status === 401) {
            ko('cle Tavily refusee (401)', 'Verifie la cle sur https://app.tavily.com');
            echecs++;
        } else {
            ko(`Tavily a repondu ${rep.status}`, await rep.text());
            echecs++;
        }
    } catch (e) {
        ko(`appel impossible : ${e.message}`, 'Probleme reseau ou proxy d entreprise ?');
        echecs++;
    }
}

console.log(
    echecs === 0
        ? '\nTout est pret. Etape suivante : npm run importer\n'
        : `\n${echecs} point(s) a corriger avant de continuer.\n`
);

process.exit(echecs === 0 ? 0 : 1);
