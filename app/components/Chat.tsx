"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Role = "user" | "assistant" | "system";

interface Source {
  index: number;
  title: string;
  heading: string;
  source: string;
  similarity: number;
}

interface Message {
  id: string;
  role: Role;
  text: string;
  sources?: Source[];
  refused?: boolean;
  pending?: boolean;
}

const SUGGESTIONS = [
  "What's our process when a client complains about a delay?",
  "How do we onboard a new driver?",
  "What do we do if freight is damaged in transit?",
  "How are customs issues escalated?",
];

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const submit = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed || busy) return;
      setInput("");
      setBusy(true);
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        text: trimmed,
      };
      const assistantId = crypto.randomUUID();
      setMessages((m) => [
        ...m,
        userMsg,
        { id: assistantId, role: "assistant", text: "", pending: true },
      ]);

      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: trimmed }),
        });
        if (!res.ok || !res.body) {
          throw new Error(`Request failed: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let headerParsed = false;
        let refused = false;
        let allSources: Source[] = [];

        const updateAssistant = (next: Partial<Message>) => {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantId
                ? { ...msg, ...next, pending: false }
                : msg,
            ),
          );
        };

        const consume = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            if (!headerParsed) {
              // Wait until we see a blank line that ends the header.
              const sep = buffer.indexOf("\n\n");
              if (sep < 0) continue;
              const header = buffer.slice(0, sep).trim();
              buffer = buffer.slice(sep + 2);
              headerParsed = true;

              if (header.startsWith("__SOURCES__")) {
                try {
                  allSources = JSON.parse(
                    header.slice("__SOURCES__".length),
                  ) as Source[];
                } catch {
                  allSources = [];
                }
              } else if (header.startsWith("__REFUSAL__")) {
                refused = true;
              }
              updateAssistant({ text: "", sources: allSources, refused });
            }

            updateAssistant({ text: buffer });
          }
          // After streaming, filter sources to only those the model cited
          // in [N] form. Fall back to the top-1 source if no citations
          // were emitted (model didn't follow the prompt).
          const cited = collectCitedSources(allSources, buffer);
          updateAssistant({ text: buffer, sources: cited, pending: false });
        };

        await consume();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Something went wrong.";
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  text: `Sorry — ${message}`,
                  pending: false,
                  refused: true,
                }
              : msg,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="border-b border-neutral-200 pb-4 dark:border-neutral-800">
        <h1 className="text-xl font-semibold">Internal Docs Assistant</h1>
        <p className="text-sm text-neutral-500">
          Ask about our logistics processes. Answers cite the source doc.
        </p>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 space-y-6 overflow-y-auto pb-32 pt-2"
      >
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
            <p className="mb-3 font-medium">Try a question like:</p>
            <ul className="space-y-2">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => submit(s)}
                    className="text-left text-blue-700 hover:underline dark:text-blue-300"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="sticky bottom-0 -mx-4 bg-gradient-to-t from-neutral-50 via-neutral-50 to-transparent px-4 pb-4 pt-6 dark:from-neutral-950 dark:via-neutral-950"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-neutral-300 bg-white p-2 shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(input);
              }
            }}
            rows={1}
            placeholder="Ask a question about our internal docs..."
            className="min-h-[40px] flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400 dark:disabled:bg-neutral-700"
          >
            {busy ? "Asking..." : "Ask"}
          </button>
        </div>
        <p className="mt-2 text-center text-xs text-neutral-400">
          Answers are grounded in the indexed docs. The assistant will say
          &quot;I don&apos;t have a doc that covers that&quot; when it can&apos;t
          find an answer.
        </p>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-blue-600 px-4 py-3 text-sm text-white shadow-sm">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-3 rounded-2xl bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <div
          className={`whitespace-pre-wrap leading-relaxed ${
            message.refused ? "italic text-neutral-500" : ""
          }`}
        >
          {message.text}
          {message.pending && (
            <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-neutral-400 align-middle" />
          )}
        </div>
        {message.sources && message.sources.length > 0 && (
          <SourcesPanel sources={message.sources} />
        )}
      </div>
    </div>
  );
}

function SourcesPanel({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-t border-neutral-200 pt-2 text-xs dark:border-neutral-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        <span>
          {sources.length} source{sources.length === 1 ? "" : "s"} cited
        </span>
        <span>{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {sources.map((s) => (
            <li
              key={s.index}
              id={`s${s.index}`}
              className="rounded-md bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800/60"
            >
              <a
                href={s.source || "#"}
                className="font-medium text-blue-700 hover:underline dark:text-blue-300"
                target={s.source.startsWith("http") ? "_blank" : undefined}
                rel={s.source.startsWith("http") ? "noreferrer" : undefined}
              >
                [{s.index}] {s.title}
              </a>
              {s.heading && (
                <span className="ml-1 text-neutral-500">— {s.heading}</span>
              )}
              <span className="ml-2 text-neutral-400">
                ({(s.similarity * 100).toFixed(0)}%)
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Scans the streamed text for inline [N] citations and returns the subset
 * of `allSources` whose index appears at least once. Preserves the
 * order of `allSources`. Falls back to the top-1 source if no citations
 * were emitted (e.g., the model didn't follow the prompt).
 */
function collectCitedSources(allSources: Source[], text: string): Source[] {
  if (allSources.length === 0) return [];
  const cited = new Set<number>();
  const re = /\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= allSources.length) {
      cited.add(n);
    }
  }
  if (cited.size === 0) return allSources.slice(0, 1);
  return allSources.filter((s) => cited.has(s.index));
}
