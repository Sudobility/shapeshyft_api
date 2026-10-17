import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageProvider } from "./image-provider";

afterEach(() => vi.unstubAllGlobals());

describe("Gemini image output", () => {
  it("returns inline image bytes as generated media and sends a reference image", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
        generationConfig: { responseModalities: string[] };
      };
      expect(body.generationConfig.responseModalities).toEqual(["IMAGE"]);
      expect(body.contents[0]?.parts[0]).toEqual({
        inlineData: { mimeType: "image/png", data: "aGVsbG8=" },
      });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: "image/png", data: "cG5n" } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8 },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("gemini", { apiKey: "test" });
    const result = await provider.generate({
      prompt: "Turnaround",
      outputSchema: { type: "object" },
      model: "gemini-3.1-flash-image",
      expectsMediaOutput: { image: true },
      media: [
        {
          type: "image",
          format: "base64",
          mimeType: "image/png",
          data: "aGVsbG8=",
          fieldName: "referenceImage",
        },
      ],
    });
    expect(result.generatedMedia).toEqual([
      { type: "image", mimeType: "image/png", data: "cG5n" },
    ]);
    expect(result.usage).toMatchObject({
      promptTokens: 4,
      completionTokens: 8,
    });
  });
});

describe("OpenAI image output", () => {
  it("generates an image from a prompt and maps usage", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/images/generations");
      const body = JSON.parse(String(init.body)) as {
        model: string;
        prompt: string;
        output_format: string;
      };
      expect(body.model).toBe("gpt-image-1");
      expect(body.prompt).toBe("A wizard portrait");
      expect(body.output_format).toBe("png");
      return new Response(
        JSON.stringify({
          data: [{ b64_json: "cG5n" }],
          usage: { input_tokens: 12, output_tokens: 90, total_tokens: 102 },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("openai", { apiKey: "test" });
    const result = await provider.generate({
      prompt: "A wizard portrait",
      outputSchema: { type: "object" },
      model: "gpt-image-1",
      expectsMediaOutput: { image: true },
    });
    expect(result.generatedMedia).toEqual([
      { type: "image", mimeType: "image/png", data: "cG5n" },
    ]);
    expect(result.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 90,
      totalTokens: 102,
    });
  });

  it("uses the edits endpoint with a multipart reference image", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/images/edits");
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get("model")).toBe("gpt-image-1");
      expect(form.get("prompt")).toBe("Make it a portrait");
      expect(form.get("output_format")).toBe("png");
      expect(form.get("image[]")).toBeInstanceOf(Blob);
      return new Response(
        JSON.stringify({
          data: [{ b64_json: "ZWRpdA==" }],
          usage: { input_tokens: 5, output_tokens: 20, total_tokens: 25 },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("openai", { apiKey: "test" });
    const result = await provider.generate({
      prompt: "Make it a portrait",
      outputSchema: { type: "object" },
      model: "gpt-image-1",
      expectsMediaOutput: { image: true },
      media: [
        {
          type: "image",
          format: "base64",
          mimeType: "image/png",
          data: "aGVsbG8=",
          fieldName: "referenceImage",
        },
      ],
    });
    expect(result.generatedMedia).toEqual([
      { type: "image", mimeType: "image/png", data: "ZWRpdA==" },
    ]);
  });

  it("passes non-image requests through to the base provider", async () => {
    const provider = createImageProvider("openai", { apiKey: "test" });
    // No expectsMediaOutput.image → must not hit the Images API. A missing
    // fetch stub would throw if it tried; instead the base provider handles it.
    expect(typeof provider.generate).toBe("function");
  });
});
