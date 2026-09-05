// Calcul des vecteurs semantiques, en local.
//
// Le modele multilingual-e5-small est telecharge une fois (~120 Mo) puis
// mis en cache. Aucune donnee de la base ne quitte le poste a cette etape.
//
// Particularite de la famille E5 : le texte doit etre prefixe selon son
// role. "query: " pour une question, "passage: " pour un document indexe.
// Omettre ces prefixes degrade nettement la qualite du classement.

import { pipeline } from '@huggingface/transformers';

const MODELE = 'Xenova/multilingual-e5-small';
export const DIMENSIONS = 384;
const LONGUEUR_MAX = 1200; // au-dela, le modele tronque de toute facon

let encodeur = null;

async function charger() {
    if (!encodeur) {
        encodeur = await pipeline('feature-extraction', MODELE);
    }
    return encodeur;
}

/** Prepare le modele a l'avance, pour ne pas payer l'attente au premier appel. */
export const prechauffer = charger;

async function encoder(textes) {
    const enc = await charger();
    const sortie = await enc(textes, { pooling: 'mean', normalize: true });
    const [n, d] = sortie.dims;
    const plat = Array.from(sortie.data);
    return Array.from({ length: n }, (_, i) => plat.slice(i * d, (i + 1) * d));
}

/** Vecteur d'une question posee par l'utilisateur. */
export async function vectoriserQuestion(question) {
    const [v] = await encoder([`query: ${String(question).slice(0, LONGUEUR_MAX)}`]);
    return v;
}

/** Vecteurs d'un lot de documents a indexer. */
export async function vectoriserPassages(textes) {
    return encoder(textes.map((t) => `passage: ${String(t).slice(0, LONGUEUR_MAX)}`));
}

/**
 * Construit le texte representatif d'une ligne.
 *
 * L'ordre compte : le nom d'abord, puis la note humaine (souvent la plus
 * dense en information utile), puis le resume, puis le texte source en
 * dernier recours. Le modele accorde plus de poids au debut.
 */
export function texteRepresentatif(ligne) {
    return [
        ligne.nom,
        (ligne.etiquettes ?? []).join(', '),
        ligne.note_alex,
        ligne.resume,
        ligne.resume ? null : ligne.texte, // le texte brut seulement faute de resume
    ]
        .filter((p) => p && String(p).trim())
        .join('\n')
        .slice(0, LONGUEUR_MAX);
}
