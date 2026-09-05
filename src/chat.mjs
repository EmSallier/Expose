// Chatbot vectoriel sur la base de connaissance.
//
// Le principe est celui du reste du projet : le modele ne repond qu'a
// partir de ce qu'on lui montre. Ici, ce sont les lignes de la base les
// plus proches semantiquement de la question - jamais sa memoire propre.
//
// La recherche est deterministe : meme question, memes voisins. Seule la
// redaction de la reponse varie d'un appel a l'autre.

import { vectoriserQuestion } from './vecteurs.mjs';

const VOISINS = 6;
const MODELE = 'claude-opus-5';

let claude = null;
let Schema = null;
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
}

/**
 * Repond a une question en s'appuyant sur la base.
 *
 * @param historique tours precedents [{role:'user'|'assistant', contenu}]
 * @returns { reponse, suffisant, sources, voisins }
 */
export async function repondre(db, question, historique = []) {
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
            reponse: "La base ne contient encore aucune ligne indexee. Lance l'indexation avant d'interroger le chatbot.",
            suffisant: false,
            sources: [],
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

    return {
        reponse: sortie.reponse,
        suffisant: sortie.suffisant,
        sources: citees,
        voisins: voisins.map((v) => ({ nom: v.nom, similarite: v.similarite })),
    };
}
