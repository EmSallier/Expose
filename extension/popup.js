// Fenetre d'ajout de l'extension.
//
// Elle dialogue avec le serveur local du projet. Aucune cle d'API n'est
// embarquee ici : le serveur detient les identifiants, l'extension ne fait
// que lui transmettre une adresse. Une extension distribuee ne peut pas
// garder un secret - tout ce qu'elle contient est lisible par l'utilisateur.

const SERVEUR = 'http://localhost:3000';

const champNom = document.getElementById('nom');
const champEtiquettes = document.getElementById('etiquettes');
const champNote = document.getElementById('note');
const zoneAdresse = document.getElementById('adresse');
const bouton = document.getElementById('envoyer');
const etat = document.getElementById('etat');

let urlCourante = null;

function afficher(message, type = 'info') {
    etat.hidden = false;
    etat.className = `etat ${type}`;
    etat.innerHTML = message;
}

// Un titre de page se termine souvent par le nom du site apres un
// separateur. On le retire : l'intitule reste modifiable de toute facon.
function titrePropre(titre) {
    if (!titre) return '';
    const court = titre.split(/\s+[|·–—]\s+/)[0].trim();
    return (court.length >= 8 ? court : titre.trim()).slice(0, 120);
}

async function initialiser() {
    const [onglet] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!onglet?.url || !/^https?:\/\//i.test(onglet.url)) {
        zoneAdresse.textContent = '—';
        afficher("Cette page ne peut pas être ajoutée : seules les adresses http et https sont acceptées.", 'avertir');
        return;
    }

    urlCourante = onglet.url;
    zoneAdresse.textContent = urlCourante;
    champNom.value = titrePropre(onglet.title);
    bouton.disabled = false;
    champNom.focus();
    champNom.select();

    // Le serveur tourne-t-il ? Et la page est-elle deja connue ?
    try {
        const rep = await fetch(`${SERVEUR}/api/existe?url=${encodeURIComponent(urlCourante)}`);
        const data = await rep.json();

        if (data.existe) {
            afficher(
                `Cette page figure déjà dans la base sous « <strong>${data.ligne?.nom ?? '?'}</strong> ». ` +
                `L'ajouter créerait un doublon.`,
                'avertir'
            );
        }
    } catch {
        bouton.disabled = true;
        afficher(
            `Le serveur local ne répond pas.<br>Lance <strong>npm run site</strong> dans le dossier du projet, puis rouvre cette fenêtre.`,
            'erreur'
        );
    }
}

bouton.addEventListener('click', async () => {
    const nom = champNom.value.trim();
    if (!nom) {
        afficher('Donne un intitulé à cette page.', 'avertir');
        champNom.focus();
        return;
    }

    bouton.disabled = true;
    bouton.textContent = 'Lecture de la page…';
    afficher('Le serveur lit la page, la résume et l’indexe. Quelques secondes.', 'info');

    const etiquettes = champEtiquettes.value
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);

    try {
        const rep = await fetch(`${SERVEUR}/api/ligne`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nom,
                url: urlCourante,
                etiquettes,
                note: champNote.value.trim(),
            }),
        });

        const data = await rep.json();
        if (data.erreur) throw new Error(data.erreur);

        if (data.resultat === 'enrichi') {
            bouton.textContent = '✓ Ajoutée';
            afficher(
                `Page ajoutée, résumée et indexée. ` +
                `<a href="${SERVEUR}" target="_blank">Ouvrir la base</a>`,
                'succes'
            );
        } else {
            // La ligne existe, mais le contenu n'a pas pu etre recupere.
            bouton.textContent = '✓ Ajoutée';
            afficher(
                `Page ajoutée, mais son contenu n'a pas pu être exploité ` +
                `(${data.resultat}). Elle figure dans la base sans résumé. ` +
                `<a href="${SERVEUR}" target="_blank">Ouvrir la base</a>`,
                'avertir'
            );
        }
    } catch (e) {
        bouton.disabled = false;
        bouton.textContent = 'Ajouter à la base';
        afficher(`Échec : ${e.message}`, 'erreur');
    }
});

// Ctrl+Entree envoie, comme dans la plupart des formulaires
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !bouton.disabled) bouton.click();
});

initialiser();
