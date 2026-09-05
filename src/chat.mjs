// Chatbot vectoriel sur la base de connaissance.
//
// Le principe est celui du reste du projet : le modele ne repond qu'a
// partir de ce qu'on lui montre. Ici, ce sont les lignes de la base les
// plus proches semantiquement de la question - jamais sa memoire propre.
//
// La recherche est deterministe : meme question, memes voisins. Seule la
// redaction de la reponse varie d'un appel a l'autre.

import { vectoriserQuestion } from './vecteurs.mjs';
import { rechercherPlusieurs } from './enrichissement.mjs';

const VOISINS = 6;
const MODELE = 'claude-opus-5';

let claude = null;
let Schema = null;
let SchemaWeb = null;
let zodOutputFormat = null;

async function preparer() {
    if (claude) return;
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("Le chatbot necessite une cle Anthropic (ANTHROPIC_API_KEY dans le .env).");
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { z } = await import('zod');
    ({ zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod'));

    claude = new Anthropic();
    Schema = z.object({
        suffisant: z
            .boolean()
            .describe('true si les passages fournis permettent de repondre a la question'),
        reponse: z
            .string()
            .describe("La reponse, fondee uniquement sur les passages. Si suffisant est false, expliquer brievement ce qui manque."),
        sources: z
            .array(z.number())
            .describe('Numeros des passages reellement utilises pour repondre. Vide si aucun.'),
    });

    SchemaWeb = z.object({
        trouve: z
            .boolean()
            .describe('true si les pages web trouvees repondent reellement a la question'),
        reponse: z
            .string()
            .describe("La reponse, fondee uniquement sur les extraits web fournis."),
        sources: z
            .array(z.number())
            .describe('Numeros des extraits reellement utilises.'),
        nom_suggere: z
            .string()
            .describe("Intitule court (5 mots maximum) sous lequel ce sujet devrait figurer dans la base."),
    });
}

/**
 * Repond a une question en s'appuyant sur la base.
 *
 * Si la base ne sait pas repondre, une recherche web prend le relais -
 * jamais la memoire du modele. Le resultat indique toujours d'ou il vient
 * via le champ 'origine' : 'base', 'web' ou 'aucune'.
 *
 * @param historique tours precedents [{role:'user'|'assistant', contenu}]
 * @returns { origine, reponse, suffisant, sources, propositions, voisins }
 */
export async function repondre(db, question, historique = [], { autoriserWeb = true } = {}) {
    await preparer();

    // Une question de relance ("et son prix ?") se vectorise mal seule.
    // On lui adjoint la question precedente pour retrouver le sujet.
    const derniereQuestion = [...historique].reverse()
        .find((t) => t.role === 'user')?.contenu;
    const pourRecherche = derniereQuestion && question.length < 60
        ? `${derniereQuestion}\n${question}`
        : question;

    const vecteur = await vectoriserQuestion(pourRecherche);

    const { data: voisins, error } = await db.rpc('chercher_voisins', {
        vecteur: JSON.stringify(vecteur),
        nombre: VOISINS,
    });

    if (error) {
        if (/function .*chercher_voisins/i.test(error.message)) {
            throw new Error(
                "La fonction de recherche est absente : execute supabase/migration-02-vecteurs.sql."
            );
        }
        throw new Error(error.message);
    }

    if (!voisins?.length) {
        return {
            origine: 'aucune',
            reponse: "La base ne contient encore aucune ligne indexee. Lance l'indexation avant d'interroger le chatbot.",
            suffisant: false,
            sources: [],
            propositions: [],
            voisins: [],
        };
    }

    // Les passages sont numerotes : le modele cite ces numeros, ce qui
    // permet de raccrocher chaque affirmation a sa ligne d'origine.
    const passages = voisins.map((v, i) => {
        const corps = v.resume || v.texte || '(pas de contenu textuel)';
        return [
            `[${i + 1}] ${v.nom ?? '(sans nom)'}`,
            (v.etiquettes ?? []).length ? `Etiquettes : ${v.etiquettes.join(', ')}` : null,
            v.note_alex ? `Note humaine : ${v.note_alex}` : null,
            `Contenu : ${String(corps).slice(0, 900)}`,
            v.source_url || v.url ? `Source : ${v.source_url || v.url}` : null,
            `Proximite semantique : ${Number(v.similarite).toFixed(3)}`,
        ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');

    const messages = [
        ...historique.slice(-6).map((t) => ({
            role: t.role === 'assistant' ? 'assistant' : 'user',
            content: String(t.contenu),
        })),
        {
            role: 'user',
            content:
                `Question : ${question}\n\n` +
                `Passages extraits de la base de connaissance :\n\n${passages}`,
        },
    ];

    const rep = await claude.messages.parse({
        model: MODELE,
        max_tokens: 4000,
        system:
            "Tu reponds a des questions sur une base de connaissance personnelle. " +
            "Regle absolue : ne t'appuie QUE sur les passages fournis dans le message. " +
            "N'ajoute aucune connaissance exterieure, meme si tu connais le sujet. " +
            "Cite les numeros des passages utilises dans le champ sources. " +
            "Si les passages ne permettent pas de repondre, mets suffisant a false " +
            "et dis simplement ce que la base ne contient pas : ne comble jamais un " +
            "manque par une supposition. " +
            "La proximite semantique indiquee est un repere : en dessous de 0,80 " +
            "environ, le passage a de bonnes chances d'etre hors sujet. " +
            "Reponds en francais, de facon concise.",
        messages,
        output_config: { format: zodOutputFormat(Schema), effort: 'low' },
    });

    const sortie = rep.parsed_output ?? {
        suffisant: false, reponse: 'Reponse illisible.', sources: [],
    };

    // On ne renvoie a l'interface que les voisins reellement cites, pour
    // ne pas laisser croire qu'une source a servi alors qu'elle a ete ecartee.
    const citees = (sortie.sources ?? [])
        .map((n) => voisins[n - 1])
        .filter(Boolean)
        .map((v) => ({
            nom: v.nom,
            url: v.source_url || v.url,
            titre: v.source_titre,
            similarite: v.similarite,
        }));

    // La base repond : on s'arrete la, sans consommer d'appel web.
    if (sortie.suffisant) {
        return {
            origine: 'base',
            reponse: sortie.reponse,
            suffisant: true,
            sources: citees,
            propositions: [],
            voisins: voisins.map((v) => ({ nom: v.nom, similarite: v.similarite })),
        };
    }

    // La base ne sait pas. Plutot que de laisser le modele combler le vide
    // avec sa memoire, on va chercher des sources reelles sur le web.
    if (!autoriserWeb) {
        return {
            origine: 'aucune',
            reponse: sortie.reponse,
            suffisant: false,
            sources: [],
            propositions: [],
            voisins: voisins.map((v) => ({ nom: v.nom, similarite: v.similarite })),
        };
    }

    const web = await chercherSurLeWeb(question, sortie.reponse);
    return {
        ...web,
        voisins: voisins.map((v) => ({ nom: v.nom, similarite: v.similarite })),
    };
}

/**
 * Recours au web quand la base est muette.
 *
 * Meme regle que partout ailleurs : la reponse ne peut s'appuyer que sur
 * les extraits rapportes par la recherche. Le resultat est explicitement
 * marque comme venant du web, jamais confondu avec le contenu de la base.
 */
async function chercherSurLeWeb(question, manqueConstate) {
    let resultats = [];
    try {
        resultats = await rechercherPlusieurs(question, 4);
    } catch (e) {
        return {
            origine: 'aucune',
            reponse: `${manqueConstate}\n\nLa recherche web a echoue : ${e.message}`,
            suffisant: false,
            sources: [],
            propositions: [],
        };
    }

    if (!resultats.length) {
        return {
            origine: 'aucune',
            reponse: `${manqueConstate}\n\nLa recherche web n'a rien donne de suffisamment pertinent non plus.`,
            suffisant: false,
            sources: [],
            propositions: [],
        };
    }

    const extraits = resultats.map((r, i) =>
        [
            `[${i + 1}] ${r.titre ?? '(sans titre)'}`,
            `Adresse : ${r.url}`,
            `Pertinence : ${r.score.toFixed(2)}`,
            `Extrait : ${r.extrait}`,
        ].join('\n')
    ).join('\n\n---\n\n');

    const rep = await claude.messages.parse({
        model: MODELE,
        max_tokens: 4000,
        system:
            "La base de connaissance de l'utilisateur ne contenait pas la reponse. " +
            "Une recherche web vient d'etre lancee. Reponds a partir des SEULS extraits " +
            "fournis ci-dessous. N'ajoute aucune connaissance exterieure, meme si tu " +
            "connais le sujet. Si les extraits ne repondent pas vraiment a la question, " +
            "mets trouve a false et dis-le franchement. " +
            "Propose dans nom_suggere un intitule court sous lequel ce sujet aurait sa " +
            "place dans la base. Reponds en francais, de facon concise.",
        messages: [{
            role: 'user',
            content: `Question : ${question}\n\nExtraits de pages web :\n\n${extraits}`,
        }],
        output_config: { format: zodOutputFormat(SchemaWeb), effort: 'low' },
    });

    const sortie = rep.parsed_output ?? { trouve: false, reponse: '', sources: [], nom_suggere: '' };

    if (!sortie.trouve) {
        return {
            origine: 'aucune',
            reponse: `${manqueConstate}\n\nLa recherche web n'a pas donne de reponse fiable : ${sortie.reponse}`,
            suffisant: false,
            sources: [],
            propositions: [],
        };
    }

    // Les pages citees deviennent des propositions d'ajout : c'est a
    // l'utilisateur de decider ce qui entre dans sa base.
    const citees = (sortie.sources ?? [])
        .map((n) => resultats[n - 1])
        .filter(Boolean);
    const retenues = citees.length ? citees : resultats.slice(0, 2);

    return {
        origine: 'web',
        reponse: sortie.reponse,
        suffisant: true,
        sources: retenues.map((r) => ({ nom: r.titre, url: r.url, similarite: r.score })),
        propositions: retenues.map((r) => ({
            nom: sortie.nom_suggere?.trim() || r.titre,
            titre: r.titre,
            url: r.url,
            score: r.score,
        })),
    };
}
