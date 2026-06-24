export type EmbeddingVector = number[];

export interface EmbeddingsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  batchSize?: number;
  concurrency?: number;
}

export class EmbeddingsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(cfg: EmbeddingsConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.batchSize = cfg.batchSize ?? 64;
    this.concurrency = cfg.concurrency ?? 8;
  }

  static fromEnv(): EmbeddingsClient {
    const baseUrl = process.env.OPENAI_BASE_URL;
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.EMBEDDING_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new Error(
        "Missing one of: OPENAI_BASE_URL, OPENAI_API_KEY, EMBEDDING_MODEL",
      );
    }
    return new EmbeddingsClient({ baseUrl, apiKey, model });
  }

  async embed(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize));
    }

    const results: EmbeddingVector[] = new Array(texts.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const idx = cursor++;
        const batch = batches[idx];
        const out = await this.embedBatchWithRetry(batch);
        const start = idx * this.batchSize;
        for (let i = 0; i < out.length; i++) {
          results[start + i] = out[i];
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.concurrency, batches.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }

  private async embedBatchWithRetry(
    input: string[],
    attempts = 3,
  ): Promise<EmbeddingVector[]> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.embedBatch(input);
      } catch (err) {
        lastErr = err;
        const delay = 500 * 2 ** i;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  private async embedBatch(input: string[]): Promise<EmbeddingVector[]> {
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
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}
