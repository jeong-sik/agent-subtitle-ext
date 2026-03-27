# agent-subtitle-ext

YouTube AI subtitle translator. Chrome extension that translates subtitles via any OpenAI-compatible agent endpoint.

## Architecture

```
Extension (agent consumer)          Agent endpoint (any)
  |                                   |
  | POST /v1/chat/completions         |
  | { model, messages }  -----------> |
  |                                   |
  | { choices: [...] }   <----------- |
  |                                   |
```

Extension is agent-agnostic. It speaks OpenAI Chat Completions API.
What runs behind the URL is not the extension's concern.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Agent URL | `http://127.0.0.1:8085` | Any OpenAI-compatible endpoint |
| API Key | (empty) | Bearer token (when endpoint requires auth) |
| Model | `auto` | Model identifier passed through to endpoint |
| Target Language | `ko` | Translation target language |

## Build

```bash
pnpm install
pnpm build        # production build -> dist/
pnpm watch        # dev mode with sourcemaps
```

## Load in Chrome

1. `chrome://extensions` -> Developer mode ON
2. Load unpacked -> select this directory
3. Open YouTube video -> extension auto-detects and starts translating

## Source

| File | Role |
|------|------|
| `src/agent-client.ts` | OpenAI-compat fetch client |
| `src/transcript.ts` | YouTube Innertube API transcript extraction |
| `src/overlay.ts` | CSS subtitle overlay with timing sync |
| `src/background.ts` | Batch translation pipeline (15-seg, sliding window context) |
| `src/cache.ts` | IndexedDB translation cache |
| `src/content.ts` | YouTube page injection, SPA navigation detection |
| `src/popup.ts` | Settings popup UI |
