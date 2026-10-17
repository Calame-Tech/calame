# Synchronisation RAG — mesure de référence (avant optimisations)

Données brutes : [`baseline.json`](baseline.json). Banc et définitions des
métriques : [`scripts/rag-sync-bench/README.md`](../../../scripts/rag-sync-bench/README.md).

## Commande (à réutiliser telle quelle à l'étape 5)

```bash
node scripts/rag-sync-bench/run-bench.mjs --label baseline \
  --docs 300 --seed 42 --embedder onnx --results-dir docs/benchmarks/rag-sync \
  [--models-root <dossier contenant embeddinggemma-300m/>]
```

**Taille retenue : `--docs 300 --seed 42`.** Une exécution complète dure
≈ 9 min ; `--docs 1000` aurait dépassé ≈ 30 min (l'indexation initiale est
linéaire dans le nombre de chunks embarqués). La mesure « après » doit utiliser
exactement ces paramètres.

## Environnement

| Élément          | Valeur                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| Machine          | Apple M1 Max, 10 cœurs (8 performance + 2 efficacité), 64 Go            |
| OS               | macOS 26.4.1 (Darwin 25.4.0, arm64) — **mesure non native Windows**     |
| Node             | v22.22.3                                                                |
| Threads ONNX     | défaut onnxruntime (non réglable à ce stade)                            |
| Worker parsing   | 1 worker `IsolatedParser` (traitement séquentiel des fichiers)          |
| Code             | `9008cd9` + banc de l'étape 3 (non commité au moment de la mesure)      |
| Date             | 2026-10-16                                                              |

La machine n'était pas dédiée (autres sessions actives) : le load average
système est donc bruité. Une exécution d'essai identique juste avant
(`probe300`, non conservée) a donné initial 524,1 s / partial 7,6 s, soit
≈ 4 % d'écart avec la référence.

## Configuration

- Corpus : 310 fichiers, 9,2 Mo — md 116, txt 62, docx 74, html 29, csv 10, pdf 9,
  dont 10 cas défectueux du dossier `Divers/`.
- Embeddings : EmbeddingGemma-300M q4 local ONNX, lots de 8.
- Plafond de taille 5 Mo (`maxFileSizeBytes`), timeout parsing 120 s,
  timeout document 300 s (valeurs par défaut).
- Partial : 15 éditions, 6 « touch » (mtime seul), 3 ajouts, 3 suppressions,
  détectés par le `WatchManager` (debounce 5 s).

## Résultats par scénario

| Scénario  | Durée   | Indexés / inchangés / rejetés | Débit           | CPU moyen          | RSS max | Boucle d'évén. p50 / p99 / max | Latence `/api/rag/jobs` p95 | Plus long arrêt progression |
| --------- | ------- | ----------------------------- | --------------- | ------------------ | ------- | ------------------------------ | --------------------------- | --------------------------- |
| initial   | 502,1 s | 302 / 0 / 7                   | 0,6 doc/s, 5,8 chunks/s | 4,63 cœurs (46 %) | 1032 Mo | 859 / 3563 / 5956 ms           | 1840 ms (max 5703)          | 54,2 s                      |
| unchanged | 0,03 s  | 0 / 304 / 5                   | 10 335 docs/s   | 1,57 cœur          | 1021 Mo | 10 / 11 / 11 ms                | — (job trop court)          | 0 s                         |
| partial   | 7,4 s   | 18 / 286 / 5 (3 supprimés)    | 7,0 chunks/s    | 4,84 cœurs (48 %)  | 995 Mo  | 263 / 1385 / 1385 ms           | 1257 ms                     | 0 s                         |

Load average 1 min maximal : 44,5 pendant l'initial (bruité, voir plus haut),
7,9 et 7,1 pour unchanged et partial.

### Phases (durée cumulée, % de la durée du scénario)

| Phase | initial                 | unchanged      | partial               |
| ----- | ----------------------- | -------------- | --------------------- |
| walk  | 41 ms (0,0 %)           | 18 ms (60,6 %) | 26 ms (0,3 %)         |
| read  | 706 ms, 308× (0,1 %)    | 1 ms, 4×       | 44 ms, 28× (0,6 %)    |
| hash  | 26 ms, 308× (0,0 %)     | 0,2 ms, 4×     | 1,7 ms, 28×           |
| parse | 789 ms, 306× (0,2 %)    | 3,5 ms, 4×     | 17 ms, 22× (0,2 %)    |
| chunk | 405 ms, 302× (0,1 %)    | —              | 10 ms, 18× (0,1 %)    |
| embed | 499,5 s, 301× (99,5 %), max 56,4 s pour un document | — | 7,2 s, 18× (97,6 %) |
| write | 536 ms, 302× (0,1 %)    | —              | 47 ms, 18× (0,6 %)    |

Préchauffage ONNX : 1,26 s. Watcher : 27 événements, premier à 119 ms,
1 seule synchronisation déclenchée (5,5 s après la modification), 561 ms CPU.

Cohérence après chaque scénario : chunks = vecteurs = lignes FTS
(2901 → 2901 → 2875), 304 documents vivants.

Rejets (initial) avec leur raison : `parse_failed` pour `Contrat tronqué.docx`,
`Rapport corrompu.docx`, `Sans contenu Word.docx`, `Scan illisible.pdf` ;
`too_large` pour `Export complet.txt` ; `unsupported` pour `Données brutes.bin`
et `Présentation client.pptx`. `~$Rapport annuel.docx` est ignoré. Les
synchronisations se terminent en `completed` (pas d'échec d'infrastructure).

## Goulets observés

1. **Embeddings ONNX = 99,5 % du temps** de l'indexation initiale et 97,6 % de
   la mise à jour partielle. Parcours, lecture, parsing, découpage et écritures
   SQLite cumulés restent sous 2,5 s pour 300 documents : les optimiser
   n'apporterait rien de mesurable.
2. **Charge CPU** : ≈ 4,6 cœurs occupés en continu sur 10 avec les threads
   onnxruntime par défaut — c'est la cause probable du « PC lent » rapporté.
3. **Réactivité du serveur** : l'inférence bloque la boucle d'événements
   (p50 0,86 s, max 6 s) ; la requête de l'historique répond en 1,8 s au p95.
4. **Progression irrégulière** : le compteur n'avance qu'entre deux documents ;
   un gros document (DOCX ≈ 400 Ko de texte) bloque la progression 54 s.
5. **Incrémental déjà efficace** : la resynchronisation sans changement ne
   relance ni parsing ni embeddings des 304 documents inchangés (fast-path
   etag) ; la partielle ne réembarque que les 18 documents modifiés/ajoutés, et
   le watcher ne déclenche qu'une synchronisation. Seul reste : les 4 fichiers
   en échec de parsing sont relus et reparsés à chaque passage (coût ≈ 5 ms ici).
6. Mémoire : RSS ≈ 1 Go, dominé par le modèle ONNX chargé (stable entre
   scénarios).

Pistes pour l'étape 4 : limiter les threads ONNX, céder la boucle
d'événements entre lots, émettre une progression intra-document pendant
l'embedding, ajuster la taille des lots — en mesurant le compromis sur la
durée totale.

## Limites

- Mesure sur macOS uniquement ; aucune validation native Windows n'est
  revendiquée. Les verrous Word ne sont couverts que par des tests simulés.
- Réactivité mesurée côté processus serveur, pas dans la webview Tauri.
- Une seule exécution conservée ; variation d'environ 4 % observée entre deux
  exécutions sur une machine non dédiée.
