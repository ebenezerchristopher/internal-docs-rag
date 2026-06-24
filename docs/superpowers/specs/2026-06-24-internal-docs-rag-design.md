# Internal Docs RAG — Design

**Date:** 2026-06-24
**Status:** Approved
**Mission:** A 40-person logistics company has 1,200 docs in Notion. The assistant answers questions about internal processes with verifiable citations to the source doc, and refuses honestly when it doesn't know.

## Goals (from the brief)

- Index at least 50 markdown docs from a directory.
- Answer questions with inline citations to the source chunk.
- Stream responses token-by-token in the UI.
- Handle "I don't know" honestly — no hallucinations.
- Public deploy on Vercel + README with architecture decisions.

## Non-goals

- Authentication, user accounts, or per-tenant data.
- Live Notion API integration. The brief says 1,200 docs in Notion, but the deployable MVP indexes a static markdown corpus; swapping in a Notion sync is a follow-up.
- Re-ranking, query expansion, agentic tool use, or multi-hop retrieval.
- Persistent chat history. Each question is stateless.
- Production-grade observability. A single request log is enough for the demo.

## Stack (decided with the user)

- **App:** Next.js 15 (App Router) + TypeScript + Tailwind 4. The Redence starter repo was not available in `/tmp`, so a minimal hand-rolled Next.js scaffold is used.
- **Generation:** OpenAI-compatible chat completions (e.g., `gpt-4o-mini` directly, or `openai/gpt-4o-mini` via OpenRouter). Configured via `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `GENERATION_MODEL`.
- **Embeddings:** OpenAI-compatible `/v1/embeddings` (e.g., `text-embedding-3-small`, 1536 dims). Same base URL + key, separate `EMBEDDING_MODEL`.
- **Vector store:** Supabase Postgres with the `pgvector` extension. One `documents` table + a `match_documents` RPC for cosine top-k.
- **No auth, no Tailwind plugins beyond defaults, no extra UI libraries.**

## Architecture

```
content/docs/**/*.md
        |
        | (prebuild)
        v
scripts/build-index.mjs
   - glob, parse frontmatter, chunk by heading
   - embed each chunk (OpenAI-compatible)
   - upsert to Supabase documents table
        |
        v
Supabase (pgvector)
   documents(id, content, metadata, embedding vector(1536))
   match_documents(query_embedding, match_count, match_threshold) RPC
        ^
        | (query: top-k cosine)
        |
app/api/ask/route.ts
   - embed query
   - retrieve top-6
   - Gate 1: refuse if max(score) < SIMILARITY_THRESHOLD
   - build grounded prompt with explicit citation format + refusal template
   - stream chat completion
        ^
        | (POST + ReadableStream)
        v
app/page.tsx + app/components/Chat.tsx
   - chat input, streaming text, inline [1] links, sources panel
```

## Components

### Chunker (`lib/chunk.ts`)

Splits a markdown document into chunks, keeping headings with the following paragraphs.

- Group consecutive non-heading lines under the most recent heading.
- Target chunk size: 1200 chars. Hard cap: 1600.
- Overlap: 200 chars (carry the tail of the previous chunk into the next).
- Each chunk records `{ docId, source, title, heading, chunkIndex, text }`.

### Embeddings (`lib/embeddings.ts`)

Thin client over the OpenAI-compatible `/v1/embeddings` endpoint.

```ts
embed(texts: string[]): Promise<number[][]>
```

- Reads `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `EMBEDDING_MODEL` from `process.env`.
- Batches up to 64 inputs per request to keep payload sizes reasonable.
- Bounded concurrency of 8 requests in flight (keeps the indexer polite to the provider).

### LLM (`lib/llm.ts`)

Streaming client over the OpenAI-compatible `/v1/chat/completions` endpoint.

```ts
streamChat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<ReadableStream<Uint8Array>>
```

- Forwards SSE chunks to the caller as a `ReadableStream`. No buffering.
- Optional `temperature` (default 0.2) and `maxTokens` (default 800) for predictable cost on the demo.

### Supabase client (`lib/supabase.ts`)

Creates a server-side client using `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the service role key is server-only; the public anon key is not used because there is no client-side Supabase access in this design).

### RAG orchestrator (`lib/rag.ts`)

The single function the API route calls:

```ts
ask(question: string): Promise<{
  refusal: false;
  stream: ReadableStream<Uint8Array>;
  sources: Source[];
} | {
  refusal: true;
  message: string;
}>
```

1. Embed the question.
2. Call `match_documents` with `match_count=6` and `match_threshold=0` (we apply the gate ourselves; the SQL threshold is just a hard floor at e.g. 0.3 to drop noise).
3. Apply Gate 1: if `max(similarity) < SIMILARITY_THRESHOLD` (default 0.72), return `{ refusal: true }`.
4. Build the system prompt (see "Prompt design" below) and call `streamChat`.
5. Return the stream plus the ordered `sources` array (the same order the prompt uses for `[1] [2] ...`).

### API route (`app/api/ask/route.ts`)

`POST /api/ask` with JSON body `{ question: string }`. Returns a streamed `text/plain` response. On refusal, returns a 200 with a short refusal body (a streamed single chunk) so the client can render the same UI for both paths.

### Chat UI (`app/page.tsx`, `app/components/Chat.tsx`)

- Server component renders the page shell with Tailwind.
- Client `Chat` component holds the input, fetches `/api/ask` with `fetch().body.getReader()`, decodes the SSE-style stream into a buffer, and renders text.
- Inline citations: a regex on the streamed text converts `[1]`, `[2]` into anchor links to `/sources#s1`, `/sources#s2`.
- A collapsible "Sources" panel below the answer lists the retrieved docs (title, category, link to the doc path, similarity score).

## Data flow

1. **Build time.** `prebuild` runs `scripts/build-index.mjs`. It deletes prior rows tagged with the current build's `build_id` (a `metadata->>'build_id'` filter), then inserts fresh chunks. Idempotent across rebuilds.
2. **Request time.** A user types a question. The client streams a POST. The server embeds, retrieves, gates, and streams. The client renders text and inline citations.
3. **Refusal path.** If Gate 1 fires, the server returns a streamed message: `I don't have a doc that covers that. Try rephrasing or check the docs index.` and `sources: []`. The UI renders this in the same bubble as a real answer so the user can't tell the difference visually except for the missing citations.

## Prompt design

System prompt template (verbatim, in the route file):

```
You are an internal-docs assistant for a 40-person logistics company. You answer ONLY using the numbered sources below. Every factual sentence must end with an inline citation like [1] or [2] that points to the source you used. If the sources do not contain the answer, reply with exactly: "I don't have a doc that covers that." Do not invent processes, names, or steps. If a question is partially covered, answer the covered part with citations and note the gap.

SOURCES:
[1] <title> — <heading>
<text>

[2] <title> — <heading>
<text>
...
```

The user message is the verbatim question.

The prompt is sent with `temperature: 0.2` to reduce creative hallucination. The "I don't have a doc that covers that." phrasing is exact so we can regex-detect a model-initiated refusal client-side and color the bubble accordingly (optional follow-up).

## Honesty guardrail (two stages)

- **Stage 1 — similarity gate:** if the best retrieved chunk's cosine similarity is below `SIMILARITY_THRESHOLD` (default 0.72, tunable in env), the server refuses without calling the LLM. This catches "no relevant doc exists at all" cheaply.
- **Stage 2 — prompt-level instruction:** even with good retrieval, the model is told to answer only from the chunks, to cite every claim, and to use a specific refusal string. This catches "chunks are tangentially related but don't actually answer."

The two stages are independent and complementary: Stage 1 catches the empty-corpus case, Stage 2 catches the off-topic-but-close case.

## Failure modes and handling

| Failure | Behavior |
|---|---|
| Missing env vars at build | `scripts/build-index.mjs` throws a clear error listing which vars are missing. The build fails. |
| Missing env vars at request | `/api/ask` returns 500 with a generic "assistant not configured" message and a request log. |
| Indexer API rate limit | Bounded concurrency (8) and 3 retries with exponential backoff. |
| LLM provider 5xx | One retry with the same prompt. If still failing, return 502 to the client. |
| Supabase down | Retrieval throws; the route returns 503. |
| Empty corpus | Indexer succeeds with 0 rows; the first request triggers Stage 1 refusal. |
| `OPENAI_BASE_URL` set to a non-OpenAI provider | Works as long as the provider implements `/v1/embeddings` and `/v1/chat/completions` (OpenRouter, Together, Groq, Ollama all do). |
| Embedding dim mismatch | Hard-coded to 1536. If a different model is used, the migration's `vector(1536)` and the embedder's assumed dim must match; the README will call this out. |

## Testing strategy

For the MVP: smoke tests only.

- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — `next lint` (or eslint directly).
- `npm run build` — full Next.js build; this runs the indexer as `prebuild`. Requires all env vars and Supabase access; in CI without creds, the build will fail loudly. Documented in the README.
- A `npm run check:env` script that prints which required env vars are present without actually calling any APIs.

No unit tests in the MVP. The bar is the deployed behavior; tests come in a follow-up.

## Environment variables

```
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
GENERATION_MODEL=gpt-4o-mini
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SIMILARITY_THRESHOLD=0.72
```

`SIMILARITY_THRESHOLD` is optional and defaults to `0.72`.

## Deployment

1. Create a Supabase project, enable the `pgvector` extension, run `supabase/migrations/0001_init.sql` in the SQL editor.
2. Push the repo to GitHub.
3. Import the repo into Vercel.
4. Add the env vars above (without the `OPENAI_BASE_URL` default, since the value will be real).
5. Trigger a deploy. The `prebuild` script runs the indexer against the real Supabase + embedding provider.
6. Once the build is green, the live URL is the Vercel project URL.

## Open follow-ups (intentionally out of scope)

- Live Notion sync (replacing the static corpus).
- Auth (the brief says "public deploy", so it's intentionally open).
- Persistent chat history.
- Re-ranking with a cross-encoder.
- Per-doc ACLs (if certain docs should be ops-only).
- CI that runs typecheck and lint on every PR.

## Architecture decisions (for the README)

- **Why Supabase over Upstash/managed vector DBs:** user choice. Supabase keeps everything in one managed Postgres instance, which is one fewer service to provision. The trade-off is that pgvector is in-database and not as feature-rich as dedicated vector stores (no metadata filtering out of the box, no built-in namespaces). For 1,200 docs this is a non-issue.
- **Why OpenAI-compatible providers:** the user can swap OpenAI for OpenRouter, Together, Groq, or a local Ollama endpoint by changing two env vars. The code never imports the OpenAI SDK directly.
- **Why a static corpus in `content/docs/`, not live Notion:** the brief allows static markdown. Indexing 1,200 docs live from Notion adds an OAuth flow, secret rotation, rate limits, and a 5-10 minute initial sync — none of which matter for the MVP. The same indexer design works for a future Notion sync by replacing the file glob with a Notion client.
- **Why 1200-char chunks with 200-char overlap:** short enough that each chunk is one logical "step in a process" in our synthetic docs, long enough to avoid splitting mid-sentence. Overlap prevents losing the sentence that bridges two chunks.
- **Why two-stage refusal:** Stage 1 (similarity floor) is cheap and catches the empty-corpus case. Stage 2 (prompt instruction) is more expensive but catches the off-topic-but-close case. A single-stage design has to choose between false positives (refuse too often) and false negatives (hallucinate).
- **Why streaming:** required by the brief; also makes the perceived latency lower because the first token usually arrives in <1s.
- **Why no auth:** the brief says "public deploy" and "40-person logistics company". Adding auth would require either a third-party (Clerk/Auth.js) or a custom solution, both of which add a day of work and a maintenance burden that the brief doesn't justify. The README will note this is an intentional MVP trade-off.
