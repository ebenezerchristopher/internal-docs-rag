import { EmbeddingsClient } from "./embeddings";
import { LLMClient, type ChatMessage } from "./llm";
import { getSupabase } from "./supabase";

export interface Source {
  index: number; // 1-based, matches [n] in the prompt
  title: string;
  heading: string;
  source: string; // repo-relative path
  similarity: number;
  text: string;
}

export type AskResult =
  | { kind: "answer"; stream: ReadableStream<Uint8Array>; sources: Source[] }
  | { kind: "refusal"; message: string };

const SYSTEM_PROMPT = `You are an internal-docs assistant for a 40-person logistics company. Respond directly with the final answer only. Do not include chain-of-thought, reasoning steps, or preamble. You answer ONLY using the numbered sources provided below. Every factual sentence must end with an inline citation like [1] or [2] that points to the source you used. If the sources do not contain the answer, reply with exactly: "I don't have a doc that covers that." Do not invent processes, names, or steps. If a question is partially covered, answer the covered part with citations and note the gap.

SOURCES:
{{SOURCES}}`;

const REFUSAL_TEXT = "I don't have a doc that covers that.";

function similarityThreshold(): number {
  const v = process.env.SIMILARITY_THRESHOLD;
  if (!v) return 0.3;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0.3;
}

function formatSourceBlock(sources: Source[]): string {
  return sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title} — ${s.heading}\n${s.text}`,
    )
    .join("\n\n");
}

function encodeString(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export async function ask(question: string): Promise<AskResult> {
  const trimmed = question.trim();
  if (!trimmed) {
    return { kind: "refusal", message: "Please enter a question." };
  }

  const embeddings = EmbeddingsClient.fromEnv();
  const llm = LLMClient.fromEnv();
  const supabase = getSupabase();

  const [queryVec] = await embeddings.embed([trimmed]);

  // match_documents is a SQL function in supabase/migrations/0001_init.sql
  // that performs cosine distance search using pgvector.
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: queryVec,
    match_count: 6,
    match_threshold: 0, // we apply our own gate
  });

  if (error) {
    throw new Error(`match_documents failed: ${error.message}`);
  }

  type Row = {
    id: string;
    content: string;
    metadata: {
      title?: string;
      heading?: string;
      source?: string;
    };
    similarity: number;
  };

  const rows: Row[] = (data ?? []) as Row[];

  if (rows.length === 0) {
    return {
      kind: "refusal",
      message:
        "I don't have a doc that covers that. Try rephrasing or check the docs index.",
    };
  }

  const maxSim = rows.reduce(
    (m, r) => (r.similarity > m ? r.similarity : m),
    0,
  );

  // Log the top scores so the user can see what the embedding model is
  // actually returning. Useful for tuning SIMILARITY_THRESHOLD.
  const scoreSummary = rows
    .map((r, i) => `${i + 1}:${r.similarity.toFixed(3)}`)
    .join(" ");
  console.log(
    `[/api/ask] top scores [${scoreSummary}] max=${maxSim.toFixed(3)} threshold=${similarityThreshold()}`,
  );

  if (maxSim < similarityThreshold()) {
    return {
      kind: "refusal",
      message:
        "I don't have a doc that covers that. Try rephrasing or check the docs index.",
    };
  }

  const sources: Source[] = rows.map((r, i) => ({
    index: i + 1,
    title: r.metadata.title ?? "Untitled",
    heading: r.metadata.heading ?? "",
    source: r.metadata.source ?? "",
    similarity: r.similarity,
    text: r.content,
  }));

  const systemPrompt = SYSTEM_PROMPT.replace(
    "{{SOURCES}}",
    formatSourceBlock(sources),
  );

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: trimmed },
  ];

  const stream = llm.streamChat(messages);

  // Prepend a small header that the UI can use to display sources as soon as
  // streaming begins. The format is a single JSON line followed by a blank line
  // and the streamed answer text.
  //
  // Each source includes the full chunk text (truncated to TEXT_PREVIEW_CHARS
  // to keep the header small) so the client can show the citation on demand
  // without a second round trip.
  const TEXT_PREVIEW_CHARS = 2000;
  const header = `__SOURCES__${JSON.stringify(sources.map((s) => ({
    index: s.index,
    title: s.title,
    heading: s.heading,
    source: s.source,
    similarity: s.similarity,
    text:
      s.text.length > TEXT_PREVIEW_CHARS
        ? s.text.slice(0, TEXT_PREVIEW_CHARS) + "\n\n[…truncated…]"
        : s.text,
  })))}\n\n`;

  const wrapped = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeString(header));
      const reader = stream.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        }
      };
      pump();
    },
  });

  return { kind: "answer", stream: wrapped, sources };
}

export { REFUSAL_TEXT };

/**
 * Debug helper: retrieves the top-k chunks without applying the gate or
 * calling the LLM. Used by the `?debug=1` mode of /api/ask to inspect
 * similarity scores.
 */
export async function debugRetrieve(question: string): Promise<{
  question: string;
  threshold: number;
  matches: { id: string; title: string; heading: string; source: string; similarity: number; text_preview: string }[];
  refused: boolean;
}> {
  const trimmed = question.trim();
  const embeddings = EmbeddingsClient.fromEnv();
  const supabase = getSupabase();
  const [queryVec] = await embeddings.embed([trimmed]);
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: queryVec,
    match_count: 6,
    match_threshold: 0,
  });
  if (error) throw new Error(`match_documents failed: ${error.message}`);
  type Row = {
    id: string;
    content: string;
    metadata: { title?: string; heading?: string; source?: string };
    similarity: number;
  };
  const rows: Row[] = (data ?? []) as Row[];
  const maxSim = rows.reduce(
    (m, r) => (r.similarity > m ? r.similarity : m),
    0,
  );
  const threshold = similarityThreshold();
  return {
    question: trimmed,
    threshold,
    refused: maxSim < threshold,
    matches: rows.map((r) => ({
      id: r.id,
      title: r.metadata.title ?? "Untitled",
      heading: r.metadata.heading ?? "",
      source: r.metadata.source ?? "",
      similarity: Number(r.similarity.toFixed(4)),
      text_preview: r.content.slice(0, 200),
    })),
  };
}
