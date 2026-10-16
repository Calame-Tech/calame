# Banc de mesure de la synchronisation RAG

Mesure où partent le temps et la charge d'une synchronisation de base de
connaissances « dossier local » (le cas de l'app desktop), sur un corpus
synthétique reproductible. Résultats consignés dans
[`docs/benchmarks/rag-sync/`](../../docs/benchmarks/rag-sync/).

## Commandes

```bash
pnpm install
pnpm model:fetch                      # modèle ONNX local (≈ 200 Mo), une fois

# Référence (avant optimisations), même config pour la mesure « après »
node scripts/rag-sync-bench/run-bench.mjs --label baseline \
  --docs 1000 --seed 42 --embedder onnx --results-dir docs/benchmarks/rag-sync

# Variante rapide sans ONNX (isole parcours / parsing / écritures)
node scripts/rag-sync-bench/run-bench.mjs --label fake --docs 1000 --embedder fake

# Corpus seul
node scripts/rag-sync-bench/generate-corpus.mjs --out /tmp/corpus --docs 1000 --seed 42
```

Options : `--out <dir>` (corpus + base SQLite, défaut `$TMPDIR/calame-rag-bench`,
**effacé à chaque exécution**), `--models-root <dir>` (dossier contenant
`embeddinggemma-300m/`, défaut : cache de `pnpm model:fetch` ou
`CALAME_LOCAL_EMBEDDING_MODEL_DIR`), `--watch-settle-ms` (défaut 3000).
Les variables `CALAME_RAG_*` (timeouts, retries…) sont lues comme en production
et recopiées dans le rapport.

## Ce qui est exécuté

Le chemin de production réel, sans serveur HTTP : `LocalFolderConnector` →
`runSyncJob` → `IngestionPipeline` (parseurs dans le worker `IsolatedParser`,
chunkers, `LocalOnnxEmbeddingClient` EmbeddingGemma-300M q4, `SqliteVecStore`
avec ses triggers FTS5, base SQLite fichier en WAL). Les sources TypeScript sont
bundlées par esbuild (aucun `pnpm build` requis) puis exécutées dans un
processus enfant dédié, pour que CPU et mémoire ne comptent pas le bundler.

Trois scénarios enchaînés sur la même base :

1. **initial** — base vide, tout le corpus est indexé ;
2. **unchanged** — resynchronisation sans aucun changement ;
3. **partial** — le `WatchManager` (chokidar, debounce 5 s) observe une
   modification déterministe du corpus (5 % de documents édités, 2 % « touchés »
   — mtime seul, 1 % ajoutés, 1 % supprimés), puis une synchronisation tourne.

## Corpus

`generate-corpus.mjs` : PRNG à graine fixe, vocabulaire générique (aucune
donnée privée), mtime fixe. `--docs 1000 --seed 42` → 1010 fichiers, ≈ 15,6 Mo :
Markdown 34 %, texte 22 %, DOCX 25 %, HTML 10 %, CSV 5 %, PDF 4 % ; tailles
log-distribuées (55 % < 4 Ko, 30 % 4–16 Ko, 13 % 16–64 Ko, 2 % 64–200 Ko) ;
24 dossiers imbriqués aux noms accentués avec espaces ; un gros DOCX valide
(≈ 400 Ko de texte). Cas défectueux (dossier `Divers/`) et issue attendue :

| Fichier                                          | Attendu                                          |
| ------------------------------------------------ | ------------------------------------------------ |
| `Rapport corrompu.docx`                          | rejeté — DOCX corrompu (octets aléatoires)       |
| `Contrat tronqué.docx`                           | rejeté — DOCX tronqué à 60 %                     |
| `Sans contenu Word.docx`                         | rejeté — zip sans `word/document.xml`            |
| `~$Rapport annuel.docx`                          | ignoré — fichier propriétaire Word               |
| `Export complet.txt` (6 Mo)                      | rejeté — au-delà du plafond de 5 Mo de la source |
| `Note vide.md`                                   | indexé, sans chunk                               |
| `Scan illisible.pdf`                             | rejeté — PDF corrompu                            |
| `Données brutes.bin`, `Présentation client.pptx` | rejetés — format non supporté                    |

## Mesures

Par scénario (`<label>.json`) :

- **phases** (durée cumulée, nombre, max, % du temps total) via les hooks
  `onSyncPhaseTiming` / `onPhaseTiming` : `walk` (listing + stat), `read`
  (lecture d'un fichier), `hash` (SHA-256 + recherche de la ligne existante),
  `parse`, `chunk`, `embed` (ONNX), `write` (transaction SQLite : lignes,
  chunks + FTS, vecteurs) ; `otherMs` = reste (fast-path etag, écritures de
  progression…) ;
- **débit** : documents traités/s, documents indexés/s, chunks embarqués/s (textes
  réellement passés à `embed()`, remplacements compris — pas une différence
  nette du nombre de chunks en base) ;
- **CPU** : temps user/system du processus (tous threads : worker de parsing
  et threads natifs ONNX compris), cœurs occupés en moyenne, % de la machine,
  load average 1 min maximal ;
- **mémoire** : RSS et heap maximaux (échantillonnés toutes les 50 ms) ;
- **réactivité** : délai de la boucle d'événements (p50/p99/max), latence de
  la requête que l'historique interroge (`GET /api/rag/jobs`) lancée toutes les
  250 ms (retard du timer + requête), plus long intervalle sans progression du
  compteur pendant que le job tourne ;
- **watcher** : événements reçus, délai premier/dernier événement, nombre de
  synchronisations déclenchées, CPU du watcher ;
- **cohérence** : chunks = vecteurs = lignes FTS après chaque scénario.

## Limites

- La réactivité mesurée est celle du processus serveur (où vit l'API que l'UI
  interroge) ; la fluidité de la webview Tauri et du reste de la machine n'est
  approchée que par le % CPU machine et le load average.
- chokidar n'expose pas son « ready » via le connecteur : le banc attend
  `--watch-settle-ms` avant de modifier le corpus.
- Les verrous Word ne sont pas reproductibles hors Windows : ils sont couverts
  par des tests simulés (`rag-sync-isolation.test.ts`), pas par ce banc.
- Mesures natives Windows : la procédure reproductible sera ajoutée à
  [`docs/benchmarks/rag-sync/README.md`](../../docs/benchmarks/rag-sync/README.md)
  (à venir, étape 5) ; aucune mesure Windows n'est revendiquée tant qu'elle
  n'a pas été exécutée nativement.
- Le nombre de threads ONNX n'est pas encore réglable : le rapport indique
  « onnxruntime default ».
