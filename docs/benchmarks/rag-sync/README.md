# Synchronisation RAG — mesures avant / après

Suite du retour testeur Windows (synchronisations très longues sur gros
corpus, PC saturé, arrêt global sur un DOCX problématique). Ce document
compare la mesure de référence ([`baseline.md`](baseline.md), avant
optimisations) et la mesure après les optimisations de l'étape 4, sur **le
même corpus et la même commande**, et donne la procédure Windows.

Données brutes : [`baseline.json`](baseline.json), [`after.json`](after.json),
[`after-onnx-default-threads.json`](after-onnx-default-threads.json) (contrôle).
Banc, scénarios et définitions des métriques :
[`scripts/rag-sync-bench/README.md`](../../../scripts/rag-sync-bench/README.md).

## Commandes

```bash
pnpm install
pnpm model:fetch    # modèle ONNX local, une fois (ou --models-root <dossier>)

# Avant (commit 9008cd9 + banc) et après (HEAD) — paramètres identiques
node scripts/rag-sync-bench/run-bench.mjs --label after \
  --docs 300 --seed 42 --embedder onnx --results-dir docs/benchmarks/rag-sync \
  [--models-root <dossier contenant embeddinggemma-300m/>]

# Contrôle : même code « après », threads ONNX laissés au défaut onnxruntime
CALAME_LOCAL_EMBEDDING_THREADS=0 node scripts/rag-sync-bench/run-bench.mjs \
  --label after-onnx-default-threads --docs 300 --seed 42 --embedder onnx \
  --results-dir docs/benchmarks/rag-sync [--models-root …]

# Tests automatisés (isolation, timeouts, verrous, incrémental, cohérence)
pnpm test
```

## Environnement et configuration (identiques pour toutes les mesures)

| Élément    | Valeur                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| Machine    | Apple M1 Max, 10 cœurs (8 P + 2 E), 64 Go — non dédiée                                                                  |
| OS         | macOS 26.4.1 (Darwin 25.4.0, arm64) — **aucune mesure native Windows**                                                  |
| Node       | v22.22.3                                                                                                                |
| Corpus     | `--docs 300 --seed 42` : 310 fichiers, 9,2 Mo (md 116, txt 62, docx 74, html 29, csv 10, pdf 9), dont 10 cas défectueux |
| Embeddings | EmbeddingGemma-300M q4, ONNX local, 2048 tokens max                                                                     |
| Limites    | plafond 5 Mo (source), timeout parsing 120 s (dur, worker terminé), timeout document 300 s                              |
| Partial    | 15 éditions, 6 « touch », 3 ajouts, 3 suppressions, détectés par le watcher                                             |
| Date       | 2026-10-16                                                                                                              |

Ce qui change entre avant et après, ce sont uniquement les **défauts de
production** de l'étape 4 :

| Paramètre                          | Avant                                  | Après                                                            |
| ---------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Threads ONNX (`intraOpNumThreads`) | défaut onnxruntime (≈ 1/cœur physique) | min(4, max(1, CPU/2)) → 4 ici ; `CALAME_LOCAL_EMBEDDING_THREADS` |
| Lot d'embeddings                   | 8 textes                               | 4 textes, avec reprise de la boucle d'événements entre lots      |
| Progression                        | entre deux documents                   | aussi pendant l'embedding d'un long document (≤ 1 écriture/s)    |
| Timeout document (soft)            | durée totale                           | inactivité (réarmé à chaque lot embarqué)                        |
| Fichier rejeté inchangé            | relu et reparsé à chaque sync          | mémorisé (même etag) : rapporté sans relecture                   |
| Watcher pendant une sync           | événement ignoré                       | une seule sync de rattrapage, jamais superposée                  |

Concurrence : une seule synchronisation par source (`SyncQueue`), un seul
worker de parsing (`IsolatedParser`) et une file d'inférence ONNX sérialisée —
la concurrence est donc bornée à 1 document en vol. Paralléliser le parsing
n'aurait rien apporté (< 0,2 % du temps, voir les phases) et aurait augmenté la
charge, alors que le goulet est l'inférence ONNX, déjà multithread.

## Résultats par scénario

| Scénario  | Mesure | Durée   | Débit         | CPU moyen         | RSS max | Boucle d'évén. p50 / p99 / max | `/api/rag/jobs` p95 / max | Plus long arrêt progression |
| --------- | ------ | ------- | ------------- | ----------------- | ------- | ------------------------------ | ------------------------- | --------------------------- |
| initial   | avant  | 502,1 s | 5,8 chunks/s  | 4,63 cœurs (46 %) | 1032 Mo | 859 / 3563 / 5956 ms           | 1840 / 5703 ms            | 54,2 s                      |
| initial   | après  | 459,1 s | 6,3 chunks/s  | 3,99 cœurs (40 %) | 909 Mo  | 461 / 1211 / 1303 ms           | 856 / 1139 ms             | 1,0 s                       |
| unchanged | avant  | 0,03 s  | 10 335 docs/s | —                 | 1021 Mo | 10 / 11 / 11 ms                | —                         | 0 s                         |
| unchanged | après  | 0,02 s  | 13 111 docs/s | —                 | 858 Mo  | 10 / 10 / 10 ms                | —                         | 0 s                         |
| partial   | avant  | 7,4 s   | 7,0 chunks/s  | 4,84 cœurs (48 %) | 995 Mo  | 263 / 1385 / 1385 ms           | 1257 / 1257 ms            | 0 s                         |
| partial   | après  | 7,8 s   | 6,7 chunks/s  | 3,99 cœurs (40 %) | 861 Mo  | 354 / 1089 / 1089 ms           | 839 / 839 ms              | 0 s                         |

Contrôle — même code « après », exécuté juste après sur la même machine, avec
`CALAME_LOCAL_EMBEDDING_THREADS=0` (threads au défaut onnxruntime, lots de 4) :

| Scénario | Durée   | Débit        | CPU moyen         | RSS max | Boucle d'évén. p99 / max | `/api/rag/jobs` p95 / max | Plus long arrêt progression |
| -------- | ------- | ------------ | ----------------- | ------- | ------------------------ | ------------------------- | --------------------------- |
| initial  | 411,3 s | 7,0 chunks/s | 4,95 cœurs (50 %) | 916 Mo  | 1097 / 1178 ms           | 744 / 1072 ms             | 1,0 s                       |
| partial  | 6,9 s   | 7,5 chunks/s | 4,94 cœurs (49 %) | 887 Mo  | 985 / 985 ms             | 735 / 735 ms              | 0 s                         |

Load average 1 min maximal pendant l'initial : 44,5 (avant), 9,1 (après),
7,3 (contrôle).

Bilans identiques avant/après (statut `completed`, aucun échec
d'infrastructure) : initial 302 indexés / 7 rejetés ; unchanged 304 inchangés
/ 5 rejetés ; partial 18 indexés, 286 inchangés, 5 rejetés, 3 supprimés.
Cohérence chunks = vecteurs = lignes FTS après chaque scénario
(2901 → 2901 → 2875), 304 documents vivants. Le « CPU moyen » de unchanged
n'est pas significatif (job de 20–30 ms).

### Phases (durée cumulée, nombre d'appels)

| Phase | initial avant                | initial après                | unchanged avant | unchanged après | partial avant  | partial après  |
| ----- | ---------------------------- | ---------------------------- | --------------- | --------------- | -------------- | -------------- |
| walk  | 41 ms                        | 36 ms                        | 18 ms           | 17 ms           | 26 ms          | 22 ms          |
| read  | 706 ms, 308×                 | 394 ms, 308×                 | 1 ms, 4×        | **0×**          | 44 ms, 28×     | 10 ms, **24×** |
| hash  | 26 ms, 308×                  | 18 ms, 308×                  | 0,2 ms, 4×      | **0×**          | 1,7 ms, 28×    | 1 ms, 24×      |
| parse | 789 ms, 306×                 | 633 ms, 306×                 | 3,5 ms, 4×      | **0×**          | 17 ms, 22×     | 13 ms, **18×** |
| chunk | 405 ms, 302×                 | 346 ms, 302×                 | —               | —               | 10 ms, 18×     | 8 ms, 18×      |
| embed | 499,5 s (99,5 %), max 56,4 s | 457,2 s (99,6 %), max 46,9 s | —               | —               | 7,2 s (97,6 %) | 7,7 s (98,4 %) |
| write | 536 ms, 302×                 | 463 ms, 302×                 | —               | —               | 47 ms, 18×     | 41 ms, 18×     |

Watcher (partial) : 27 événements, 1 seule synchronisation déclenchée
(5,5 s après la modification, debounce 5 s) avant comme après ; CPU du watcher
561 ms → 178 ms. Préchauffage ONNX 1,26 s → 0,97 s.

## Lecture des résultats et compromis

1. **Charge machine (« PC lent »)** : −14 % de CPU moyen pendant l'indexation
   initiale (4,63 → 3,99 cœurs) et −18 % pendant la partielle (4,84 → 3,99).
   Sur cette machine le plafond retenu est 4 threads ; sur un portable
   Windows 4 cœurs/8 threads il serait de 4 également, sur 4 CPU logiques de 2 :
   l'effet relatif y est plus fort qu'ici, où 10 cœurs laissent déjà de la marge.
2. **Réactivité du serveur** : la boucle d'événements n'est plus bloquée que
   par un lot de 4 textes (max 6,0 s → 1,3 s, p99 3,6 s → 1,2 s) ; la requête
   de l'historique répond en 0,86 s au p95 au lieu de 1,84 s.
3. **Progression régulière** : le plus long intervalle sans avancée visible
   passe de 54,2 s (un gros DOCX) à 1,0 s, la cadence d'écriture choisie.
4. **Incrémental** : resync sans changement et partielle ne relisent ni ne
   reparsent plus les fichiers déjà rejetés et inchangés (read/parse 4× → 0×
   en unchanged, 22 → 18 parsings en partial). Les documents inchangés ne sont
   ni parsés ni embarqués, avant comme après (fast-path etag).
5. **Durée** : l'initial passe de 502 s à 459 s (−9 %) et la partielle de 7,4 s
   à 7,8 s (+5 %). **Ce gain de durée n'est pas attribué aux optimisations** :
   la référence a tourné sur une machine plus chargée (load average 1 min max
   44,5 contre 9,1), et moins de threads ne peut pas accélérer l'inférence à
   charge égale (micro-benchmark de l'étape 4 : ≈ −10 % de débit à 4 threads).
   Le contrôle à charge comparable le confirme : à threads non plafonnés, le
   même code indexe en 411 s avec 4,95 cœurs ; le plafond de 4 threads coûte
   donc **+12 % de durée (411 → 459 s) pour −19 % de CPU (4,95 → 3,99 cœurs)**.
   Lots de 4 et progression intra-document apportent leur gain de réactivité
   indépendamment des threads (boucle d'événements max ≈ 1,2 s dans les deux
   runs « après » contre 6 s avant). Le compromis attendu est donc une durée égale ou un peu plus
   longue en échange d'une machine nettement moins saturée ;
   `CALAME_LOCAL_EMBEDDING_THREADS=0` revient au comportement précédent.
6. **Mémoire** : RSS maximal −12 % (1032 → 909 Mo), essentiellement l'effet de
   lots plus petits ; le modèle ONNX chargé reste le poste dominant.

Le goulet reste l'inférence ONNX (≈ 99,5 % du temps) : la durée de
l'indexation initiale est proportionnelle au nombre de chunks embarqués. Les
gains structurels possibles hors périmètre de cette mission : modèle plus
petit, ou exécution de l'inférence dans un thread/processus séparé à priorité
basse (onnxruntime-node l'exécute sur le thread principal).

## Couverture des cas défectueux

Tests automatisés (`pnpm test`, macOS/Linux, **simulés** pour les
particularités Windows) — principalement
`ee/rag-core/src/routes/__tests__/rag-sync-isolation.test.ts`,
`ee/rag-core/src/parsers/__tests__/isolated-parser.test.ts`,
`ee/rag-core/src/parsers/__tests__/docx.test.ts`,
`ee/rag-core/src/jobs/__tests__/watch-manager.test.ts`,
`ee/rag-core/src/embeddings/__tests__/local-onnx-client.test.ts` :

| Cas                                           | Comportement vérifié                                                                                     | Nature                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------ |
| DOCX corrompu / tronqué / sans `document.xml` | rejeté `parse_failed`, les autres documents sont indexés                                                 | réel (vrais fichiers)          |
| Parseur qui lève                              | rejet du seul fichier, sync `completed`                                                                  | réel                           |
| Parseur en boucle synchrone                   | worker terminé au timeout dur, nouveau worker pour la suite, aucun worker abandonné                      | réel                           |
| Fichier trop gros                             | rejet `too_large` au listing ou à la lecture (flux détruit au dépassement)                               | réel                           |
| Verrou Word (`EBUSY`, `EPERM`, `EAGAIN`)      | 3 tentatives max (0,5 s puis 1 s), puis rejet `locked`, retenté à la sync suivante (jamais mémorisé)     | **simulé** (erreurs injectées) |
| Accès refusé (`EACCES`), fichier disparu      | rejet `unreadable` sans retry                                                                            | **simulé**                     |
| `~$*.docx`                                    | ignorés, séparateurs `/` et `\`                                                                          | réel + chemins Windows simulés |
| Chemins Windows (`C:\…`, UNC `\\serveur\…`)   | détection `~$` quel que soit le séparateur ; chemins relatifs normalisés en `/`                          | **simulé** (chaînes)           |
| Échec d'une mise à jour                       | la dernière version indexée est conservée (chunks + vecteurs + FTS intacts), puis remplacée à la reprise | réel                           |
| Nouveau fichier en échec                      | aucune ligne partielle, aucun vecteur orphelin                                                           | réel                           |
| Panne embeddings / stockage / listing         | statut d'échec global d'infrastructure, pas une série de fichiers corrompus                              | réel                           |
| Timeout en cours                              | la progression continue d'avancer                                                                        | réel                           |
| Resync incrémentale                           | inchangé → ni parsing ni embedding ; édition → seul le fichier concerné                                  | réel                           |
| Watcher pendant une sync                      | une sync de rattrapage, jamais deux en parallèle                                                         | réel                           |

## Procédure Windows (à exécuter nativement — non réalisée à ce jour)

Aucune mesure ni validation native Windows n'est revendiquée ici : tous les
chiffres ci-dessus viennent de macOS, et les comportements propres à Windows
(verrous Word, chemins `\`, UNC) n'ont été couverts que par des tests simulés.
Pour valider sur Windows 10/11 x64 (PowerShell) :

1. Prérequis : Node 22, pnpm (`corepack enable`), Git ; antivirus temps réel
   noté dans le rapport (Defender scanne chaque fichier lu et fausse `read`).
2. Préparer :
   ```powershell
   git clone <repo> calame; cd calame
   pnpm install
   pnpm model:fetch
   ```
3. Tests automatisés : `pnpm test` (doit être vert comme sur macOS/Linux).
4. Banc, mêmes paramètres, sur un disque local (pas OneDrive, qui
   déclenche des téléchargements/verrous) :
   ```powershell
   node scripts/rag-sync-bench/run-bench.mjs --label windows-after `
     --docs 300 --seed 42 --embedder onnx --results-dir docs/benchmarks/rag-sync
   $env:CALAME_LOCAL_EMBEDDING_THREADS = "0"
   node scripts/rag-sync-bench/run-bench.mjs --label windows-onnx-default-threads `
     --docs 300 --seed 42 --embedder onnx --results-dir docs/benchmarks/rag-sync
   Remove-Item Env:CALAME_LOCAL_EMBEDDING_THREADS
   ```
   Le rapport JSON contient `environment.nativeWindows: true`. Pendant
   l'initial, noter la fluidité ressentie (navigateur, Explorateur) et le CPU
   du Gestionnaire des tâches, que le banc ne capte pas.
5. Verrou Word réel : dans l'app desktop installée, créer une base sur un
   dossier contenant des DOCX ; ouvrir l'un d'eux dans Word (le fichier
   `~$…docx` apparaît) ; lancer une synchronisation. Attendu : le `~$…docx`
   n'apparaît pas dans l'historique ; si Word verrouille le fichier, il est
   signalé `locked` après au plus 3 tentatives (≈ 1,5 s), les autres fichiers
   sont indexés, la sync se termine avec fichiers ignorés et non en échec.
   Fermer Word, resynchroniser : le fichier est indexé.
6. DOCX corrompu réel : copier `Divers/Rapport corrompu.docx` du corpus généré
   (`node scripts/rag-sync-bench/generate-corpus.mjs --out C:\tmp\corpus --docs 300 --seed 42`)
   dans le dossier de la base, synchroniser : rejet nommé avec une raison
   lisible, synchronisation terminée.
7. Consigner dans un `windows.md` à côté de ce fichier : version de Windows,
   CPU (cœurs/threads), RAM, antivirus, disque, commit, résultats des deux
   runs, observations des étapes 5–6.

## Limites

- Mesures macOS uniquement, une exécution par configuration, sur une machine
  non dédiée (écart ≈ 4 % observé entre deux runs identiques à l'étape 3 ; la
  charge de fond de la référence était plus élevée).
- Corpus de 300 documents (≈ 8 min par exécution) plutôt que des milliers :
  l'indexation initiale est linéaire dans le nombre de chunks, les autres
  phases sont négligeables, l'extrapolation est donc directe mais non mesurée.
- Réactivité mesurée côté processus serveur (API interrogée par l'UI), pas
  dans la webview Tauri ; la charge du reste de la machine n'est approchée que
  par le CPU du processus et le load average.
- Le plafond de threads réduit la charge mais pas la durée ; l'inférence
  reste sur le thread principal du serveur (stalls ≈ 1 s par lot).
