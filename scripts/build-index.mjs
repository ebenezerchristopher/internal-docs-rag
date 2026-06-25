#!/usr/bin/env node
// Build the vector index from content/docs/**/*.md.
// Run via `npm run index` or automatically as the `prebuild` step.
//
// Idempotent across re-runs: each run is tagged with a build_id; chunks from
// prior builds are removed once the new set is in place.

import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(ROOT, "content", "docs");

const BUILD_ID = new Date().toISOString().replace(/[:.]/g, "-");

const REQUIRED = [
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

function checkEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      `[index] Missing required env vars: ${missing.join(", ")}\n` +
        "Set them in .env (see .env.example) and try again.",
    );
    process.exit(1);
  }
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: raw };
  const fmBlock = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");
  const data = {};
  for (const line of fmBlock.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    data[m[1]] = v;
  }
  return { data, body };
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function docIdFromPath(rel) {
  return rel
    .replace(/^content\/docs\//, "")
    .replace(/\.md$/, "")
    .replace(/\//g, "::");
}

function slug(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

const TARGET = 1200;
const HARD_CAP = 1600;
const OVERLAP = 200;

function chunkDocument(doc) {
  const lines = doc.body.split(/\r?\n/);
  const sections = [{ heading: doc.title, body: [] }];
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) sections.push({ heading: m[2].trim(), body: [] });
    else sections[sections.length - 1].body.push(line);
  }
  const chunks = [];
  let chunkIndex = 0;
  for (const section of sections) {
    const cleaned = section.body
      .map((l) => l.trimEnd())
      .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
      .join("\n")
      .trim();
    if (!cleaned) continue;
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
    const paragraphs = cleaned
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
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
      buffer = buffer.length > OVERLAP ? buffer.slice(-OVERLAP) : "";
    };
    for (const p of paragraphs) {
      const candidate = buffer ? buffer + "\n\n" + p : p;
      if (candidate.length > HARD_CAP) {
        flush();
        buffer = buffer + "\n\n" + p;
        if (buffer.length > HARD_CAP) {
          const sentences = p.split(/(?<=[.!?])\s+/);
          for (const s of sentences) {
            if ((buffer + " " + s).length > HARD_CAP) flush();
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
  return chunks.map((c) => ({
    ...c,
    id: `${c.docId}#${slug(c.heading)}#${c.chunkIndex}`,
  }));
}

class EmbeddingsClient {
  constructor({ baseUrl, apiKey, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.batchSize = 64;
    this.concurrency = 8;
  }
  async embed(texts) {
    if (texts.length === 0) return [];
    const batches = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize));
    }
    const results = new Array(texts.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const idx = cursor++;
        const batch = batches[idx];
        const out = await this.embedBatch(batch);
        const start = idx * this.batchSize;
        for (let i = 0; i < out.length; i++) results[start + i] = out[i];
      }
    };
    const workers = Array.from(
      { length: Math.min(this.concurrency, batches.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }
  async embedBatch(input, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.embedBatchOnce(input);
      } catch (err) {
        lastErr = err;
        const delay = 500 * 2 ** i;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }
  async embedBatchOnce(input) {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `embeddings ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
    }
    const json = await res.json();
    return json.data.map((d) => d.embedding);
  }
}

async function main() {
  checkEnv();

  const exists = await fs
    .stat(DOCS_DIR)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    console.error(`[index] No docs directory at ${DOCS_DIR}`);
    process.exit(1);
  }

  const files = await walk(DOCS_DIR);
  console.log(`[index] Found ${files.length} markdown files under content/docs`);

  if (files.length < 50) {
    console.warn(
      `[index] (warn) only ${files.length} docs found; brief requires at least 50`,
    );
  }

  const allChunks = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const rel = path.relative(ROOT, file);
    const docId = docIdFromPath(rel);
    const chunks = chunkDocument({
      id: docId,
      source: rel,
      title: data.title || path.basename(file, ".md"),
      body,
    });
    for (const c of chunks) {
      allChunks.push({
        id: c.id,
        content: c.text,
        metadata: {
          source_type: "file",
          title: c.title,
          heading: c.heading,
          source: c.source,
          doc_id: c.docId,
          chunk_index: c.chunkIndex,
          build_id: BUILD_ID,
        },
      });
    }
  }

  console.log(`[index] Generated ${allChunks.length} chunks`);

  if (allChunks.length === 0) {
    console.error("[index] No chunks to embed; aborting");
    process.exit(1);
  }

  const embedder = new EmbeddingsClient({
    baseUrl: process.env.EMBEDDING_BASE_URL,
    apiKey: process.env.EMBEDDING_API_KEY,
    model: process.env.EMBEDDING_MODEL,
  });

  console.log(`[index] Embedding with model ${process.env.EMBEDDING_MODEL}...`);
  const vectors = await embedder.embed(allChunks.map((c) => c.content));
  console.log(`[index] Embedded ${vectors.length} chunks`);

  // pgvector accepts a string like '[0.1,0.2,...]'
  const rows = allChunks.map((c, i) => ({
    id: c.id,
    content: c.content,
    metadata: c.metadata,
    embedding: `[${vectors[i].join(",")}]`,
  }));

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Skip the file index if Notion chunks are present. The file indexer
  // is the default for fresh deploys, but on subsequent deploys the
  // prebuild would otherwise wipe a Notion import. Set FORCE_FILE_INDEX=1
  // to bypass this check and replace whatever is in the index with the
  // sample file docs.
  if (process.env.FORCE_FILE_INDEX !== "1") {
    const { data: notionRows, error: notionCheckErr } = await supabase
      .from("documents")
      .select("id")
      .eq("metadata->>source_type", "notion")
      .limit(1);
    if (notionCheckErr) {
      console.warn(
        `[index] (warn) could not check for Notion rows: ${notionCheckErr.message}`,
      );
    } else if (notionRows && notionRows.length > 0) {
      console.log(
        `[index] Notion-imported chunks detected; skipping file index to preserve them.`,
      );
      console.log(
        `[index] To replace them with the file corpus, set FORCE_FILE_INDEX=1 and re-run.`,
      );
      return;
    }
  }

  // Upsert in batches to stay under Supabase's request size limits.
  const UPSERT_BATCH = 100;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase.from("documents").upsert(batch);
    if (error) {
      console.error(`[index] upsert failed at ${i}: ${error.message}`);
      process.exit(1);
    }
    console.log(`[index] upserted ${i + batch.length}/${rows.length}`);
  }

  // Clean up so the file indexer is authoritative when it runs:
  //   1. Drop any Notion-imported rows (source_type = "notion").
  //   2. Drop prior file builds (anything tagged as "file" with a
  //      different build_id).
  // The newly upserted rows have source_type = "file" and
  // build_id = BUILD_ID, so neither delete touches them.
  const { error: delNotion } = await supabase
    .from("documents")
    .delete()
    .eq("metadata->>source_type", "notion");
  if (delNotion) {
    console.warn(`[index] (warn) could not drop Notion rows: ${delNotion.message}`);
  }
  const { error: cleanupErr } = await supabase
    .from("documents")
    .delete()
    .eq("metadata->>source_type", "file")
    .neq("metadata->>build_id", BUILD_ID);
  if (cleanupErr) {
    console.warn(
      `[index] (warn) could not clean prior builds: ${cleanupErr.message}`,
    );
  }

  console.log(`[index] Done. build_id=${BUILD_ID}`);
}

main().catch((err) => {
  console.error("[index] fatal:", err);
  process.exit(1);
});
