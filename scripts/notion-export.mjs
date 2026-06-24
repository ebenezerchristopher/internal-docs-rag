#!/usr/bin/env node
// One-shot script: read every markdown file under content/docs/ and
// create a Notion page for each under a parent page the user specifies.
//
// Usage:
//   NOTION_TOKEN=secret_... NOTION_PARENT_PAGE_ID=<uuid> node scripts/notion-export.mjs
//
// The Notion integration must have the "Insert content" capability
// (and "Update content" if you want to re-run and overwrite). The
// parent page must be shared with the integration.
//
// The script does NOT delete existing pages on re-runs; it creates
// new pages. To rebuild, delete the previously created pages in
// Notion first or use a fresh parent page.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(ROOT, "content", "docs");

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const CREATE_BATCH = 80; // Notion caps page-create children at 100

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[export] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
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

// ---- markdown -> Notion blocks ----

function mdToNotionBlocks(md) {
  const blocks = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim() || "plain text";
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({
        object: "block",
        type: "code",
        code: {
          language: mapLang(lang),
          rich_text: richText(buf.join("\n")),
        },
      });
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [] } });
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const type = `heading_${level}`;
      blocks.push({
        object: "block",
        type,
        [type]: { rich_text: richText(h[2]) },
      });
      i++;
      continue;
    }

    // Block quote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: richText(buf.join(" ")) },
      });
      continue;
    }

    // Bulleted list
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      for (const text of items) {
        blocks.push({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: richText(text) },
        });
      }
      continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      for (const text of items) {
        blocks.push({
          object: "block",
          type: "numbered_list_item",
          numbered_list_item: { rich_text: richText(text) },
        });
      }
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (collect until blank line or new block)
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|[-*]\s|>\s|\d+\.\s|```|---+\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(buf.join(" ")) },
    });
  }

  return blocks;
}

const SUPPORTED_LANGS = new Set([
  "plain text","abap","agda","arduino","ascii art","assembly","bash","basic","bnf","c","c#","c++","clojure","coffeescript","coq","css","dart","dhall","diff","docker","ebnf","elixir","elm","erlang","f#","flow","fortran","gherkin","glsl","go","graphql","groovy","haskell","hcl","html","idris","java","javascript","json","julia","kotlin","latex","less","lisp","livescript","llvm ir","lua","makefile","markdown","markup","matlab","mathematica","mermaid","nix","notion formula","objective-c","ocaml","pascal","perl","php","plain text","powershell","prolog","protobuf","purescript","python","r","racket","reason","ruby","rust","sass","scala","scheme","scss","shell","smalltalk","solidity","sparql","sql","swift","toml","typescript","vb.net","verilog","vhdl","visual basic","webassembly","xml","yaml","java/c/c++/c#"
]);

function mapLang(lang) {
  const l = lang.toLowerCase();
  if (SUPPORTED_LANGS.has(l)) return l;
  if (l === "js") return "javascript";
  if (l === "ts") return "typescript";
  if (l === "py") return "python";
  if (l === "sh" || l === "shell") return "shell";
  if (l === "yml") return "yaml";
  if (l === "md") return "markdown";
  return "plain text";
}

// Convert inline markdown to Notion rich_text segments.
// Handles **bold**, *italic*, `code`, [text](url).
function richText(text) {
  if (!text) return [];
  const out = [];
  let i = 0;
  let buf = "";
  const flush = (annotations) => {
    if (buf) {
      out.push({
        type: "text",
        text: { content: buf },
        annotations,
      });
      buf = "";
    }
  };
  while (i < text.length) {
    // Link: [text](url)
    const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(text.slice(i));
    if (link) {
      flush({ bold: false, italic: false, code: false });
      out.push({
        type: "text",
        text: { content: link[1], link: { url: link[2] } },
        annotations: { bold: false, italic: false, code: false },
      });
      i += link[0].length;
      continue;
    }
    // Bold: **...**
    const bold = /^\*\*([^*]+)\*\*/.exec(text.slice(i));
    if (bold) {
      flush({ bold: false, italic: false, code: false });
      out.push({
        type: "text",
        text: { content: bold[1] },
        annotations: { bold: true, italic: false, code: false },
      });
      i += bold[0].length;
      continue;
    }
    // Italic: *...*
    const italic = /^\*([^*]+)\*/.exec(text.slice(i));
    if (italic) {
      flush({ bold: false, italic: false, code: false });
      out.push({
        type: "text",
        text: { content: italic[1] },
        annotations: { bold: false, italic: true, code: false },
      });
      i += italic[0].length;
      continue;
    }
    // Inline code: `...`
    const code = /^`([^`]+)`/.exec(text.slice(i));
    if (code) {
      flush({ bold: false, italic: false, code: false });
      out.push({
        type: "text",
        text: { content: code[1] },
        annotations: { bold: false, italic: false, code: true },
      });
      i += code[0].length;
      continue;
    }
    buf += text[i];
    i++;
  }
  flush({ bold: false, italic: false, code: false });
  // Notion caps each rich_text segment content at 2000 chars.
  return out.flatMap((rt) => splitLongSegment(rt));
}

function splitLongSegment(rt) {
  const MAX = 2000;
  if (rt.text.content.length <= MAX) return [rt];
  const out = [];
  let s = rt.text.content;
  while (s.length > MAX) {
    out.push({ ...rt, text: { ...rt.text, content: s.slice(0, MAX) } });
    s = s.slice(MAX);
  }
  if (s.length > 0) out.push({ ...rt, text: { ...rt.text, content: s } });
  return out;
}

// ---- Notion API ----

async function notionFetch(pathname, init = {}, token) {
  const res = await fetch(`${NOTION_BASE}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Notion ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    );
  }
  return res.json();
}

async function createPage(parentId, title, blocks, token) {
  // First create the page with the first CREATE_BATCH blocks
  const initialBlocks = blocks.slice(0, CREATE_BATCH);
  const page = await notionFetch(
    "/pages",
    {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: parentId },
        properties: {
          title: { title: [{ type: "text", text: { content: title } }] },
        },
        children: initialBlocks,
      }),
    },
    token,
  );

  // Append the rest in batches
  let cursor = CREATE_BATCH;
  while (cursor < blocks.length) {
    const batch = blocks.slice(cursor, cursor + CREATE_BATCH);
    await notionFetch(
      `/blocks/${page.id}/children`,
      { method: "PATCH", body: JSON.stringify({ children: batch }) },
      token,
    );
    cursor += CREATE_BATCH;
  }
  return page;
}

// ---- main ----

async function main() {
  const token = requireEnv("NOTION_TOKEN");
  const parentId = requireEnv("NOTION_PARENT_PAGE_ID");

  if (!(await fs.stat(DOCS_DIR).then(() => true).catch(() => false))) {
    console.error(`[export] No docs directory at ${DOCS_DIR}`);
    process.exit(1);
  }

  const files = await walk(DOCS_DIR);
  files.sort();
  console.log(`[export] Found ${files.length} markdown files`);

  let ok = 0;
  let err = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = path.relative(ROOT, file);
    const raw = await fs.readFile(file, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const title = (data.title || path.basename(file, ".md")).slice(0, 200);
    const blocks = mdToNotionBlocks(body);
    try {
      await createPage(parentId, title, blocks, token);
      ok++;
      console.log(`[export] (${i + 1}/${files.length}) ${title}`);
    } catch (e) {
      err++;
      console.error(`[export] (${i + 1}/${files.length}) FAILED ${title}: ${e.message}`);
    }
    // Notion rate limit: ~3 req/s
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(`[export] Done. ${ok} created, ${err} failed.`);
  if (err > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[export] fatal:", e);
  process.exit(1);
});
