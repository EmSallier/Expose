// Serveur local de consultation de la base de connaissance.
//
// La cle service_role donne un acces total a la base : elle doit rester
// ici, cote serveur. La page HTML ne recoit que des donnees deja filtrees,
// jamais la cle elle-meme. C'est la raison d'etre de ce serveur - sans lui,
// une page statique devrait embarquer un identifiant dans son code source.

import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT) || 3000;

const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const json = (rep, code, corps) => {
    rep.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    rep.end(JSON.stringify(corps));
};

const serveur = createServer(async (req, rep) => {
    const chemin = new URL(req.url, `http://${req.headers.host}`).pathname;

    try {
        if (chemin === '/' || chemin === '/index.html') {
            const html = await readFile('public/index.html', 'utf8');
            rep.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return rep.end(html);
        }

        if (chemin === '/api/lignes') {
            const { data, error } = await db
                .from('connaissances')
                .select(
                    'id, nom, note_alex, texte, resume, url, etiquettes, statut, ' +
                    'source_url, source_titre, source_extrait, moteur, resume_modele, ' +
                    'pertinence, champs_enrichis, enrichi_le, erreur'
                )
                .order('nom', { nullsFirst: false });

            if (error) return json(rep, 500, { erreur: error.message });
            return json(rep, 200, data);
        }

        rep.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        rep.end('Page introuvable');
    } catch (e) {
        json(rep, 500, { erreur: e.message });
    }
});

serveur.listen(PORT, () => {
    console.log(`\n  Base de connaissance consultable sur http://localhost:${PORT}`);
    console.log('  Ctrl+C pour arreter.\n');
});
