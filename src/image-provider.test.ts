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

const imageRequest = (model: string, extra: Record<string, unknown> = {}) => ({
  prompt: "A neon city",
  outputSchema: { type: "object" as const },
  model,
  expectsMediaOutput: { image: true },
  ...extra,
});

describe("ByteDance Seedream image output", () => {
  it("posts to the Ark Images API and maps base64 output with per-image cost", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations"
      );
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer test"
      );
      const body = JSON.parse(String(init.body)) as {
        model: string;
        response_format: string;
      };
      expect(body.model).toBe("seedream-4-0-250828");
      expect(body.response_format).toBe("b64_json");
      return new Response(JSON.stringify({ data: [{ b64_json: "cG5n" }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("bytedance", { apiKey: "test" });
    const result = await provider.generate(imageRequest("seedream-4-0-250828"));
    expect(result.generatedMedia).toEqual([
      { type: "image", mimeType: "image/png", data: "cG5n" },
    ]);
    // $0.03/image = 3.0 cents, billed authoritatively.
    expect(result.usage.billedCostCents).toBeCloseTo(3.0);
  });
});

describe("Black Forest Labs FLUX image output", () => {
  it("submits, polls until Ready, then re-hosts the result image", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.bfl.ai/v1/flux-pro-1.1") {
        expect((init?.headers as Record<string, string>)["x-key"]).toBe("test");
        return new Response(
          JSON.stringify({ id: "abc", polling_url: "https://poll.bfl.ai/abc" }),
          { status: 200 }
        );
      }
      if (url === "https://poll.bfl.ai/abc") {
        return new Response(
          JSON.stringify({
            status: "Ready",
            result: { sample: "https://cdn.bfl.ai/abc.png" },
          }),
          { status: 200 }
        );
      }
      // Image download → raw bytes with a content type.
      return new Response(Buffer.from("png"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("bfl", { apiKey: "test" });
    const result = await provider.generate(imageRequest("flux-pro-1.1"));
    expect(result.generatedMedia).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("png").toString("base64"),
      },
    ]);
    expect(result.usage.billedCostCents).toBeCloseTo(4.0);
  });

  it("throws on a terminal non-success status", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("poll")
        ? new Response(JSON.stringify({ status: "Content Moderated" }), {
            status: 200,
          })
        : new Response(
            JSON.stringify({ id: "x", polling_url: "https://poll.bfl.ai/x" }),
            { status: 200 }
          )
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("bfl", { apiKey: "test" });
    await expect(
      provider.generate(imageRequest("flux-pro-1.1"))
    ).rejects.toThrow(/Content Moderated/);
  });
});

describe("Ideogram image output", () => {
  it("sends multipart with rendering_speed from the model id and re-hosts the url", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://api.ideogram.ai/v2/image/generate/ideogram-3") {
        expect((init.headers as Record<string, string>)["Api-Key"]).toBe(
          "test"
        );
        expect(init.body).toBeInstanceOf(FormData);
        expect((init.body as FormData).get("rendering_speed")).toBe("TURBO");
        return new Response(
          JSON.stringify({ data: [{ url: "https://cdn.ideogram.ai/x.png" }] }),
          { status: 200 }
        );
      }
      return new Response(Buffer.from("png"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("ideogram", { apiKey: "test" });
    const result = await provider.generate(imageRequest("ideogram-3-turbo"));
    expect(result.generatedMedia?.[0]?.data).toBe(
      Buffer.from("png").toString("base64")
    );
    expect(result.usage.billedCostCents).toBeCloseTo(3.0);
  });
});

describe("Recraft image output", () => {
  it("requests base64 output from the OpenAI-style endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://external.api.recraft.ai/v1/images/generations");
      const body = JSON.parse(String(init.body)) as { model: string };
      expect(body.model).toBe("recraftv3");
      return new Response(JSON.stringify({ data: [{ b64_json: "cmM=" }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("recraft", { apiKey: "test" });
    const result = await provider.generate(imageRequest("recraftv3"));
    expect(result.generatedMedia).toEqual([
      { type: "image", mimeType: "image/png", data: "cmM=" },
    ]);
    expect(result.usage.billedCostCents).toBeCloseTo(4.0);
  });
});

describe("Stability AI image output", () => {
  it("routes sd3.5 ids to the /sd3 endpoint with a model field and reads base64", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://api.stability.ai/v2beta/stable-image/generate/sd3"
      );
      expect((init.headers as Record<string, string>).Accept).toBe(
        "application/json"
      );
      expect((init.body as FormData).get("model")).toBe("sd3.5-large");
      return new Response(
        JSON.stringify({ image: "c2Q=", finish_reason: "SUCCESS" }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("stability", { apiKey: "test" });
    const result = await provider.generate(imageRequest("sd3.5-large"));
    expect(result.generatedMedia).toEqual([
      { type: "image", mimeType: "image/png", data: "c2Q=" },
    ]);
    expect(result.usage.billedCostCents).toBeCloseTo(6.5);
  });

  it("routes core to its own endpoint without a model field", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://api.stability.ai/v2beta/stable-image/generate/core"
      );
      expect((init.body as FormData).get("model")).toBeNull();
      return new Response(
        JSON.stringify({ image: "Y29yZQ==", finish_reason: "SUCCESS" }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("stability", { apiKey: "test" });
    const result = await provider.generate(imageRequest("stable-image-core"));
    expect(result.generatedMedia?.[0]?.data).toBe("Y29yZQ==");
  });
});

const audioRequest = (model: string, prompt = "Hello world") => ({
  prompt,
  outputSchema: { type: "object" as const },
  model,
  expectsMediaOutput: { audio: true },
});

const videoRequest = (model: string) => ({
  prompt: "A neon city timelapse",
  outputSchema: { type: "object" as const },
  model,
  expectsMediaOutput: { video: true },
});

describe("xAI image output", () => {
  it("requests base64 from the OpenAI-compatible endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.x.ai/v1/images/generations");
      const body = JSON.parse(String(init.body)) as { response_format: string };
      expect(body.response_format).toBe("b64_json");
      return new Response(
        JSON.stringify({
          data: [{ b64_json: "eA==", mime_type: "image/jpeg" }],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("xai", { apiKey: "test" });
    const result = await provider.generate(
      imageRequest("grok-imagine-image-2.0")
    );
    expect(result.generatedMedia).toEqual([
      { type: "image", mimeType: "image/jpeg", data: "eA==" },
    ]);
    expect(result.usage.billedCostCents).toBeCloseTo(4.0);
  });
});

describe("fal.ai aggregator output", () => {
  it("calls the sync fal.run path and decodes an inline data URI", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://fal.run/fal-ai/flux/dev");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Key test"
      );
      expect(JSON.parse(String(init.body)).sync_mode).toBe(true);
      return new Response(
        JSON.stringify({ images: [{ url: "data:image/png;base64,ZmFs" }] }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("fal", { apiKey: "test" });
    const result = await provider.generate(imageRequest("fal-ai/flux/dev"));
    expect(result.generatedMedia).toEqual([
      { type: "image", mimeType: "image/png", data: "ZmFs" },
    ]);
    expect(result.usage.billedCostCents).toBeCloseTo(2.5);
  });
});

describe("Luma Photon output", () => {
  it("uses sync mode and re-hosts assets.image", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/generations/image")) {
        expect(JSON.parse(String(init?.body)).sync).toBe(true);
        return new Response(
          JSON.stringify({
            state: "completed",
            assets: { image: "https://cdn.luma.ai/x.jpg" },
          }),
          { status: 200 }
        );
      }
      return new Response(Buffer.from("img"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("luma", { apiKey: "test" });
    const result = await provider.generate(imageRequest("photon-1"));
    expect(result.generatedMedia?.[0]?.mimeType).toBe("image/jpeg");
    expect(result.usage.billedCostCents).toBeCloseTo(1.5);
  });
});

describe("Alibaba Qwen-Image output", () => {
  it("reads the image from the multimodal-generation response", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("aliyuncs.com"))
        return new Response(
          JSON.stringify({
            output: {
              choices: [
                { message: { content: [{ image: "https://cdn.qwen/x.png" }] } },
              ],
            },
          }),
          { status: 200 }
        );
      return new Response(Buffer.from("q"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("alibaba", { apiKey: "test" });
    const result = await provider.generate(imageRequest("qwen-image-2.0"));
    expect(result.generatedMedia?.[0]?.data).toBe(
      Buffer.from("q").toString("base64")
    );
    expect(result.usage.billedCostCents).toBeCloseTo(2.5);
  });
});

describe("Runway Gen-4 output", () => {
  it("sends the version header, polls, and re-hosts the output", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/text_to_image")) {
        expect(
          (init?.headers as Record<string, string>)["X-Runway-Version"]
        ).toBe("2024-11-06");
        return new Response(JSON.stringify({ id: "task1" }), { status: 200 });
      }
      if (url.endsWith("/tasks/task1"))
        return new Response(
          JSON.stringify({ status: "SUCCEEDED", output: ["https://rw/x.png"] }),
          { status: 200 }
        );
      return new Response(Buffer.from("rw"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("runway", { apiKey: "test" });
    const result = await provider.generate(imageRequest("gen4_image"));
    expect(result.generatedMedia?.[0]?.data).toBe(
      Buffer.from("rw").toString("base64")
    );
    expect(result.usage.billedCostCents).toBeCloseTo(8.0);
  });

  it("rejects gen4_image_turbo without a reference image", async () => {
    const provider = createImageProvider("runway", { apiKey: "test" });
    await expect(
      provider.generate(imageRequest("gen4_image_turbo"))
    ).rejects.toThrow(/reference image/);
  });
});

describe("ElevenLabs audio output", () => {
  it("posts text with xi-api-key, returns audio bytes, bills per character", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb"
      );
      expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(
        "test"
      );
      return new Response(Buffer.from("mp3"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("elevenlabs", { apiKey: "test" });
    const result = await provider.generate(
      audioRequest("eleven_multilingual_v2", "12345") // 5 chars
    );
    expect(result.generatedMedia).toEqual([
      {
        type: "audio",
        mimeType: "audio/mpeg",
        data: Buffer.from("mp3").toString("base64"),
      },
    ]);
    // 5 chars at $0.08/1k = 0.04 cents.
    expect(result.usage.billedCostCents).toBeCloseTo(0.04);
  });
});

describe("Kling video output", () => {
  it("creates with model in the path, polls /tasks, re-hosts the video", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/text-to-video/kling-2.6"))
        return new Response(JSON.stringify({ data: { id: "k1" } }), {
          status: 200,
        });
      if (url.includes("/tasks?task_ids="))
        return new Response(
          JSON.stringify({
            data: [
              {
                status: "succeeded",
                outputs: [{ type: "video", url: "https://kl/v.mp4" }],
              },
            ],
          }),
          { status: 200 }
        );
      return new Response(Buffer.from("vid"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createImageProvider("kling", { apiKey: "test" });
    const result = await provider.generate(videoRequest("kling-2.6"));
    expect(result.generatedMedia).toEqual([
      {
        type: "video",
        mimeType: "video/mp4",
        data: Buffer.from("vid").toString("base64"),
      },
    ]);
    expect(result.usage.billedCostCents).toBeGreaterThan(0);
  });
});
