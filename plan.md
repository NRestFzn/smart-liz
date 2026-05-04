# Backend Implementation Specification: AI Agent Orchestrator

## 1. Core Architecture

- **Pattern:** Service-Controller-Route (Modular Monolith).
- **Runtime:** Node.js 22+ with TypeScript (`strict: true`).
- **Communication:**
  - **Inbound:** RESTful API (Express.js 5 / Hono).
  - **Outbound (LLM):** Ollama SDK (Localhost:11434).
  - **Outbound (RAG):** ChromaDB Client (Local persistent storage).
  - **Outbound (TTS):** Native `fetch` bridge to Local FastAPI (XTTSv2).

## 2. Technical Stack Dependencies

### Runtime
| Package | Purpose | Notes |
|---|---|---|
| `express` | HTTP server | v5 — async error handling built-in |
| `ollama` | LLM inference client | Official Ollama JS SDK |
| `@langchain/core` | Chain/prompt primitives | Replaces deprecated `langchain` root |
| `@langchain/ollama` | Ollama embeddings & LLM | Replaces deprecated `@langchain/community` Ollama adapter |
| `chromadb` | Vector store | Local persistent |
| `zod` | Schema validation | Runtime type safety for LLM output & request bodies |
| `pino` + `pino-pretty` | Structured logging | Replaces `console.log` |
| `dotenv` | Env loading | |
| `cors` | CORS headers | |
| `helmet` | Security headers | |
| `express-rate-limit` | Rate limiting | Prevent TTS/LLM abuse |

### DevDependencies
| Package | Purpose | Notes |
|---|---|---|
| `typescript` | Compiler | v5+ |
| `tsx` | TS execution & watch mode | Replaces deprecated `ts-node-dev` |
| `@types/node` | Node type definitions | |
| `@types/express` | Express type definitions | |
| `@types/cors` | CORS type definitions | |

## 3. TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

> **Why `Node16` not `node`:** `moduleResolution: "node"` is the legacy resolver and does not support `exports` fields in `package.json`. `Node16` is the correct setting for Node.js 16+ projects and properly resolves modern packages.

## 4. Environment Configuration (`.env`)

```env
OLLAMA_BASE_URL=http://localhost:11434
TTS_SERVICE_URL=http://localhost:8000
VECTOR_DB_PATH=./data/chroma
LLM_MODEL=phi4-mini
EMBED_MODEL=nomic-embed-text
PORT=3000
NODE_ENV=development
```

## 5. Implementation Roadmap

### Phase 1: Project Scaffold

- Initialize `package.json` with `"type": "module"`.
- Configure `tsconfig.json` (see Section 3).
- Setup `pino` logger instance shared across all services.
- Add `src/types/index.ts` with shared Zod schemas and inferred TypeScript types.
- Shared schemas:
  ```ts
  export const LlmResponseSchema = z.object({
    reply: z.string(),
    emotion: z.enum(["HAPPY", "ANGRY", "SAD", "EXCITED"]),
  });

  export const ChatRequestSchema = z.object({
    message: z.string().min(1).max(2000),
  });
  ```

### Phase 2: RAG Pipeline Service (`rag.service.ts`)

- **Ingestion:** `RecursiveCharacterTextSplitter` with chunk size `512`, overlap `64`.
- **Vectorization:** `OllamaEmbeddings` from `@langchain/ollama` with model `nomic-embed-text`.
- **Storage:** `Chroma` from `@langchain/community/vectorstores/chroma` pointing to `VECTOR_DB_PATH`.
- **Retrieval:** `VectorStoreRetriever` with `k: 3`, returns `Document[]`.
- **Interface:**
  ```ts
  getRelevantContext(query: string): Promise<string>
  ingestDocuments(sourcePath: string): Promise<void>
  ```

### Phase 3: Inference Service (`llm.service.ts`)

- **Client:** `ChatOllama` from `@langchain/ollama`.
- **Prompt Engineering:**
  - System message forces JSON output matching `LlmResponseSchema`.
  - Template merges: `[SystemMessage, HumanMessage]` with RAG context injected into the human turn.
- **Output Validation:** Parse LLM response with `LlmResponseSchema.parse()`. On `ZodError`, retry once with an explicit correction prompt before throwing.
- **Interface:**
  ```ts
  generateResponse(userMessage: string, context: string): Promise<LlmResponse>
  ```

### Phase 4: Audio Synthesis Bridge (`tts.service.ts`)

- **Transport:** Native `fetch` (Node 18+ built-in, no Axios needed).
- **Payload:** `POST` to `TTS_SERVICE_URL/synthesize` with `{ text, speaker_wav }`.
- **Response:** Return `{ audioBase64: string }` or a file path URL depending on FastAPI contract.
- **Timeout:** Wrap fetch in `AbortController` with 30s timeout for TTS latency.
- **Interface:**
  ```ts
  synthesizeSpeech(text: string): Promise<{ audioBase64: string }>
  ```

### Phase 5: Orchestration Controller (`chat.controller.ts`)

- Validate request body with `ChatRequestSchema.parse(req.body)`.
- Workflow:
  1. `RagService.getRelevantContext(message)`
  2. `LlmService.generateResponse(message, context)`
  3. `TtsService.synthesizeSpeech(llmResponse.reply)`
  4. Return aggregated response.
- All steps wrapped in try/catch; errors forwarded to Express 5 async error handler.

### Phase 6: Server Entry (`server.ts`)

- Mount `helmet()`, `cors()`, `express.json()`, `rateLimiter`.
- Mount routes: `POST /api/v1/chat`, `GET /health`.
- Register global error handler middleware (last middleware).

## 6. API Specification

### `POST /api/v1/chat`

**Request Body:**
```json
{ "message": "Hello, how are you?" }
```

**Success Response (200):**
```json
{
  "text": "I'm doing great, thanks for asking!",
  "audio_payload": "<base64-encoded-wav>",
  "metadata": {
    "emotion": "HAPPY",
    "context_used": true
  }
}
```

**Error Response (422 — validation):**
```json
{ "error": "Validation failed", "details": [...] }
```

**Error Response (500 — upstream failure):**
```json
{ "error": "LLM service unavailable" }
```

### `GET /health`

**Success Response (200):**
```json
{ "status": "ok", "uptime": 123.4 }
```

## 7. Project File Structure

```
src/
├── types/
│   └── index.ts          # Zod schemas + inferred types
├── services/
│   ├── rag.service.ts
│   ├── llm.service.ts
│   └── tts.service.ts
├── controllers/
│   └── chat.controller.ts
├── routes/
│   └── chat.routes.ts
├── middleware/
│   └── errorHandler.ts
├── lib/
│   └── logger.ts          # Shared pino instance
└── server.ts
```
