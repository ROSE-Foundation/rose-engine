# Rose Engine — Maquettes d'écrans `[JETABLE]`

Maquettes statiques **non fonctionnelles** (SPEC §8). Aucune donnée réelle,
aucune logique, aucun appel réseau — toutes les valeurs sont fictives et chaque
écran porte le bandeau `MOCKUP — NON FONCTIONNEL`.

Implémentées à partir du bundle de handoff Claude Design : les prototypes
`.dc.html` (rendus par un runtime React `support.js`) ont été convertis en HTML
standard autonome — `<x-dc>`/`<helmet>` retirés, l'attribut runtime
`style-hover` traduit en règles CSS `:hover` réelles, liens recâblés. Le rendu
visuel est identique aux prototypes ; seules les polices IBM Plex sont chargées
depuis Google Fonts (connexion requise pour la typo, le reste fonctionne
hors-ligne).

## Point d'entrée

Ouvre **`index.html`** — le hub présente les trois écrans en cartes cliquables.

## Écrans

| Fichier | Écran |
|---|---|
| `index.html` | Hub / parcours des maquettes |
| `covenant-console.html` | Covenant console — NAV groupe, soldes par entité, bright lines (un breach démontré) |
| `coupled-pair.html` | Vue coupled-pair — K, V_A, V_B, P₀, floor de rebalancing, historique des resets |
| `exchange-trading.html` | Exchange / trading — carnet d'ordres + ticket de trade (cEUR/USD), purement visuel |
| `base.html` | Base visuelle — palette, typographie, composants (table dense, carte KPI) |

Navigation : barre latérale (Treasury → Covenant, Exchange → Trading, Coins →
Coupled pair), wordmark « Rose Engine » → retour au hub, cartes du hub → écrans.

> `[JETABLE]` — code volontairement jetable. Ne pas construire de production
> dessus ni l'importer depuis `/prod` (SPEC §9).
