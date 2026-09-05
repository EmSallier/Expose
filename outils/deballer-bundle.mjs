// Deballe un fichier HTML "bundled" produit par un outil de design.
//
// Le format : un manifeste d'actifs gzippes en base64, et un gabarit HTML
// qui les reference par identifiant. Le navigateur les reassemble au
// chargement. Ici on fait le meme travail hors ligne, pour disposer du
// code source lisible.
//
// Usage : node outils/deballer-bundle.mjs <fichier.html> <dossier-sortie>

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const [, , entree, sortie = 'design/deballe'] = process.argv;

if (!entree) {
    console.error('Usage : node outils/deballer-bundle.mjs <fichier.html> [dossier-sortie]');
    process.exit(1);
}

const html = await readFile(entree, 'utf8');

const extraire = (type) => {
    const motif = new RegExp(
        `<script[^>]*type=["']__bundler/${type}["'][^>]*>([\\s\\S]*?)</script>`,
        'i'
    );
    const m = html.match(motif);
    if (!m) throw new Error(`Bloc "${type}" introuvable dans ${entree}`);
    return JSON.parse(m[1]);
};

const manifeste = extraire('manifest');
const gabarit = extraire('template');

await mkdir(sortie, { recursive: true });

console.log(`\n${Object.keys(manifeste).length} actifs dans le manifeste :\n`);

const contenus = {};

for (const [id, actif] of Object.entries(manifeste)) {
    const octets = Buffer.from(actif.data, 'base64');
    const clair = actif.compressed ? gunzipSync(octets) : octets;

    contenus[id] = { mime: actif.mime, buffer: clair };

    const extension =
        actif.mime.includes('javascript') ? 'js' :
        actif.mime.includes('css') ? 'css' :
        actif.mime.includes('html') ? 'html' :
        actif.mime.includes('json') ? 'json' :
        actif.mime.split('/')[1]?.split(';')[0] ?? 'bin';

    const nom = `${id.slice(0, 8)}.${extension}`;
    await writeFile(path.join(sortie, nom), clair);

    const taille = (clair.length / 1024).toFixed(1);
    console.log(`  ${nom.padEnd(16)} ${actif.mime.padEnd(26)} ${taille.padStart(9)} Ko`);
}

await writeFile(path.join(sortie, '_gabarit.html'), gabarit, 'utf8');
console.log(`  ${'_gabarit.html'.padEnd(16)} ${'text/html'.padEnd(26)} ${(gabarit.length / 1024).toFixed(1).padStart(9)} Ko`);

console.log(`\nDeballe dans ${sortie}/\n`);
