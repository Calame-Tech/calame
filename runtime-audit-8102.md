# Audit Runtime — Instance Dev Isolée (port 8102-8199, store jetable, embeddings local)

## 1. Modèle local : structure vérifiée ✅

**Dossier :** `~/.calame-models/embeddinggemma-300m/`
```
config.json          (1 765 B)   — model_type: gemma3_text, hidden_size: 768, max_position: 2048
tokenizer.json       (20 MB)
tokenizer_config.json (1.1 MB)
special_tokens_map.json (662 B)
added_tokens.json      (35 B)
onnx/
  model_q4.onnx           (519 KB)
  model_q4.onnx_data      (196 MB)
LICENSE-gemma.txt / NOTICE.txt
```
- **dtype attendu :** `q4` (seul variant supporté — fp16/q4f16 rejetés par le client)
- **dimensions :** 768 (EmbeddingGemma-300M)
- **max_tokens :** 2048
- **model_id persisté :** `embeddinggemma-300m-q4`
- **Prompt prefixes :** `query: "task: search result | query: "`, `document: "title: none | text: "`

⚠️ **Remarque :** Le modèle est stocké dans `~/.calame-models/` mais `local-model-resolve.ts` ne cherche que dans :
1. `CALAME_LOCAL_EMBEDDING_MODEL_DIR` (override)
2. `models/` next to bundled server (packaged)
3. `node_modules/.cache/calame-desktop/models/<revision>/` (dev)

→ **Pour la dev, il faut soit :**
- Copier le modèle dans `node_modules/.cache/calame-desktop/models/<revision>/embeddinggemma-300m/`
- **OU** définir `CALAME_LOCAL_EMBEDDING_MODEL_DIR=~/.calame-models` (l'override est validé : doit contenir `<modelFolderName>/config.json`)

## 2. Variables CALAME_* nécessaires

| Variable | Valeur | Obligatoire |
|---|---|---|
| `CALAME_PORT` | `8102` (ou 8103-8199) | Non (default 4567) |
| `CALAME_DATA_DIR` | `/tmp/calame-dev-<random>/` (store jetable) | Recommandé |
| `CALAME_LOCAL_EMBEDDING_MODEL_DIR` | `~/.calame-models` | **Oui** (si modèle non dans cache dev) |
| `CALAME_LLM_PROVIDER` | `anthropic` (ou autre) | Non (sauf chat) |
| `CALAME_LLM_API_KEY` | — | Non (sauf chat) |
| `CALAME_RAG_EMBED_TIMEOUT_MS` | `600000` (default) | Non |
| `CALAME_RAG_DOC_TIMEOUT_MS` | `300000` (default) | Non |
| `CALAME_RAG_MONTHLY_TOKEN_CAP` | — | Non |
| `CALAME_RAG_RATE_LIMIT_*` | — | Non |
| `CALAME_SECRET_KEY` | auto-généré si absent | Non |
| `CALAME_ENCRYPTION_KEY` | **auto-généré** (sauf NODE_ENV=production) | Non |
| `CALAME_RAG_DEFAULT_DIMENSION` | `768` (default = LOCAL_EMBEDDING_DIMENSIONS) | Non |

## 3. Risques ARM64 / ONNX

- **Machine :** `arm64` (M1 Max) ✅
- **Runtime ONNX :** `@huggingface/transformers` → utilise `onnxruntime` via NAPI
- **Modèle :** quantisé `q4` (196 MB weights + 519 KB graph) → bien plus léger que fp32 (~1.2 GB)
- **device :** `'cpu'` (forcé dans `LocalOnnxEmbeddingClient.load()` — pas de GPU)
- **Performance :** ~18-26 chunks/s par batch, batchSize default = 8
- **Risque principal :** `@huggingface/transformers` doit avoir un binding N-API compilé pour `arm64-darwin`. Vérifier avec :
  ```bash
  node -e "import('@huggingface/transformers').then(() => console.log('OK')).catch(e => console.error(e.message))"
  ```
- **Pas de problème connu ARM64** dans le code — `env.device = 'cpu'` est explicite.

## 4. Port 8102-8199 — Disponibilité

Ports actuellement utilisés :
```
3283, 4000, 5434, 8000, 8100, 8101, 8102, 8791, 8792, 8793, 9119, 9377, 15761
```
⚠️ **8102 est DÉJÀ UTILISÉ** (par Python).
Ports libres dans la plage 8102-8199 : tous sauf 8102.

## 5. Commandes de diagnostic non destructives

```bash
# Vérifier la disponibilité du binding ONNX
node -e "import('@huggingface/transformers').then(() => console.log('transformers OK')).catch(e => console.error(e.message))"

# Vérifier la structure du modèle
ls ~/.calame-models/embeddinggemma-300m/config.json ~/.calame-models/embeddinggemma-300m/onnx/model_q4.onnx

# Vérifier la disponibilité d'un port libre
lsof -iTCP -sTCP:LISTEN -P -n | awk '{print $9}' | grep -oE ':(81[0-9]{2})$' | sort -t: -k2 -n | uniq

# Vérifier les variables CALAME_
env | grep CALAME_

# Tester le model resolution (dev mode)
node -e "
import('./packages/cli/src/rag/local-model-resolve.js').then(m => {
  const r = m.resolveLocalModelDir({ packaged: false });
  console.log(JSON.stringify(r, null, 2));
})"

# Vérifier Node version
node --version

# Vérifier pnpm
pnpm --version
```

## 6. Commande de démarrage recommandée

```bash
cd /Users/tombascou/Dev/calame

# Option A : utiliser le modèle existant via override
CALAME_PORT=8103 \
CALAME_DATA_DIR=/tmp/calame-dev-$(date +%s) \
CALAME_LOCAL_EMBEDDING_MODEL_DIR=~/.calame-models \
pnpm dev

# Option B : d'abord fetcher le modèle dans le cache dev
pnpm model:fetch
CALAME_PORT=8103 \
CALAME_DATA_DIR=/tmp/calame-dev-$(date +%s) \
pnpm dev
```

## 7. Flux de boot RAG (résumé)

1. `index.ts` → `initRagRuntime()`
2. `loadEeModules()` → charge `@calame-ee/rag-core` (lazy)
3. `runRagMigrations()` → applique les migrations RAG sur la DB
4. `initVectorStore()` → crée le vec0 table (dim 768 par défaut)
5. `resolveLocalModelDir()` → résout le dossier modèle (override → dev cache)
6. `buildEmbeddingResolvers()` → crée les résolvers pour `resolveEmbeddingClient('local')`
7. `createEmbeddingClient({ provider: 'local' })` → instancie `LocalOnnxEmbeddingClient`
8. `IngestionPipeline` → branché sur le client local
9. **Boot réussi** → RAG fonctionnel avec embeddings locaux, zéro API key
