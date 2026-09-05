// Fabrique une maquette autonome de l'interface, destinee au travail de
// design : meme structure et meme CSS que la page reelle, mais avec des
// donnees figees a l'interieur.
//
// La page reelle ne s'affiche pas sans son serveur, ce qui la rend
// inutilisable dans un outil de design. La maquette, elle, s'ouvre d'un
// double-clic n'importe ou.
//
// Usage : node outils/construire-maquette.mjs   (serveur lance)

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const SERVEUR = 'http://localhost:3000';
const SORTIE = 'design/maquette.html';

// --- Recuperation d'un echantillon representatif ---------------------

let toutes;
try {
    toutes = await (await fetch(`${SERVEUR}/api/lignes`)).json();
} catch {
    console.error(`Le serveur ne repond pas sur ${SERVEUR}. Lance "npm run site" d'abord.`);
    process.exit(1);
}

const premier = (predicat) => toutes.find(predicat);

// Un exemplaire de chaque cas : c'est ce qui doit rester lisible apres
// une refonte graphique. Une maquette qui ne montre qu'un cas nominal
// laisse les etats degrades sans traitement visuel.
const echantillon = [
    premier((l) => l.statut === 'enrichi' && l.note_alex && l.resume && l.texte),
    premier((l) => l.statut === 'enrichi' && l.resume && l.pertinence),
    premier((l) => l.statut === 'enrichi' && (l.etiquettes ?? []).length >= 2),
    premier((l) => l.statut === 'non_trouve' && l.url),
    premier((l) => l.statut === 'non_trouve' && !l.url),
    premier((l) => l.statut === 'en_attente' && l.nom),
    premier((l) => l.statut === 'echec'),
    premier((l) => l.nom && l.nom.startsWith('http')),
].filter(Boolean);

// Doublons possibles si une ligne coche plusieurs cases
const vus = new Set();
const lignesMaquette = echantillon.filter((l) => !vus.has(l.id) && vus.add(l.id));

// Certains etats peuvent etre absents de la base au moment de la
// generation - il n'y a par exemple aucun echec aujourd'hui. Sans
// exemplaire, une refonte les laisserait sans traitement visuel. On
// complete donc avec des lignes fictives, signalees comme telles.
const FICTIFS = {
    echec: {
        id: 'fictif-echec',
        nom: 'EXEMPLE FICTIF — page inaccessible',
        statut: 'echec',
        etiquettes: ['exemple'],
        erreur: 'Tavily extract a repondu 403',
        note_alex: null, texte: null, resume: null,
        url: 'https://site-protege.example/page',
        source_url: null, source_titre: null, pertinence: null,
        champs_enrichis: [], indexe_le: null,
    },
};

for (const [statut, ligne] of Object.entries(FICTIFS)) {
    if (!lignesMaquette.some((l) => l.statut === statut)) {
        lignesMaquette.push(ligne);
        console.log(`  (etat "${statut}" absent de la base : exemplaire fictif ajoute)`);
    }
}

// Les compteurs du bandeau doivent refleter la vraie base, pas
// l'echantillon : c'est l'ordre de grandeur reel qu'on doit designer.
const statistiques = toutes.reduce((a, l) => (a[l.statut] = (a[l.statut] ?? 0) + 1, a), {});

console.log(`${lignesMaquette.length} lignes retenues sur ${toutes.length}.`);
console.log('Cas couverts :', lignesMaquette.map((l) => l.statut).join(', '));

// --- Transformation de la page ---------------------------------------

let html = await readFile('public/index.html', 'utf8');

// 1. charger() lit les donnees figees au lieu d'appeler le serveur
html = html.replace(
    /async function charger\(\) \{[\s\S]*?\n\}/,
    `async function charger() {
  lignes = DONNEES_MAQUETTE;
  afficherEntete();
  rendre();
}`
);

// 2. Les actions d'ecriture n'ont plus de serveur : on les neutralise
//    en affichant ce qu'elles auraient fait.
html = html.replace(
    /async function agir\(url, corps, libelle\) \{[\s\S]*?\n\}/,
    `async function agir(url, corps, libelle) {
  annoncer('Maquette : « ' + libelle + ' » n'est pas actif ici.');
  return {};
}`.replace("n'est", "n\\'est")
);

// 3. Les compteurs affichent les volumes reels
html = html.replace(
    /const par = lignes\.reduce\(\(a, l\) => \(a\[l\.statut\] = \(a\[l\.statut\] \?\? 0\) \+ 1, a\), \{\}\);/,
    'const par = STATISTIQUES_REELLES;'
);
html = html.replace(
    /\['Lignes', lignes\.length\],/,
    `['Lignes', ${toutes.length}],`
);
html = html.replace(
    /b\.querySelector\('\.compte'\)\.textContent = f === 'tous' \? lignes\.length : \(par\[f\] \?\? 0\);/,
    `b.querySelector('.compte').textContent = f === 'tous' ? ${toutes.length} : (par[f] ?? 0);`
);

// 4. Injection des donnees et d'une conversation d'exemple, pour que le
//    panneau de dialogue soit designable lui aussi.
const injection = `
<script>
// ================================================================
//  MAQUETTE - donnees figees, aucune connexion reseau.
//  Genere par outils/construire-maquette.mjs
// ================================================================
const DONNEES_MAQUETTE = ${JSON.stringify(lignesMaquette, null, 2)};
const STATISTIQUES_REELLES = ${JSON.stringify(statistiques)};

// Aucune requete ne doit sortir de cette page. Les gestionnaires qui
// appelaient le serveur (suppression, ajout, dialogue) recoivent ici une
// reponse claire au lieu d'une erreur reseau incomprehensible.
window.fetch = async () => ({
    ok: true,
    json: async () => ({ erreur: "Maquette : cette action nécessite le serveur du projet." }),
});
</script>
`;

html = html.replace('<script>\nconst LIBELLES', `${injection}<script>\nconst LIBELLES`);

// 5. Conversation d'exemple, ajoutee apres le chargement
const conversation = `
<script>
// Remplit le panneau de dialogue avec un echange representatif :
// une reponse issue de la base, puis une reponse venue du web avec
// ses propositions d'ajout. Les deux etats doivent etre designes.
window.addEventListener('load', () => {
  setTimeout(() => {
    const c = document.getElementById('discussion-corps');
    if (!c) return;
    c.innerHTML = \`
      <div class="bulle moi">Quels artistes travaillent sur la surveillance ?</div>
      <div class="bulle robot">
        <div class="origine base">◆ Réponse issue de ta base</div>Plusieurs artistes de la base touchent à ces sujets : Marta Revuelta (profilage biométrique, Genève), Adam Harvey (CV Dazzle, camouflage anti-reconnaissance faciale) et Sarah Ciston (AI War Cloud Database).
        <div class="sources">
          <div class="sources-titre">Lignes utilisées</div>
          <div class="source-item"><a href="#">Marta Revuelta — Media Artist</a> <span class="prox">· proximité 0.86</span></div>
          <div class="source-item"><a href="#">Adam Harvey — Anti-Fragile Sycophants</a> <span class="prox">· proximité 0.81</span></div>
        </div>
      </div>
      <div class="bulle moi">Et sur les imprimantes 3D résine grand format ?</div>
      <div class="bulle robot web">
        <div class="origine web">🌐 Réponse trouvée sur le web — absente de ta base</div>Trois modèles reviennent : la Formlabs Form 4L, la Peopoly Phenom XXL et la Elegoo Jupiter SE. Les extraits comparent volumes d'impression et prix.
        <div class="sources">
          <div class="sources-titre">Pages web citées</div>
          <div class="source-item"><a href="#">Comparaison des imprimantes 3D résine grand format</a> <span class="prox">· pertinence 0.82</span></div>
        </div>
        <div class="propositions">
          <div class="propositions-titre">Ajouter à la base ?</div>
          <div class="proposition">
            <div class="proposition-texte">
              <strong>Imprimantes 3D résine grand format</strong>
              <a href="#">lopmate.com/fr/articles-comparaison</a>
            </div>
            <button>＋ Ajouter</button>
          </div>
          <div class="proposition ajoutee">
            <div class="proposition-texte">
              <strong>Formlabs Form 4L</strong>
              <a href="#">formlabs.com/fr/3d-printers/form-4l</a>
            </div>
            <button disabled>✓ Ajoutée</button>
          </div>
        </div>
      </div>\`;
  }, 300);
});
</script>
`;

html = html.replace('</body>', `${conversation}</body>`);

// 6. Un mot en tete du fichier, pour qui l'ouvrira sans contexte
html = `<!-- ================================================================
     MAQUETTE de l'interface "Base de connaissance".

     Fichier autonome : aucune dependance, aucun serveur, aucun appel
     reseau. Les donnees sont figees dans le bloc DONNEES_MAQUETTE.

     Etats a preserver lors d'une refonte :
       - carte enrichie : note humaine, resume, source brute repliee
       - carte sans source (ambre) et carte en echec (rose)
       - panneau de dialogue : reponse base (vert) vs web (bleu)
       - propositions d'ajout, dont une deja ajoutee
       - theme sombre (media prefers-color-scheme)

     Regenerer avec : node outils/construire-maquette.mjs
     ================================================================ -->
${html}`;

await mkdir('design', { recursive: true });
await writeFile(SORTIE, html, 'utf8');

console.log(`\nMaquette ecrite : ${SORTIE}`);
console.log('Elle s\'ouvre directement dans un navigateur, sans serveur.\n');
