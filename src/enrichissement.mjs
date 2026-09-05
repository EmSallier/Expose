// Logique d'enrichissement, partagee par le script en ligne de commande
// et par le serveur web. Un seul endroit ou la regle "pas d'invention"
// est ecrite, donc un seul endroit ou elle peut etre affaiblie.

const SEUIL_PERTINENCE = 0.30; // en dessous, le resultat est juge hors sujet
const EXTRAIT_MAX = 1500;      // caracteres conserves de la page source

export const vide = (v) => !v || !String(v).trim();

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

/** Cherche une page decrivant le sujet. Renvoie null si rien de pertinent. */
export async function rechercher(requete) {
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

/** Lit le contenu reel d'une URL connue, pour ancrer le texte dans la bonne page. */
export async function extraire(url) {
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

/**
 * Construit le redacteur de resumes si une cle Anthropic est disponible.
 * Renvoie null sinon : l'enrichissement fonctionne alors sans reformulation.
 */
export async function creerRedacteur() {
    if (!process.env.ANTHROPIC_API_KEY) return null;

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { z } = await import('zod');
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');

    const claude = new Anthropic();
    const modele = 'claude-opus-5';

    const Schema = z.object({
        couvre_le_sujet: z
            .boolean()
            .describe("true seulement si l'extrait decrit reellement le sujet demande"),
        resume: z
            .string()
            .describe("Reformulation de l'extrait en 2 a 3 phrases. Chaine vide si couvre_le_sujet est false."),
    });

    return {
        modele,
        async rediger(sujet, extrait) {
            const rep = await claude.messages.parse({
                model: modele,
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
        },
    };
}

// --- Traitement d'une ligne ------------------------------------------

/**
 * Enrichit une ligne et ecrit le resultat en base.
 *
 * Renvoie { statut, champs, source, resume, message } - le statut vaut
 * 'enrichi', 'non_trouve' ou 'echec'. Aucun champ deja rempli n'est ecrase.
 */
export async function traiterLigne(db, ligne, redacteur, { simuler = false } = {}) {
    const horodatage = new Date().toISOString();

    const marquer = async (maj) => {
        if (simuler) return;
        const { error } = await db.from('connaissances').update(maj).eq('id', ligne.id);
        if (error) throw new Error(error.message);
    };

    try {
        // Ligne avec URL : on lit CETTE page. Sinon on cherche, en
        // s'aidant des etiquettes comme contexte de recherche.
        const source = vide(ligne.url)
            ? await rechercher([ligne.nom, ...(ligne.etiquettes ?? [])].join(' '))
            : await extraire(ligne.url);

        if (!source || vide(source.extrait)) {
            await marquer({ statut: 'non_trouve', enrichi_le: horodatage });
            return { statut: 'non_trouve', message: 'aucune source exploitable' };
        }

        let resume = null;
        if (redacteur) {
            const avis = await redacteur.rediger(ligne.nom, source.extrait);
            if (!avis?.couvre_le_sujet) {
                await marquer({
                    statut: 'non_trouve',
                    erreur: 'source trouvee mais hors sujet',
                    enrichi_le: horodatage,
                });
                return { statut: 'non_trouve', message: 'source hors sujet selon le modele' };
            }
            resume = avis.resume;
        }

        const champs = [];
        const maj = {
            statut: 'enrichi',
            source_url: source.url,
            source_titre: source.titre,
            source_extrait: source.extrait,
            moteur: 'tavily',
            pertinence: source.score,
            erreur: null,
            enrichi_le: horodatage,
        };

        if (vide(ligne.url))   { maj.url = source.url;       champs.push('url'); }
        if (vide(ligne.texte)) { maj.texte = source.extrait; champs.push('texte'); }
        if (resume)            { maj.resume = resume; maj.resume_modele = redacteur.modele; champs.push('resume'); }

        maj.champs_enrichis = champs;
        await marquer(maj);

        return { statut: 'enrichi', champs, source, resume };
    } catch (e) {
        if (!simuler) {
            await db.from('connaissances')
                .update({ statut: 'echec', erreur: String(e.message).slice(0, 500) })
                .eq('id', ligne.id);
        }
        return { statut: 'echec', message: e.message };
    }
}
