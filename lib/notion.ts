// Notion API client. Walks a page tree starting from a root page ID,
// converting every page to markdown. Per-user tokens are passed in by
// the caller; this module never reads from process.env.

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionPage {
  id: string;
  title: string;
  notionUrl: string;
  markdown: string;
}

export class NotionClient {
  constructor(private readonly token: string) {}

  private async apiGet<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${NOTION_BASE}${path}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        "notion-version": NOTION_VERSION,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Notion API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Fetches the page tree starting at rootId, returning one NotionPage per page. */
  async walkPageTree(rootId: string): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    const visited = new Set<string>();
    await this.walkPage(rootId, pages, visited, 0);
    return pages;
  }

  private async walkPage(
    pageId: string,
    out: NotionPage[],
    visited: Set<string>,
    depth: number,
  ): Promise<void> {
    if (visited.has(pageId)) return;
    visited.add(pageId);
    if (depth > 6) return; // safety: Notion can have deep nesting

    const page = await this.getPage(pageId);
    if (!page) return;

    const blocks = await this.getAllChildren(pageId);
    const childIds: string[] = [];
    const ownBlocks: NotionBlock[] = [];

    for (const b of blocks) {
      if (b.type === "child_page") {
        childIds.push(b.id);
      } else {
        ownBlocks.push(b);
      }
    }

    const md = blocksToMarkdown(ownBlocks);
    if (md.trim() || page.title) {
      out.push({
        id: pageId,
        title: page.title,
        notionUrl: page.url,
        markdown: md,
      });
    }

    for (const cid of childIds) {
      await this.walkPage(cid, out, visited, depth + 1);
    }
  }

  private async getPage(
    id: string,
  ): Promise<{ title: string; url: string } | null> {
    try {
      const data = await this.apiGet<NotionPageResponse>(`/pages/${id}`);
      const title = extractTitle(data);
      const url = data.url ?? `https://www.notion.so/${id.replace(/-/g, "")}`;
      return { title: title || "Untitled", url };
    } catch (err) {
      // If a single page is missing/forbidden, skip it instead of failing the
      // whole import.
      console.warn(`[notion] skip page ${id}:`, (err as Error).message);
      return null;
    }
  }

  private async getAllChildren(parentId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = [];
    let cursor: string | undefined;
    for (;;) {
      const qs = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
      const data = await this.apiGet<NotionChildrenResponse>(
        `/blocks/${parentId}/children${qs}`,
      );
      for (const b of data.results) all.push(b);
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
    return all;
  }
}

// ---- Types ----

interface NotionPageResponse {
  id: string;
  url?: string;
  properties?: Record<string, unknown>;
}

interface NotionChildrenResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlock {
  id: string;
  type: string;
  child_page?: { title: string };
  paragraph?: { rich_text: NotionRichText[] };
  heading_1?: { rich_text: NotionRichText[] };
  heading_2?: { rich_text: NotionRichText[] };
  heading_3?: { rich_text: NotionRichText[] };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  numbered_list_item?: { rich_text: NotionRichText[] };
  to_do?: { rich_text: NotionRichText[]; checked: boolean };
  code?: { rich_text: NotionRichText[]; language: string };
  quote?: { rich_text: NotionRichText[] };
  callout?: { rich_text: NotionRichText[]; icon?: { emoji?: string } };
  divider?: Record<string, never>;
}

interface NotionRichText {
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
  };
}

// ---- Title extraction ----

function extractTitle(page: NotionPageResponse): string {
  const props = page.properties ?? {};
  // The title property is the one whose type is "title".
  for (const value of Object.values(props)) {
    if (value && typeof value === "object" && (value as { type?: string }).type === "title") {
      const arr = (value as { title?: NotionRichText[] }).title;
      if (Array.isArray(arr)) {
        return arr.map((r) => r.plain_text).join("").trim();
      }
    }
  }
  return "";
}

// ---- Block -> markdown ----

function blocksToMarkdown(blocks: NotionBlock[]): string {
  return blocks.map(blockToMarkdown).filter((s) => s.length > 0).join("\n\n");
}

function blockToMarkdown(block: NotionBlock): string {
  switch (block.type) {
    case "paragraph":
      return richTextToMarkdown(block.paragraph?.rich_text ?? []);
    case "heading_1":
      return "# " + richTextToMarkdown(block.heading_1?.rich_text ?? []);
    case "heading_2":
      return "## " + richTextToMarkdown(block.heading_2?.rich_text ?? []);
    case "heading_3":
      return "### " + richTextToMarkdown(block.heading_3?.rich_text ?? []);
    case "bulleted_list_item":
      return "- " + richTextToMarkdown(block.bulleted_list_item?.rich_text ?? []);
    case "numbered_list_item":
      return "1. " + richTextToMarkdown(block.numbered_list_item?.rich_text ?? []);
    case "to_do": {
      const box = block.to_do?.checked ? "[x]" : "[ ]";
      return `- ${box} ${richTextToMarkdown(block.to_do?.rich_text ?? [])}`;
    }
    case "code": {
      const lang = block.code?.language ?? "";
      const text = richTextToMarkdown(block.code?.rich_text ?? []);
      return "```" + lang + "\n" + text + "\n```";
    }
    case "quote":
      return "> " + richTextToMarkdown(block.quote?.rich_text ?? []);
    case "callout": {
      const icon = block.callout?.icon?.emoji ?? "";
      const text = richTextToMarkdown(block.callout?.rich_text ?? []);
      return `> ${icon} ${text}`.trim();
    }
    case "divider":
      return "---";
    default:
      // Unknown / unsupported block type — skip silently.
      return "";
  }
}

function richTextToMarkdown(rich: NotionRichText[]): string {
  return rich
    .map((rt) => {
      let t = rt.plain_text;
      const a = rt.annotations ?? {};
      if (a.code) t = "`" + t + "`";
      if (a.bold) t = "**" + t + "**";
      if (a.italic) t = "*" + t + "*";
      if (a.code) t = "`" + t + "`";
      if (rt.href) t = `[${t}](${rt.href})`;
      return t;
    })
    .join("");
}
