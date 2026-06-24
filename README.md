# Internal Docs Assistant

A RAG-powered assistant for a 40-person logistics company. It indexes the
internal docs (markdown), retrieves the most relevant chunks, and answers
the user's question with inline citations to the source docs. It says
"I don't have a doc that covers that." when it can't find an answer.

Built on the Redence starter (Next.js 15 + Tailwind 4 + TypeScript). Stack
swap-ins:

- **Embeddings & LLM:** any OpenAI-compatible API (OpenAI, OpenRouter,
  Together, Groq, Ollama). Embeddings and generation can be on different
  providers — set `EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY` separately from
  `GENERATION_BASE_URL`/`GENERATION_API_KEY`.
- **Vector store:** Supabase Postgres + `pgvector`. One table, one RPC.

## Demo in 5 minutes

1. Create a Supabase project: <https://supabase.com>.
2. In the Supabase SQL editor, paste and run
   [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql).
   The migration is hardcoded to a specific embedding dim (see the header
   comment in the file for the full list). The default in this repo is
   **2048** to match `nvidia/llama-nemotron-embed-vl-1b-v2:free`. If you
   switch embedding models to a different dim, change every `2048` in
   the migration to the new dim and re-run it.
3. Copy `.env.example` to `.env.local` and fill in the values. Embeddings
   and generation can use different providers.
4. Install deps and build the index locally to confirm everything works:
   ```bash
   npm install
   npm run index
   ```
5. Start the dev server and try a question:
   ```bash
   npm run dev
   ```
   Open <http://localhost:3000> and ask
   *"What's our process when a client complains about a delay?"*

## Deploy to Vercel

1. Push the repo to GitHub.
2. In Vercel, click **Add New Project** and import the repo.
3. In **Environment Variables**, add every var from `.env.example` with
   real values.
4. Click **Deploy**. The `prebuild` script runs the indexer against
   Supabase; if env vars are missing, the build will fail loudly.
5. Once the build is green, Vercel gives you the live URL.

## Architecture

```
content/docs/**/*.md
        |
        | (prebuild)
        v
scripts/build-index.mjs
  - parse frontmatter, chunk by heading
  - embed with the OpenAI-compatible /v1/embeddings
  - upsert to Supabase documents table
        |
        v
Supabase (pgvector)
  documents(id, content, metadata, embedding vector(1536))
  match_documents(query_embedding, match_count, match_threshold)
        ^
        | (query: top-6 cosine)
        |
app/api/ask/route.ts
  - embed query
  - retrieve top-6
  - Gate 1: refuse if max(score) < SIMILARITY_THRESHOLD
  - prompt the LLM with explicit citation + refusal instructions
  - stream chat completion
        ^
        | (POST + ReadableStream)
        v
app/page.tsx + app/components/Chat.tsx
  - chat input, streaming text, inline [1] links, sources panel
```

### The two-stage honesty guardrail

- **Stage 1 — similarity gate.** If the best retrieved chunk's cosine
  similarity is below `SIMILARITY_THRESHOLD` (default 0.72), the server
  refuses without calling the LLM. This catches the "no relevant doc
  exists" case cheaply.
- **Stage 2 — prompt-level instruction.** Even with good retrieval, the
  model is told to answer only from the chunks, to cite every claim, and
  to use a specific refusal string. This catches the "chunks are
  tangentially related" case.

### Streaming protocol

The API returns a streamed `text/plain` response. The first non-empty
chunk is a header line — either `__SOURCES__<json>` or `__REFUSAL__` —
followed by a blank line and the assistant's text. The client parses the
header to know when sources are available, then renders the text
incrementally as it arrives.

## Architecture decisions

- **Supabase + pgvector over a managed vector DB.** Keeps everything in
  one managed Postgres instance. pgvector is plenty for 1,200 docs; we
  are not at the scale where a dedicated vector store's metadata
  filtering or namespaces would pay off.
- **No index on `documents.embedding` for the MVP.** pgvector's IVFFlat
  caps at 2000 dims; HNSW caps at 2000 on pgvector < 0.7 and 4096 on
  0.7+. NVIDIA Nemotron (2048-dim) doesn't fit either. For 60 docs
  (~240 chunks), exact brute-force search runs in microseconds. Add an
  HNSW index once the corpus grows past ~10k chunks AND Supabase is on
  pgvector 0.7+; the migration has the DDL commented out for that case.
- **OpenAI-compatible providers.** The user can swap OpenAI for
  OpenRouter, Together, Groq, or a local Ollama endpoint by changing
  four env vars. Embeddings and generation can use different providers.
  The code never imports the OpenAI SDK directly.
- **Static corpus in `content/docs/`, not live Notion.** The brief
  allows static markdown. Indexing 1,200 docs live from Notion adds an
  OAuth flow, secret rotation, rate limits, and a 5-10 minute initial
  sync — none of which matter for the MVP. The same indexer design
  works for a future Notion sync by replacing the file glob with a
  Notion client.
- **1200-char chunks with 200-char overlap.** Short enough that each
  chunk is one logical "step in a process" in our synthetic docs, long
  enough to avoid splitting mid-sentence. Overlap prevents losing the
  sentence that bridges two chunks.
- **Two-stage refusal.** Stage 1 (similarity floor) is cheap and
  catches the empty-corpus case. Stage 2 (prompt instruction) catches
  the off-topic-but-close case. A single-stage design has to choose
  between false positives (refuse too often) and false negatives
  (hallucinate).
- **Streaming.** Required by the brief; also makes the perceived
  latency lower because the first token usually arrives in <1s.
- **No auth.** The brief says "public deploy" and "40-person
  logistics company". Adding auth would require a third-party
  (Clerk/Auth.js) or a custom solution, both of which add a day of
  work and a maintenance burden that the brief doesn't justify. This
  is an intentional MVP trade-off; production would add auth.

## Project layout

```
app/
  api/ask/route.ts        # streaming POST endpoint
  components/Chat.tsx     # chat UI
  globals.css             # tailwind + small custom styles
  layout.tsx              # root layout
  page.tsx                # mounts <Chat />
content/docs/             # 60 synthetic logistics markdown files
lib/
  chunk.ts                # markdown chunker (shared shape, used by app)
  embeddings.ts           # OpenAI-compatible embeddings client
  llm.ts                  # OpenAI-compatible streaming LLM client
  rag.ts                  # orchestrator: embed → retrieve → gate → stream
  supabase.ts             # server-side Supabase client
scripts/
  build-index.mjs         # runs at prebuild, also `npm run index`
  check-env.mjs           # prints which env vars are set
supabase/migrations/
  0001_init.sql           # documents table + match_documents RPC
```

## Scripts

- `npm run dev` — start the dev server.
- `npm run build` — runs the indexer (`prebuild`) then the Next.js build.
- `npm run index` — runs only the indexer.
- `npm run start` — start the production server.
- `npm run lint` — `next lint`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run check:env` — print which env vars are set / missing.

## Failure modes handled

| Failure | Behavior |
|---|---|
| Missing env vars at build | `scripts/build-index.mjs` throws a clear error listing which vars are missing. The build fails. |
| Missing env vars at request | `/api/ask` returns 500 with a generic "assistant error" message. |
| Indexer API rate limit | Bounded concurrency (8) and 3 retries with exponential backoff. |
| LLM provider 5xx | Bubbles up as a 500 to the client. The UI shows the error message inline. |
| Supabase down | Retrieval throws; the route returns 500. |
| Embedding dim mismatch | Hard-coded to 1536. If a different model is used, the migration's `vector(1536)` and the embedder's assumed dim must match. |
| OpenAI-compatible quirks | Most providers implement `/v1/embeddings` and `/v1/chat/completions` (OpenRouter, Together, Groq, Ollama). The streaming parser tolerates malformed SSE lines. |

## License

MIT.
