// Enrichissement des champs vides par recherche web reelle.
//
// Trois garde-fous contre l'invention :
//
//   1. Toute information provient d'un appel HTTP a Tavily. Aucune donnee
//      n'est produite de memoire, ni par le script ni par le modele.
//   2. 'texte' recoit l'extrait mot pour mot de la page source. 'resume'
//      recoit une reformulation de ce seul extrait, jamais autre chose.
//      Les deux sont visibles cote a cote : la comparaison est possible.
//   3. Si la source trouvee ne parle pas du sujet, la ligne passe en
//      'non_trouve' et reste vide. Ne rien ecrire est un resultat valide.
//
// Usage :
//   node src/enrichir.mjs              enrichit tout ce qui est en attente
//   node src/enrichir.mjs --limite 5   s'arrete apres 5 lignes (test)
//   node src/enrichir.mjs --simuler    n'ecrit rien en base, affiche seulement

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SEUIL_PERTINENCE = 0.30; // en dessous, le resultat est juge hors sujet
const EXTRAIT_MAX = 1500;      // caracteres conserves de la page source
const PAUSE_MS = 350;          // respiration entre deux appels API

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
const vide = (v) => !v || !String(v).trim();

// --- Appels Tavily ---------------------------------------------------

async function tavily(chemin, corps) {
    const rep = await fetch(`https://api.tavily.com/${chemin}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify(corps),
    });
    if (!rep.ok) throw new Error(`Tavily ${chemin} a repondu ${rep.status}`);
    return rep.json();
}

// Cherche une page decrivant le sujet. Renvoie null si rien de pertinent.
async function rechercher(requete) {
    const data = await tavily('search', { query: requete, max_results: 3 });
    const meilleur = (data.results ?? [])[0];
    if (!meilleur || meilleur.score < SEUIL_PERTINENCE) return null;
    return {
        url: meilleur.url,
        titre: meilleur.title,
        extrait: String(meilleur.content ?? '').slice(0, EXTRAIT_MAX),
        score: meilleur.score,
    };
}

// Lit le contenu reel d'une URL deja connue, pour ancrer le texte dans la
// bonne page plutot que dans un resultat de recherche approximatif.
async function extraire(url) {
    const data = await tavily('extract', { urls: [url] });
    const res = (data.results ?? [])[0];
    if (!res?.raw_content) return null;

    const sansImages = String(res.raw_content)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return {
        url: res.url ?? url,
        titre: res.title ?? null,
        extrait: sansImages.slice(0, EXTRAIT_MAX),
        score: null,
    };
}

// --- Reformulation par Claude (facultative) --------------------------

let redigerResume = null;
let modeleUtilise = null;

if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { z } = await import('zod');
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');

    const claude = new Anthropic();
    modeleUtilise = 'claude-opus-5';

    const Schema = z.object({
        couvre_le_sujet: z
            .boolean()
            .describe("true seulement si l'extrait decrit reellement le sujet demande"),
        resume: z
            .string()
            .describe("Reformulation de l'extrait en 2 a 3 phrases. Chaine vide si couvre_le_sujet est false."),
    });

    redigerResume = async (sujet, extrait) => {
        const rep = await claude.messages.parse({
            model: modeleUtilise,
            max_tokens: 4000,
            system:
                "Tu reformules un extrait de page web. Regle absolue : n'utilise QUE " +
                "les informations presentes dans l'extrait fourni. N'ajoute aucune " +
                "connaissance exterieure, meme si tu connais le sujet. Si l'extrait ne " +
                "parle pas du sujet demande, mets couvre_le_sujet a false et laisse le " +
                "resume vide : ne rien dire est preferable a inventer.",
            messages: [
                {
                    role: 'user',
                    content: `Sujet recherche : ${sujet}\n\nExtrait de la page :\n"""\n${extrait}\n"""`,
                },
            ],
            output_config: { format: zodOutputFormat(Schema), effort: 'low' },
        });
        return rep.parsed_output;
    };
}

// --- Traitement ------------------------------------------------------

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
console.log(`Reformulation : ${modeleUtilise ?? 'desactivee (pas de cle Anthropic)'}`);
if (simuler) console.log('MODE SIMULATION : rien ne sera ecrit en base.');
console.log('');

const bilan = { enrichi: 0, non_trouve: 0, echec: 0 };

for (const [i, ligne] of aTraiter.entries()) {
    console.log(`[${i + 1}/${aTraiter.length}] ${ligne.nom.slice(0, 55)}`);

    try {
        // Si la ligne porte deja une URL, on lit CETTE page.
        // Sinon on cherche, en s'aidant des etiquettes comme contexte.
        const source = vide(ligne.url)
            ? await rechercher([ligne.nom, ...(ligne.etiquettes ?? [])].join(' '))
            : await extraire(ligne.url);

        if (!source || vide(source.extrait)) {
            bilan.non_trouve++;
            console.log('        aucune source exploitable -> non_trouve');
            if (!simuler) {
                await db
                    .from('connaissances')
                    .update({ statut: 'non_trouve', enrichi_le: new Date().toISOString() })
                    .eq('id', ligne.id);
            }
            await pause(PAUSE_MS);
            continue;
        }

        // Verification par le modele, quand il est disponible.
        let resume = null;
        if (redigerResume) {
            const avis = await redigerResume(ligne.nom, source.extrait);
            if (!avis?.couvre_le_sujet) {
                bilan.non_trouve++;
                console.log('        source hors sujet selon le modele -> non_trouve');
                if (!simuler) {
                    await db
                        .from('connaissances')
                        .update({
                            statut: 'non_trouve',
                            erreur: 'source trouvee mais hors sujet',
                            enrichi_le: new Date().toISOString(),
                        })
                        .eq('id', ligne.id);
                }
                await pause(PAUSE_MS);
                continue;
            }
            resume = avis.resume;
        }

        // Construction de la mise a jour : on ne touche qu'aux champs vides.
        const champs = [];
        const maj = {
            statut: 'enrichi',
            source_url: source.url,
            source_titre: source.titre,
            source_extrait: source.extrait,
            moteur: 'tavily',
            pertinence: source.score,
            enrichi_le: new Date().toISOString(),
        };

        if (vide(ligne.url)) {
            maj.url = source.url;
            champs.push('url');
        }
        if (vide(ligne.texte)) {
            maj.texte = source.extrait;
            champs.push('texte');
        }
        if (resume) {
            maj.resume = resume;
            maj.resume_modele = modeleUtilise;
            champs.push('resume');
        }

        maj.champs_enrichis = champs;

        if (!simuler) {
            const { error: errMaj } = await db
                .from('connaissances')
                .update(maj)
                .eq('id', ligne.id);
            if (errMaj) throw new Error(errMaj.message);
        }

        bilan.enrichi++;
        const score = source.score
            ? ` (score ${source.score.toFixed(2)})`
            : ' (page lue directement)';
        console.log(`        ${champs.join(', ')} <- ${source.url.slice(0, 60)}${score}`);
        if (resume) console.log(`        resume : ${resume.slice(0, 90)}...`);
    } catch (e) {
        bilan.echec++;
        console.log(`        ECHEC : ${e.message}`);
        if (!simuler) {
            await db
                .from('connaissances')
                .update({ statut: 'echec', erreur: e.message.slice(0, 500) })
                .eq('id', ligne.id);
        }
    }

    await pause(PAUSE_MS);
}

console.log('\n--- Bilan ---');
console.log(`  ${bilan.enrichi} enrichies`);
console.log(`  ${bilan.non_trouve} sans source exploitable`);
console.log(`  ${bilan.echec} en echec`);
console.log('');
