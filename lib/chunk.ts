export interface Chunk {
  docId: string;
  source: string;
  title: string;
  heading: string;
  chunkIndex: number;
  text: string;
}

export interface DocumentInput {
  id: string;
  source: string; // repo-relative path, e.g. content/docs/ops/delay-complaints.md
  title: string;
  body: string;
}

const TARGET = 1200;
const HARD_CAP = 1600;
const OVERLAP = 200;

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

export function chunkDocument(doc: DocumentInput): Chunk[] {
  const lines = doc.body.split(/\r?\n/);
  const sections: { heading: string; body: string[] }[] = [
    { heading: doc.title, body: [] },
  ];

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      sections.push({ heading: m[2].trim(), body: [] });
    } else {
      sections[sections.length - 1]!.body.push(line);
    }
  }

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const cleaned = section.body
      .map((l) => l.trimEnd())
      .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
      .join("\n")
      .trim();

    if (!cleaned) continue;

    // If the section fits in a single chunk, emit as-is.
    if (cleaned.length <= TARGET) {
      chunks.push({
        docId: doc.id,
        source: doc.source,
        title: doc.title,
        heading: section.heading,
        chunkIndex: chunkIndex++,
        text: cleaned,
      });
      continue;
    }

    // Otherwise split by paragraphs first, then accumulate up to TARGET.
    const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let buffer = "";

    const flush = () => {
      if (!buffer) return;
      chunks.push({
        docId: doc.id,
        source: doc.source,
        title: doc.title,
        heading: section.heading,
        chunkIndex: chunkIndex++,
        text: buffer.trim(),
      });
      // Carry overlap from the tail of the previous buffer.
      buffer = buffer.length > OVERLAP ? buffer.slice(-OVERLAP) : "";
    };

    for (const p of paragraphs) {
      const candidate = buffer ? buffer + "\n\n" + p : p;
      if (candidate.length > HARD_CAP) {
        // Hard cap: force a flush and continue with overlap.
        flush();
        buffer = buffer + "\n\n" + p;
        if (buffer.length > HARD_CAP) {
          // Single paragraph longer than HARD_CAP: split by sentences.
          const sentences = p.split(/(?<=[.!?])\s+/);
          for (const s of sentences) {
            if ((buffer + " " + s).length > HARD_CAP) {
              flush();
            }
            buffer = buffer ? buffer + " " + s : s;
            if (buffer.length >= TARGET) flush();
          }
        }
        continue;
      }
      if (candidate.length > TARGET) {
        flush();
        buffer = p;
      } else {
        buffer = candidate;
      }
    }
    flush();
  }

  // Stable docId-derived id so re-runs can upsert deterministically.
  return chunks.map((c) => ({
    ...c,
    id: `${c.docId}#${slug(c.heading)}#${c.chunkIndex}`,
  }));
}
