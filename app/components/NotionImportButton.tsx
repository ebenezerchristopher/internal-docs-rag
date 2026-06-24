"use client";

import { useCallback, useRef, useState } from "react";

type Status = "idle" | "running" | "done" | "error";

interface PageEvent {
  index: number;
  total: number;
  title: string;
  chunks: number;
  skipped?: boolean;
}

interface DoneEvent {
  total_pages: number;
  total_chunks: number;
}

interface ImportButtonProps {
  onComplete?: () => void;
}

export function NotionImportButton({ onComplete }: ImportButtonProps) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [rootPageId, setRootPageId] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [pages, setPages] = useState<PageEvent[]>([]);
  const [done, setDone] = useState<DoneEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setToken("");
    setRootPageId("");
    setStatus("idle");
    setError(null);
    setLog([]);
    setPages([]);
    setDone(null);
  }, []);

  const close = useCallback(() => {
    if (status === "running") {
      abortRef.current?.abort();
    }
    setOpen(false);
    // Clear state shortly after the modal closes so the next open is fresh.
    setTimeout(reset, 200);
  }, [status, reset]);

  const submit = useCallback(async () => {
    if (!token.trim() || !rootPageId.trim() || status === "running") return;
    setStatus("running");
    setError(null);
    setLog([`Starting import from Notion page ${rootPageId.trim()}...`]);
    setPages([]);
    setDone(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/notion/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: token.trim(),
          rootPageId: rootPageId.trim(),
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Request failed: ${res.status} ${txt.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstEvent = true;

      while (true) {
        const { done: rdone, value } = await reader.read();
        if (rdone) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let ev: { type: string; [k: string]: unknown };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (firstEvent) {
            firstEvent = false;
          }
          switch (ev.type) {
            case "start": {
              const total = ev.total_pages as number;
              setLog((l) => [
                ...l,
                `Found ${total} page${total === 1 ? "" : "s"}. Indexing...`,
              ]);
              break;
            }
            case "page": {
              const p = ev as unknown as PageEvent & { type: string };
              setPages((ps) => [
                ...ps,
                {
                  index: p.index,
                  total: p.total,
                  title: p.title,
                  chunks: p.chunks,
                  skipped: p.skipped,
                },
              ]);
              setLog((l) => [
                ...l,
                p.skipped
                  ? `[${p.index}/${p.total}] ${p.title} (skipped, empty)`
                  : `[${p.index}/${p.total}] ${p.title} — ${p.chunks} chunk${p.chunks === 1 ? "" : "s"}`,
              ]);
              break;
            }
            case "done": {
              const d = ev as unknown as DoneEvent & { type: string };
              setDone({ total_pages: d.total_pages, total_chunks: d.total_chunks });
              setLog((l) => [
                ...l,
                `Done. ${d.total_pages} pages, ${d.total_chunks} chunks indexed.`,
              ]);
              setStatus("done");
              onComplete?.();
              break;
            }
            case "error": {
              const msg = (ev.message as string) ?? "Unknown error";
              setError(msg);
              setStatus("error");
              setLog((l) => [...l, `Error: ${msg}`]);
              break;
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setLog((l) => [...l, "Cancelled by user."]);
        setStatus("idle");
        return;
      }
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      setStatus("error");
      setLog((l) => [...l, `Error: ${msg}`]);
    }
  }, [token, rootPageId, status, onComplete]);

  const isRunning = status === "running";
  const progressPct =
    pages.length > 0
      ? Math.min(100, Math.round((pages.length / Math.max(1, pages[pages.length - 1]!.total)) * 100))
      : 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        Import from Notion
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isRunning) close();
          }}
        >
          <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl dark:bg-neutral-900">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-base font-semibold">
                Import docs from Notion
              </h2>
              <button
                type="button"
                onClick={close}
                disabled={isRunning}
                className="text-sm text-neutral-500 hover:text-neutral-700 disabled:opacity-30"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {status === "idle" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                className="space-y-3"
              >
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                    Notion integration token
                  </label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="secret_..."
                    className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800"
                    required
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Create one at{" "}
                    <a
                      href="https://www.notion.so/profile/integrations"
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-700 hover:underline dark:text-blue-300"
                    >
                      notion.so/profile/integrations
                    </a>
                    . Capabilities: only{" "}
                    <em>Read content</em> is required. Share each page you
                    want indexed with the integration. The token is sent once
                    and not stored.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                    Root page ID
                  </label>
                  <input
                    type="text"
                    value={rootPageId}
                    onChange={(e) => setRootPageId(e.target.value)}
                    placeholder="e.g. 1a2b3c4d-5e6f-7g8h-9i0j-abcdef123456"
                    className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800"
                    required
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    The import walks the page tree under this page. Use the
                    page ID from the Notion URL.
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!token.trim() || !rootPageId.trim()}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
                  >
                    Start import
                  </button>
                </div>
              </form>
            )}

            {(isRunning || status === "done" || status === "error") && (
              <div className="space-y-3">
                <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div
                    className="h-full bg-blue-600 transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="text-xs text-neutral-500">
                  {pages.length > 0
                    ? `${pages.length} / ${pages[pages.length - 1]!.total} pages indexed`
                    : "Connecting to Notion..."}
                  {done && ` — ${done.total_chunks} chunks total`}
                </p>
                <pre className="max-h-64 overflow-y-auto rounded-md bg-neutral-50 p-2 text-[11px] leading-snug text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200">
                  {log.join("\n")}
                </pre>
                {error && (
                  <p className="rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
                    {error}
                  </p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  {isRunning && (
                    <button
                      type="button"
                      onClick={() => abortRef.current?.abort()}
                      className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700"
                    >
                      Cancel
                    </button>
                  )}
                  {!isRunning && (
                    <button
                      type="button"
                      onClick={close}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      {status === "error" ? "Close" : "Done"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
