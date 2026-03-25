# agent-subtitle-ext

YouTube AI subtitle translator. Chrome extension that translates subtitles via any OpenAI-compatible agent endpoint.

## Architecture

```
Extension (agent consumer)          Agent endpoint (any)
  │                                   │
  │ POST /v1/chat/completions         │
  │ { model, messages }  ───────────> │
  │                                   │ llama-server / MASC keeper / OpenAI / ...
  │ { choices: [...] }   <─────────── │
  │                                   │
```

Extension is agent-agnostic. It only speaks OpenAI Chat Completions API.
What runs behind the URL is not the extension's concern.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Agent URL | `http://127.0.0.1:8085` | OpenAI-compatible endpoint |
| API Key | (empty) | Bearer token for cloud APIs |
| Model | `auto` | Model identifier sent in request |
| Target Language | `ko` | Translation target |

### Model examples

| Agent URL | Model | What happens |
|-----------|-------|-------------|
| `http://127.0.0.1:8085` | `auto` | llama-server picks loaded model |
| `http://127.0.0.1:8935` | `keeper:translator` | MASC routes to translator keeper (requires `MASC_OPENAI_COMPAT=1`) |
| `http://127.0.0.1:8935` | `default` | MASC routes to OAS cascade directly |
| `https://api.openai.com` | `gpt-4o` | OpenAI API |

## Build

```bash
npm install
npm run build     # → dist/
npm run watch     # dev mode with sourcemaps
```

## Load in Chrome

1. `chrome://extensions` → Developer mode ON
2. Load unpacked → select this directory
3. Open YouTube video → extension auto-detects and starts translating

## Source

| File | Role |
|------|------|
| `src/agent-client.ts` | OpenAI-compat fetch client (model configurable) |
| `src/transcript.ts` | YouTube Innertube API transcript extraction |
| `src/overlay.ts` | CSS subtitle overlay with timing sync |
| `src/background.ts` | Batch translation pipeline (15-seg, sliding window) |
| `src/cache.ts` | IndexedDB translation cache |
| `src/content.ts` | YouTube page injection, SPA navigation detection |
| `src/popup.ts` | Settings popup UI |

## MASC Integration (optional)

MASC can expose keepers as OpenAI-compatible endpoints via `MASC_OPENAI_COMPAT=1` (masc-mcp#3026, PR#3030).

```bash
MASC_OPENAI_COMPAT=1 ./start-masc-mcp.sh --http --port 8935
```

Then set in extension:
- Agent URL: `http://127.0.0.1:8935`
- Model: `keeper:translator`

Translator keeper persona: `masc-mcp/config/personas/translator/`
