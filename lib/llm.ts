export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(cfg: LLMConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.temperature = cfg.temperature ?? 0.2;
    this.maxTokens = cfg.maxTokens ?? 800;
  }

  static fromEnv(): LLMClient {
    const baseUrl = process.env.GENERATION_BASE_URL;
    const apiKey = process.env.GENERATION_API_KEY;
    const model = process.env.GENERATION_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new Error(
        "Missing one of: GENERATION_BASE_URL, GENERATION_API_KEY, GENERATION_MODEL",
      );
    }
    return new LLMClient({ baseUrl, apiKey, model });
  }

  /**
   * Streams chat completion chunks as a ReadableStream of UTF-8 text deltas.
   * The caller is expected to read with the platform's Web Streams API.
   */
  streamChat(messages: ChatMessage[]): ReadableStream<Uint8Array> {
    const self = this;
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        let res: Response;
        try {
          res = await fetch(`${self.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${self.apiKey}`,
            },
            body: JSON.stringify({
              model: self.model,
              messages,
              temperature: self.temperature,
              max_tokens: self.maxTokens,
              stream: true,
            }),
          });
        } catch (err) {
          controller.error(err);
          return;
        }

        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => "");
          controller.error(
            new Error(
              `chat ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
            ),
          );
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let sep: number;
            // SSE format: "data: {...}\n\n" terminated by "data: [DONE]"
            while ((sep = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, sep).trim();
              buffer = buffer.slice(sep + 1);
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") {
                controller.close();
                return;
              }
              try {
                const json = JSON.parse(payload) as {
                  choices?: { delta?: { content?: string } }[];
                };
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) controller.enqueue(encoder.encode(delta));
              } catch {
                // ignore malformed lines; providers occasionally send keep-alives
              }
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }
}
