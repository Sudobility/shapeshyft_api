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
