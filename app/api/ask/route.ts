import { NextRequest } from "next/server";
import { ask } from "@/lib/rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { question?: unknown };
  try {
    body = (await req.json()) as { question?: unknown };
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const question =
    typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return new Response(
      JSON.stringify({ error: "Missing 'question' string" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // ?debug=1 returns the retrieved sources as JSON without calling the LLM.
  // Useful for tuning SIMILARITY_THRESHOLD.
  const debug = new URL(req.url).searchParams.get("debug") === "1";
  if (debug) {
    const { debugRetrieve } = await import("@/lib/rag");
    const result = await debugRetrieve(question);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const result = await ask(question);
    if (result.kind === "refusal") {
      const body = `__REFUSAL__\n\n${result.message}`;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(result.stream, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/ask] error:", message);
    return new Response(
      JSON.stringify({ error: "Assistant error", detail: message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}
