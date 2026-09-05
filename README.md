# Base de connaissance

Exercice pratique : une base de connaissance personnelle qui se complète
elle-même par recherche web réelle, s'interroge en langage naturel, et
refuse d'inventer.

Le fil conducteur du projet est une contrainte unique : **aucune information
ne peut entrer dans la base sans une source vérifiable**. Tout le reste en
découle.

## Ce que fait le projet

- **Importe** un CSV de 144 lignes dans Supabase
- **Complète** les champs vides par recherche web (Tavily), en conservant
  l'extrait brut de la page source à côté de sa reformulation
- **Répond** aux questions par recherche vectorielle sur la base
- **Cherche sur le web** quand la base est muette, et propose d'ajouter la
  page trouvée
- **Capture** une page depuis Chrome via une extension

## Les trois garde-fous contre l'invention

**1. Une contrainte en base.** Une ligne ne peut pas être marquée `enrichi`
sans URL source ni extrait :

```sql
check (statut <> 'enrichi'
       or (source_url is not null and source_extrait is not null))
```

C'est le garde-fou le plus solide : il ne dépend d'aucun code applicatif.
Un bug ne peut pas le contourner, PostgreSQL rejetterait l'écriture.

**2. Un seuil de pertinence.** Les résultats de recherche trop faibles sont
écartés. La ligne passe en `non_trouve` et reste vide.

**3. Le jugement du modèle.** Claude déclare si l'extrait décrit réellement
le sujet. S'il répond non, rien n'est écrit — même avec un bon score.

Sur 62 lignes traitées, 12 ont été refusées. Une base qui se remplit à 100 %
serait suspecte.

## Mise en route

```bash
npm install
cp .env.example .env    # puis renseigner les clés
npm run verifier        # diagnostic complet avant tout traitement
```

Trois clés sont nécessaires dans `.env` :

| Clé | Où l'obtenir | Coût |
|---|---|---|
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API | gratuit |
| `TAVILY_API_KEY` | [app.tavily.com](https://app.tavily.com) | gratuit, 1000 recherches/mois |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | à l'usage, quelques centimes |

Les migrations SQL de `supabase/` sont à exécuter dans l'ordre depuis le
SQL Editor de Supabase.

## Commandes

```bash
npm run verifier    # vérifie clés, connexion, table, vue, API
npm run importer    # importe le CSV
npm run enrichir    # complète les champs vides
npm run indexer     # calcule les vecteurs sémantiques
npm run site        # lance l'interface sur localhost:3000
```

## Extension Chrome

Dans `extension/`. Installation :

1. `chrome://extensions` → activer le **mode développeur**
2. **Charger l'extension non empaquetée** → choisir le dossier `extension`
3. Le serveur local doit tourner (`npm run site`)

Raccourci `Ctrl+Maj+K` sur n'importe quelle page.

## Architecture

```
CSV → Supabase ─┬─→ enrichissement (Tavily + Claude) → colonnes texte/resume
                │
                ├─→ indexation (modèle local) → vecteurs 384 dimensions
                │
                └─→ chatbot : question → vecteur → voisins → Claude
                              └─ si muet → recherche web → proposition d'ajout
```

Les embeddings sont calculés **en local** par `multilingual-e5-small` :
aucune donnée de la base ne sort du poste pour cette étape, et aucune clé
supplémentaire n'est requise.

La logique d'enrichissement vit dans un seul module
(`src/enrichissement.mjs`), partagé par la ligne de commande et le serveur.
Il n'existe donc qu'un endroit où les garde-fous sont écrits.

## Note sur le « non déterministe »

La recherche vectorielle est **déterministe** : même question, mêmes voisins.
Seule la rédaction de la réponse varie. Le choix des sources est donc
reproductible, ce qui n'est pas le cas de leur mise en mots.
