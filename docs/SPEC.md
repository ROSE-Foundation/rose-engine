# Rose Engine — Spécification de développement v0.1

> **Statut.** Première spec destinée à Claude Code. Un seul dépôt, deux régimes de qualité explicitement étiquetés :
> - `[PROD]` — Track A / Phase P0 (ledger spine). Code destiné à servir de base de production. À écrire avec rigueur.
> - `[JETABLE]` — Validation du modèle coupled-coin (math + simulateur) et mockups d'écrans. Code volontairement jetable, optimisé pour la vitesse de réfutation. **Ne pas construire de prod dessus.**
>
> Claude Code doit respecter la frontière entre les deux régimes. Ne jamais importer du code `[JETABLE]` dans un module `[PROD]`.

---

## 0. Objectif et non-objectifs

### Objectif
Produire deux choses dans un même dépôt :
1. **`[PROD]`** Un *ledger spine* off-chain en double-entrée, multi-entités, avec un modèle de données de coupled-pair partagé (le contrat d'interface des trois tracks), et un **point d'autorisation unique** pour tout mouvement de capital.
2. **`[JETABLE]`** Une bibliothèque mathématique du coupled-coin + un simulateur de rebalancing sur ticks historiques, qui prouve ou réfute le modèle ; plus des mockups d'écrans statiques pour les parties non encore construites.

### Non-objectifs (explicites — ne pas construire)
- ❌ Pas de smart contracts, pas de déploiement on-chain, pas d'EVM. L'autorisation on-chain est une cible **P3+** (cf. §3.4). En P0, tout est off-chain.
- ❌ Pas d'exchange fonctionnel, pas de matching engine, pas de CLOB, pas d'onboarding client. → mockups statiques uniquement.
- ❌ Pas de multi-asset. Le seul actif de référence est **EUR/USD à L=1** (décision B-1 de la roadmap).
- ❌ Pas de gestion réelle d'argent client, pas d'auth utilisateur, pas de KYC.
- ❌ Pas de résolution des questions parquées (coupon de la Note, split use-of-proceeds, conversion-to-participation). Le code ne doit pas supposer de valeur pour ces paramètres ; il les expose comme configuration non renseignée.

---

# PARTIE I — `[PROD]` Track A / P0 : Ledger spine

## 1. Périmètre P0 (depuis la roadmap, items 1–3)
1. Ledger consolidé en double-entrée : un schéma couvrant *backing float*, *deployed capital*, *segregated client collateral*, *fee income*, *Note liability*.
2. Modèle d'entités : VCC, Holding, Trading Co., Coin Issuer/Exchange — chacune avec ses propres livres, réconciliables en une vue groupe.
3. **Modèle de données partagé du coupled-pair** (Sync 1) — sur-spécifié ci-dessous car c'est le contrat des trois tracks.

## 2. Stack imposée `[PROD]`
- Langage : **TypeScript** (Node 20+) ou **Python 3.12** — choisir l'un, s'y tenir pour toute la partie PROD.
- Base de données : **PostgreSQL**. Pas de SQLite en PROD (les contraintes d'intégrité ci-dessous en dépendent).
- Migrations versionnées et réversibles dès le premier commit (Prisma/Drizzle si TS ; Alembic si Python).
- Tests : les invariants du §3.3 et §3.5 sont couverts par des tests *avant* toute logique applicative au-dessus.

## 3. Modèle de données

### 3.1 Entités
Table `entities` : `id`, `code` (`VCC` | `HOLDING` | `TRADING_CO` | `ISSUER_EXCHANGE`), `jurisdiction`, `created_at`.
Le modèle est figé à ces quatre entités pour P0. Pas de création dynamique d'entités.

### 3.2 Comptes et écritures (double-entrée stricte)
- `accounts` : `id`, `entity_id` (FK), `type` (enum : `BACKING_FLOAT` | `DEPLOYED_CAPITAL` | `CLIENT_COLLATERAL` | `FEE_INCOME` | `NOTE_LIABILITY`), `currency`, `created_at`.
- `journal_entries` : `id`, `created_at`, `description`, `coupled_pair_id` (FK nullable — renseigné si l'écriture concerne une émission/rebalance de pair).
- `postings` : `id`, `journal_entry_id` (FK), `account_id` (FK), `amount` (entier, plus petite unité monétaire — **jamais de float**), `direction` (`DEBIT` | `CREDIT`).

### 3.3 INVARIANT de double-entrée (contrainte en base, non applicative)
Pour chaque `journal_entry`, somme des débits = somme des crédits.
> Implémentation : trigger PostgreSQL `AFTER INSERT/UPDATE` sur `postings`, ou contrainte `DEFERRABLE` vérifiée en fin de transaction. Une écriture déséquilibrée doit faire échouer la transaction. **Cet invariant n'est pas négociable même en v1** (c'est la seule chose qui distingue un ledger d'un tableur).

### 3.4 Modèle de données partagé du coupled-pair — **CONTRAT INTER-TRACKS (Sync 1)**
> ⚠️ C'est l'artefact le plus important de la spec. Une erreur ici se propage aux trois tracks. À sur-spécifier et figer avant le reste.

Table `coupled_pairs` :
| champ | type | sens |
|---|---|---|
| `id` | uuid | identifiant du paquet long+short |
| `reference_asset` | text | `EUR/USD` en P0 |
| `anchor_price` (P₀) | decimal(18,8) | prix d'ancrage courant |
| `leverage` (L) | decimal | `1.0` en P0 |
| `collateral_pool` (K) | bigint | pool cash en plus petite unité, **somme des deux legs** |
| `floor` (f) | decimal | seuil de rebalancing = `m·L·g` (cf. §I-math, partie jetable) |
| `state` | enum | `PENDING` → `ACTIVE` → (`REBALANCING` \| `PARTIAL` \| `SETTLING`) → `CLOSED` |
| `created_at`, `updated_at` | timestamptz | |

**Invariant structurel du pair** : un coupled-pair n'existe jamais comme une jambe seule. Toute opération crée/modifie/clôt les deux legs ensemble. Le schéma ne doit pas permettre de représenter une jambe orpheline persistante (une jambe orpheline transitoire lors d'un rebalance est un état `PARTIAL` explicite, pas l'absence de l'autre).

### 3.5 Autorisation des flux — point d'étranglement unique
> Décision A-2 (roadmap) : enforcement « blocking » à terme. Décision prise pour la v1 : **enforcement applicatif**, mais conçu pour migrer sans réécriture.

- **Toute** mutation de capital passe par une fonction unique `postTransfer(from_account, to_account, amount, context)`. Aucun module n'écrit directement dans `postings` pour un transfert inter-comptes.
- `postTransfer` consulte un `AuthorizationProvider` (interface) **avant** d'écrire. Refus par défaut : si aucune règle n'autorise explicitement, le transfert est rejeté.
- Implémentation P0 de `AuthorizationProvider` : `OffChainPolicyProvider` (fonction locale lisant une table `flow_permissions`).
- **Dette technique assumée et documentée dans le code** : en v1 l'enforcement est applicatif, pas une contrainte de base. L'interface `AuthorizationProvider` existe précisément pour qu'en P3+ on substitue `OnChainPolicyProvider` (appel de smart contract) sans toucher au code appelant. Le code appelant ne sait jamais lequel des deux il interroge.

### 3.6 Règles de flux minimales à encoder (table `flow_permissions`)
- ✅ `FEE_INCOME` (toute entité) → trésorerie : autorisé.
- ✅ yield sur `CLIENT_COLLATERAL` → trésorerie : autorisé (principal exclu, cf. ci-dessous).
- ❌ `CLIENT_COLLATERAL` (principal) → toute destination hors du compte client : **interdit**. C'est la bright line « ségrégation Model A ».
- ❌ tout transfert qui ferait passer le `BACKING_FLOAT` sous son plancher : **interdit** (le plancher est un paramètre de config non renseigné en v1 — cf. question parquée use-of-proceeds ; le code doit lire la valeur de config et refuser si elle est absente plutôt que de supposer 0).

## 4. Réconciliation (P0 minimal)
Une commande `reconcile` qui produit la vue groupe : par entité et par type de compte, les soldes, et vérifie que la somme des livres par entité est cohérente avec la vue consolidée. Sortie : rapport texte/JSON. (La réconciliation cross-juridiction Cayman est P3, hors périmètre.)

## 5. Critères d'acceptation `[PROD]`
- [ ] Une écriture déséquilibrée est rejetée par la base (test).
- [ ] Un transfert de principal de `CLIENT_COLLATERAL` vers la trésorerie est rejeté par `postTransfer` (test).
- [ ] Un transfert non couvert par une règle `flow_permissions` est rejeté par défaut (test).
- [ ] On peut enregistrer une émission de coupled-pair (les deux legs, équilibrée) et la voir dans la vue groupe (test).
- [ ] Substituer une implémentation factice d'`AuthorizationProvider` ne demande aucune modification du code appelant (test prouvant l'isolation de l'interface).

---

# PARTIE II — `[JETABLE]` Validation du modèle

> ⚠️ Tout ce qui suit est jetable. In-memory, pas de base, pas de migrations, pas d'auth. Optimiser pour itérer vite et réfuter le modèle. **Ne sert pas de base de prod.**

## 6. Bibliothèque mathématique du coupled-coin (roadmap items 13)
À implémenter exactement selon la mécanique de référence :

```
r   = (P − P₀) / P₀          # écart de la référence depuis l'ancrage
L   = facteur de levier       # 1× par défaut
K   = pool de collatéral (cash, somme des deux legs)
V_A = (K/2)·(1 + L·r)         # jambe longue
V_B = (K/2)·(1 − L·r)         # jambe courte
INVARIANT : V_A + V_B = K  pour tout P  → émetteur net = 0
floor f = m · L · g           # g = pire gap plausible sur la fenêtre de réaction ; m = marge de sécurité
```
- Tests unitaires : `V_A + V_B == K` pour une grille de prix P (l'invariant émetteur-neutre).
- Tests : aucune jambe ne devient négative tant que P reste dans la barrière ; détection du franchissement du floor.

## 7. Simulateur de rebalancing (roadmap items 14–15)
- Oracle de prix simulé : rejoue des ticks historiques (EUR/USD). Format d'entrée : CSV `timestamp,price`. Pas d'intégration OANDA/LMAX réelle en jetable — un fichier d'exemple suffit.
- **Rebalancing par seuil uniquement** : un reset se déclenche *seulement* quand une jambe perdante passe sous le floor `f`. **Jamais sur horloge** (le rebalancing temporel importerait la décroissance de volatilité des ETF à levier — c'est le piège à éviter).
- Au reset : verrouiller les valeurs dollar courantes, puis ré-ancrer P₀ au prix courant. La perte du holder perdant est verrouillée au reset.
- Sortie : sur un jeu de ticks, prouver qu'aucune jambe ne passe négative et journaliser chaque reset (prix, valeurs verrouillées, nouvel ancrage).
- **Objectif de réfutation** : à L=1 sur EUR/USD, le simulateur doit montrer que le rebalancing ne se déclenche quasiment jamais (barrière ~100% away). Si ce n'est pas le cas, le modèle ou les paramètres sont faux — c'est précisément ce qu'on veut découvrir tôt.

## 8. Mockups d'écrans `[JETABLE]` — statiques, non fonctionnels
> Marqués non-fonctionnels pour que Claude Code ne tente pas de les câbler à de la logique réelle. Aucune donnée live, aucun appel réseau.

Écrans à produire (HTML/React statique, données en dur) :
- **Covenant console** (Track A, P1–P2) : NAV groupe, soldes par entité, yield du float, exposition — valeurs factices.
- **Exchange / trading** (Track C) : carnet d'ordres, interface de trade — purement visuel.
- **Vue coupled-pair** : état d'un pair (V_A, V_B, K, floor, ancrage) — peut afficher une sortie figée du simulateur.

Chaque mockup porte en en-tête visible : `MOCKUP — NON FONCTIONNEL`.

---

## 9. Organisation du dépôt suggérée
```
/prod/            # [PROD] — ne dépend de rien dans /throwaway
  ledger/
  entities/
  authorization/  # AuthorizationProvider + OffChainPolicyProvider
  reconcile/
  migrations/
  tests/
/throwaway/       # [JETABLE] — peut être supprimé sans impact sur /prod
  coupled-math/
  simulator/
  mockups/
SPEC.md
```
**Règle de dépendance, vérifiée en CI si possible** : `/prod` n'importe jamais `/throwaway`. L'inverse est toléré.

## 10. Rappels de séquençage (hérités de la roadmap)
- Aucun composant qui touche de l'argent client réel ou du backing réel n'avance tant que Track A ne prouve pas l'invariant correspondant en logiciel. En P0/jetable, rien ne touche d'argent réel — mais le code ne doit pas créer de chemin par lequel cela deviendrait possible par accident.
- Les paramètres parqués (coupon Note, split use-of-proceeds, plancher contractuel du backing float) ne sont pas inventés par le code : ils sont lus depuis la config et leur absence provoque un refus explicite, pas une valeur par défaut silencieuse.
