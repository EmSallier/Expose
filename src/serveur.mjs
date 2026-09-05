// Serveur local de consultation et d'enrichissement de la base.
//
// La cle service_role donne un acces total a la base : elle reste ici,
// cote serveur. La page HTML ne recoit que des donnees, jamais la cle.
//
// Points d'acces :
//   GET  /api/lignes         etat courant de la base
//   POST /api/enrichir       complete toutes les lignes en attente
//   POST /api/reessayer      remet les 'sans source' en attente, puis complete
//   POST /api/ligne/url      remplace l'adresse d'une ligne et la recomplete
//   POST /api/ligne          cree une ligne, puis la complete

import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { creerRedacteur, traiterLigne } from './enrichissement.mjs';
import { repondre } from './chat.mjs';
import { vectoriserPassages, texteRepresentatif, prechauffer } from './vecteurs.mjs';

const PORT = Number(process.env.PORT) || 3000;
const PAUSE_MS = 350;

const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const redacteur = await creerRedacteur();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Un seul enrichissement a la fois : deux traitements simultanes se
// marcheraient dessus et consommeraient du credit API pour rien.
let enCours = false;

const json = (rep, code, corps) => {
    rep.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    rep.end(JSON.stringify(corps));
};

async function lireCorps(req) {
    const morceaux = [];
    for await (const m of req) morceaux.push(m);
    if (!morceaux.length) return {};
    try {
        return JSON.parse(Buffer.concat(morceaux).toString('utf8'));
    } catch {
        throw new Error('corps de requete illisible');
    }
}

const CHAMPS = 'id, nom, note_alex, texte, resume, url, etiquettes, statut, ' +
    'source_url, source_titre, source_extrait, moteur, resume_modele, ' +
    'pertinence, champs_enrichis, enrichi_le, erreur, indexe_le';

/** Traite une liste de lignes et renvoie le bilan. */
async function enrichirLot(lignes) {
    const bilan = { enrichi: 0, non_trouve: 0, echec: 0, details: [] };

    for (const ligne of lignes) {
        const r = await traiterLigne(db, ligne, redacteur);
        bilan[r.statut]++;
        bilan.details.push({
            nom: ligne.nom,
            statut: r.statut,
            champs: r.champs ?? [],
            message: r.message ?? null,
        });
        await pause(PAUSE_MS);
    }
    return bilan;
}

/** Les lignes qui meritent un traitement : un nom, et au moins un champ vide. */
async function lignesEnAttente() {
    const { data, error } = await db
        .from('a_enrichir')
        .select('id, nom, texte, url, etiquettes')
        .order('nom');
    if (error) throw new Error(error.message);
    return data;
}

const serveur = createServer(async (req, rep) => {
    const chemin = new URL(req.url, `http://${req.headers.host}`).pathname;

    try {
        // ---- Page ----
        if (req.method === 'GET' && (chemin === '/' || chemin === '/index.html')) {
            const html = await readFile('public/index.html', 'utf8');
            rep.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return rep.end(html);
        }

        // ---- Lecture ----
        if (req.method === 'GET' && chemin === '/api/lignes') {
            const { data, error } = await db
                .from('connaissances')
                .select(CHAMPS)
                .order('nom', { nullsFirst: false });
            if (error) return json(rep, 500, { erreur: error.message });
            return json(rep, 200, data);
        }

        // ---- Chatbot ----
        // Hors du verrou d'ecriture : poser une question n'ecrit rien et
        // ne doit pas attendre la fin d'un enrichissement en cours.
        if (req.method === 'POST' && chemin === '/api/chat') {
            const { question, historique } = await lireCorps(req);
            if (!String(question ?? '').trim()) {
                return json(rep, 400, { erreur: 'question vide' });
            }
            try {
                const r = await repondre(db, String(question).trim(), historique ?? []);
                return json(rep, 200, r);
            } catch (e) {
                return json(rep, 500, { erreur: e.message });
            }
        }

        // ---- Ecritures : une seule a la fois ----
        if (req.method === 'POST') {
            if (enCours) {
                return json(rep, 409, { erreur: 'Un traitement est deja en cours.' });
            }
            enCours = true;
            try {
                // Completer tout ce qui est en attente
                if (chemin === '/api/enrichir') {
                    const lignes = await lignesEnAttente();
                    if (!lignes.length) {
                        return json(rep, 200, {
                            bilan: { enrichi: 0, non_trouve: 0, echec: 0, details: [] },
                            message: 'Aucune ligne en attente : tout est deja traite.',
                        });
                    }
                    return json(rep, 200, { bilan: await enrichirLot(lignes) });
                }

                // Indexer les lignes que le chatbot ne voit pas encore
                if (chemin === '/api/indexer') {
                    const { data, error } = await db
                        .from('connaissances')
                        .select('id, nom, note_alex, resume, texte, etiquettes, embedding');
                    if (error) return json(rep, 500, { erreur: error.message });

                    const aFaire = data.filter(
                        (l) => !l.embedding && texteRepresentatif(l).trim()
                    );
                    if (!aFaire.length) {
                        return json(rep, 200, { message: 'Toutes les lignes exploitables sont deja indexees.' });
                    }

                    for (let i = 0; i < aFaire.length; i += 16) {
                        const lot = aFaire.slice(i, i + 16);
                        const vecteurs = await vectoriserPassages(lot.map(texteRepresentatif));
                        for (const [j, l] of lot.entries()) {
                            await db.from('connaissances')
                                .update({
                                    embedding: JSON.stringify(vecteurs[j]),
                                    indexe_le: new Date().toISOString(),
                                })
                                .eq('id', l.id);
                        }
                    }
                    return json(rep, 200, {
                        message: `${aFaire.length} ligne${aFaire.length > 1 ? 's' : ''} indexee${aFaire.length > 1 ? 's' : ''}.`,
                    });
                }

                // Remettre les 'sans source' en attente, puis reessayer
                if (chemin === '/api/reessayer') {
                    const { error } = await db
                        .from('connaissances')
                        .update({ statut: 'en_attente', erreur: null })
                        .in('statut', ['non_trouve', 'echec']);
                    if (error) return json(rep, 500, { erreur: error.message });

                    const lignes = await lignesEnAttente();
                    return json(rep, 200, { bilan: await enrichirLot(lignes) });
                }

                // Nouvelle adresse sur une ligne existante
                if (chemin === '/api/ligne/url') {
                    const { id, url } = await lireCorps(req);
                    if (!id || !url) return json(rep, 400, { erreur: 'id et url requis' });
                    if (!/^https?:\/\//i.test(url)) {
                        return json(rep, 400, { erreur: "L'adresse doit commencer par http:// ou https://" });
                    }

                    // On remet la ligne a zero cote machine, sans toucher
                    // au nom, a la note humaine ni aux etiquettes.
                    const { data: maj, error } = await db
                        .from('connaissances')
                        .update({
                            url,
                            statut: 'en_attente',
                            texte: null, resume: null, resume_modele: null,
                            source_url: null, source_titre: null, source_extrait: null,
                            pertinence: null, champs_enrichis: [], erreur: null,
                        })
                        .eq('id', id)
                        .select('id, nom, texte, url, etiquettes')
                        .single();
                    if (error) return json(rep, 500, { erreur: error.message });

                    const r = await traiterLigne(db, maj, redacteur);
                    return json(rep, 200, { resultat: r.statut, message: r.message ?? null });
                }

                // Creation d'une ligne, puis completion immediate
                if (chemin === '/api/ligne') {
                    const { nom, url, etiquettes } = await lireCorps(req);
                    const intitule = String(nom ?? '').trim() || String(url ?? '').trim();
                    if (!intitule) return json(rep, 400, { erreur: 'un nom ou une adresse est requis' });
                    if (url && !/^https?:\/\//i.test(url)) {
                        return json(rep, 400, { erreur: "L'adresse doit commencer par http:// ou https://" });
                    }

                    const { data: creee, error } = await db
                        .from('connaissances')
                        .insert({
                            nom: intitule,
                            url: url || null,
                            etiquettes: Array.isArray(etiquettes) ? etiquettes : [],
                            statut: 'en_attente',
                        })
                        .select('id, nom, texte, url, etiquettes')
                        .single();
                    if (error) return json(rep, 500, { erreur: error.message });

                    const r = await traiterLigne(db, creee, redacteur);
                    return json(rep, 200, { id: creee.id, resultat: r.statut, message: r.message ?? null });
                }
            } finally {
                enCours = false;
            }
        }

        rep.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        rep.end('Page introuvable');
    } catch (e) {
        json(rep, 500, { erreur: e.message });
    }
});

serveur.listen(PORT, async () => {
    console.log(`\n  Base de connaissance consultable sur http://localhost:${PORT}`);
    console.log(`  Reformulation : ${redacteur?.modele ?? 'desactivee (pas de cle Anthropic)'}`);
    console.log('  Ctrl+C pour arreter.\n');

    // Le modele de vecteurs met ~25 s a se charger la premiere fois. On
    // absorbe cette attente maintenant plutot qu'a la premiere question.
    console.log('  Chargement du modele de vecteurs en arriere-plan...');
    try {
        await prechauffer();
        console.log('  Modele de vecteurs pret : le chatbot peut repondre.\n');
    } catch (e) {
        console.log(`  Modele de vecteurs indisponible : ${e.message}\n`);
    }
});
