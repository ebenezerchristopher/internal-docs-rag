import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { NotionClient, type NotionPage } from "@/lib/notion";
import { EmbeddingsClient } from "@/lib/embeddings";
import { chunkDocument } from "@/lib/chunk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long-running import; allow up to 5 min on the server side.
export const maxDuration = 300;

interface ImportEvent {
  type: "start" | "page" | "done" | "error";
  [k: string]: unknown;
}

function encode(ev: ImportEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(ev) + "\n");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

export async function POST(req: NextRequest) {
  let body: { token?: unknown; rootPageId?: unknown };
  try {
    body = (await req.json()) as { token?: unknown; rootPageId?: unknown };
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const rootPageId =
    typeof body.rootPageId === "string" ? body.rootPageId.trim() : "";
  if (!token || !rootPageId) {
    return new Response(
      JSON.stringify({ error: "Missing 'token' or 'rootPageId'" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return new Response(
      JSON.stringify({ error: "Server is missing Supabase env vars" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const notion = new NotionClient(token);
        const embedder = EmbeddingsClient.fromEnv();
        const supabase = createClient(supabaseUrl, supabaseKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // First, validate the token by fetching the root page.
        let rootPage: { title: string; url: string } | null;
        try {
          rootPage = await (notion as unknown as {
            getPage: (id: string) => Promise<{ title: string; url: string } | null>;
          }).getPage(rootPageId);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          controller.enqueue(
            encode({ type: "error", message: `Cannot read root page: ${message}` }),
          );
          controller.close();
          return;
        }
        if (!rootPage) {
          controller.enqueue(
            encode({
              type: "error",
              message:
                "Cannot read the root page. Make sure the integration is shared with the page and the page ID is correct.",
            }),
          );
          controller.close();
          return;
        }

        // Walk the page tree.
        const pages: NotionPage[] = await notion.walkPageTree(rootPageId);
        controller.enqueue(
          encode({ type: "start", total_pages: pages.length, root_title: rootPage.title }),
        );

        // Delete any prior Notion-imported chunks (idempotent re-imports).
        const { error: delErr } = await supabase
          .from("documents")
          .delete()
          .eq("metadata->>source_type", "notion");
        if (delErr) {
          controller.enqueue(
            encode({ type: "error", message: `Cleanup failed: ${delErr.message}` }),
          );
          controller.close();
          return;
        }

        let totalChunks = 0;
        for (let i = 0; i < pages.length; i++) {
          const page = pages[i]!;
          // Build a frontmatter so the chunker can use the title.
          const bodyWithFm = `---\ntitle: "${page.title.replace(/"/g, "")}"\n---\n\n${page.markdown}`;
          const chunks = chunkDocument({
            id: `notion::${page.id}`,
            source: page.notionUrl,
            title: page.title,
            body: bodyWithFm,
          });

          if (chunks.length === 0) {
            controller.enqueue(
              encode({
                type: "page",
                index: i + 1,
                total: pages.length,
                title: page.title,
                chunks: 0,
                skipped: true,
              }),
            );
            continue;
          }

          const vectors = await embedder.embed(chunks.map((c) => c.text));

          const rows = chunks.map((c, j) => ({
            id: `notion::${page.id}::${slug(c.heading)}::${c.chunkIndex}`,
            content: c.text,
            metadata: {
              source_type: "notion",
              notion_page_id: page.id,
              notion_url: page.notionUrl,
              title: page.title,
              heading: c.heading,
              source: page.notionUrl,
              chunk_index: c.chunkIndex,
            },
            embedding: `[${vectors[j]!.join(",")}]`,
          }));

          // Upsert in batches of 100.
          for (let k = 0; k < rows.length; k += 100) {
            const batch = rows.slice(k, k + 100);
            const { error } = await supabase.from("documents").upsert(batch);
            if (error) {
              controller.enqueue(
                encode({
                  type: "error",
                  message: `Upsert failed at page ${i + 1}: ${error.message}`,
                }),
              );
              controller.close();
              return;
            }
          }

          totalChunks += rows.length;
          controller.enqueue(
            encode({
              type: "page",
              index: i + 1,
              total: pages.length,
              title: page.title,
              chunks: rows.length,
            }),
          );
        }

        controller.enqueue(
          encode({
            type: "done",
            total_pages: pages.length,
            total_chunks: totalChunks,
          }),
        );
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        try {
          controller.enqueue(encode({ type: "error", message }));
        } catch {
          // controller may already be closed
        }
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
