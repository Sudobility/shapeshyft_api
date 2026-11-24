import {
  createLLMProvider,
  getModelPricing,
} from "@sudobility/shapeshyft_engine";

type Provider = ReturnType<typeof createLLMProvider>;
type Request = Parameters<Provider["generate"]>[0];
type Response = Awaited<ReturnType<Provider["generate"]>>;
type Config = Parameters<typeof createLLMProvider>[1];
type LlmProvider = Response["provider"];
type MediaKind = "image" | "audio" | "video";
type GeneratedImage = { type: MediaKind; mimeType: string; data: string };

/**
 * Add media output (image, audio, video) for providers whose generation path is
 * not in the shared engine. Gemini, OpenAI and xAI are full LLM providers whose
 * media path is layered on here; the dedicated media vendors (ByteDance
 * Seedream, Black Forest Labs FLUX, Ideogram, Recraft, Stability, fal.ai,
 * Leonardo, Luma, Alibaba Qwen-Image, Runway for image; ElevenLabs for audio;
 * Kling, MiniMax, Pika for video) have no text path -- the engine returns a
 * media-only stub and this wrapper makes their real API calls.
 *
 * Routing happens only when `expectsMediaOutput.{image,audio,video}` is set;
 * every other call passes through to the base provider unchanged. Dedicated
 * media providers have no non-media path, so their stub throws otherwise.
 */
export const createImageProvider: typeof createLLMProvider = (
  providerType,
  config
) => {
  const base = createLLMProvider(providerType, config);
  switch (providerType) {
    // Image
    case "gemini":
      return wrapMediaGenerate(base, r => generateGeminiImage(r, config));
    case "openai":
      return wrapMediaGenerate(base, r => generateOpenAIImage(r, config));
    case "xai":
      return wrapMediaGenerate(base, r => generateXaiImage(r, config));
    case "bytedance":
      return wrapMediaGenerate(base, r => generateSeedreamImage(r, config));
    case "bfl":
      return wrapMediaGenerate(base, r => generateFluxImage(r, config));
    case "ideogram":
      return wrapMediaGenerate(base, r => generateIdeogramImage(r, config));
    case "recraft":
      return wrapMediaGenerate(base, r => generateRecraftImage(r, config));
    case "stability":
      return wrapMediaGenerate(base, r => generateStabilityImage(r, config));
    case "fal":
      return wrapMediaGenerate(base, r => generateFalMedia(r, config));
    case "leonardo":
      return wrapMediaGenerate(base, r => generateLeonardoImage(r, config));
    case "luma":
      return wrapMediaGenerate(base, r => generateLumaImage(r, config));
    case "alibaba":
      return wrapMediaGenerate(base, r => generateQwenImage(r, config));
    case "runway":
      return wrapMediaGenerate(base, r => generateRunwayImage(r, config));
    // Audio
    case "elevenlabs":
      return wrapMediaGenerate(base, r => generateElevenLabsAudio(r, config));
    // Video
    case "kling":
      return wrapMediaGenerate(base, r => generateKlingVideo(r, config));
    case "minimax":
      return wrapMediaGenerate(base, r => generateMinimaxVideo(r, config));
    case "pika":
      return wrapMediaGenerate(base, r => generatePikaVideo(r, config));
    default:
      return base;
  }
};

/**
 * Media-generation usage. `billedCostCents` is the authoritative cost (see
 * `estimateUsageCost`): these APIs report no tokens and bill per image, per
 * second of video, or per character of audio, so the adapter computes the cost
 * and sets it here, or the provider returns it in the response.
 */
function mediaUsage(billedCostCents: number): Response["usage"] {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    billedCostCents,
  };
}

/** Catalog per-image price in cents for a model, 0 if unknown. */
function perImageCents(provider: LlmProvider, model: string): number {
  return getModelPricing(model, { provider }).imageOutput ?? 0;
}

/** Build the prompt string the media APIs take from system + user prompt. */
function imagePrompt(request: Request): string {
  return [request.systemPrompt, request.prompt].filter(Boolean).join("\n\n");
}

/** Reference images, validated as base64 (every image API here wants base64). */
function base64References(request: Request): NonNullable<Request["media"]> {
  const references = request.media ?? [];
  for (const media of references) {
    if (media.type !== "image" || media.format !== "base64")
      throw new Error("Image references must be base64 images");
  }
  return references;
}

/**
 * Download generated media and return it as base64 with its MIME type. Used by
 * providers that return a (often short-lived, non-CORS) result URL rather than
 * inline bytes -- the asset must be fetched server-side and re-hosted.
 */
async function fetchMediaAsBase64(
  url: string,
  kind: MediaKind,
  fallbackMime: string,
  init?: RequestInit
): Promise<GeneratedImage> {
  const res = await fetch(url, init);
  if (!res.ok)
    throw new Error(`Failed to download generated ${kind}: ${res.status}`);
  const mimeType =
    res.headers.get("content-type")?.split(";")[0]?.trim() || fallbackMime;
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  return { type: kind, mimeType, data };
}

/** Download a generated image URL to base64 (the common image case). */
function fetchImageAsBase64(url: string): Promise<GeneratedImage> {
  return fetchMediaAsBase64(url, "image", "image/png");
}

/**
 * Assemble an LLMResponse from generated media. `billedCostCents` defaults to
 * the catalog per-image price times the number of images; audio/video and
 * response-priced providers pass an explicit amount.
 */
function mediaResponse(
  provider: LlmProvider,
  model: string,
  startedMs: number,
  media: GeneratedImage[],
  billedCostCents: number
): Response {
  return {
    content: { mediaGenerated: true },
    rawResponse: "[generated media]",
    usage: mediaUsage(billedCostCents),
    model,
    provider,
    latencyMs: Date.now() - startedMs,
    generatedMedia: media,
  };
}

/** Assemble an LLMResponse for a per-image provider priced from the catalog. */
function imageResponse(
  provider: LlmProvider,
  model: string,
  startedMs: number,
  media: GeneratedImage[]
): Response {
  return mediaResponse(
    provider,
    model,
    startedMs,
    media,
    perImageCents(provider, model) * media.length
  );
}

/**
 * Wrap a provider so that media-output requests (image, audio or video) are
 * handled by `generateMedia` and everything else falls through to the base
 * provider.
 */
function wrapMediaGenerate(
  base: Provider,
  generateMedia: (request: Request) => Promise<Response>
): Provider {
  return new Proxy(base, {
    get(target, property) {
      if (property === "generate")
        return (request: Request) => {
          const out = request.expectsMediaOutput;
          return out?.image || out?.audio || out?.video
            ? generateMedia(request)
            : target.generate(request);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Gemini image output via `generateContent` with `responseModalities`. */
async function generateGeminiImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Gemini API key is required");
  const model = request.model ?? config.model ?? "";
  if (!model.includes("image"))
    throw new Error(`${model} is not an image generation model`);
  const parts: Array<Record<string, unknown>> = [];
  for (const media of request.media ?? []) {
    if (media.type !== "image" || media.format !== "base64")
      throw new Error("Image references must be base64 images");
    parts.push({
      inlineData: { mimeType: media.mimeType, data: media.data },
    });
  }
  parts.push({
    text: [request.systemPrompt, request.prompt].filter(Boolean).join("\n\n"),
  });
  const started = Date.now();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    }
  );
  const payload = (await response.json()) as {
    error?: { message?: string };
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  if (!response.ok)
    throw new Error(
      `Gemini image generation failed: ${payload.error?.message ?? response.status}`
    );
  const generatedMedia =
    payload.candidates?.[0]?.content?.parts?.flatMap(part =>
      part.inlineData?.data
        ? [
            {
              type: "image" as const,
              mimeType: part.inlineData.mimeType ?? "image/png",
              data: part.inlineData.data,
            },
          ]
        : []
    ) ?? [];
  if (!generatedMedia.length)
    throw new Error("Gemini returned no generated image");
  const promptTokens = payload.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = payload.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    content: { imageGenerated: true },
    rawResponse: "[generated image]",
    usage: {
      promptTokens,
      completionTokens,
      totalTokens:
        payload.usageMetadata?.totalTokenCount ??
        promptTokens + completionTokens,
    },
    model,
    provider: "gemini" as const,
    latencyMs: Date.now() - started,
    generatedMedia,
  };
}

/** Shape of an OpenAI Images API response (generations and edits share it). */
interface OpenAIImageResponse {
  error?: { message?: string };
  data?: Array<{ b64_json?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * OpenAI image output via the Images API. With base64 reference images it uses
 * `images/edits` (multipart); without, `images/generations` (JSON). Output is
 * forced to PNG so downstream PNG validation (e.g. characterbuilder_api) holds.
 */
async function generateOpenAIImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("OpenAI API key is required");
  const model = request.model ?? config.model ?? "";
  const prompt = [request.systemPrompt, request.prompt]
    .filter(Boolean)
    .join("\n\n");
  const references = request.media ?? [];
  for (const media of references) {
    if (media.type !== "image" || media.format !== "base64")
      throw new Error("Image references must be base64 images");
  }

  const started = Date.now();
  let response: globalThis.Response;
  if (references.length) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("output_format", "png");
    references.forEach((media, index) => {
      const bytes = Buffer.from(media.data, "base64");
      form.append(
        "image[]",
        new Blob([bytes], { type: media.mimeType }),
        `reference-${index}.png`
      );
    });
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
    });
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: "1024x1024",
        output_format: "png",
      }),
    });
  }

  const payload = (await response.json()) as OpenAIImageResponse;
  if (!response.ok)
    throw new Error(
      `OpenAI image generation failed: ${payload.error?.message ?? response.status}`
    );
  const data = payload.data?.[0]?.b64_json;
  if (!data) throw new Error("OpenAI returned no generated image");
  const promptTokens = payload.usage?.input_tokens ?? 0;
  const completionTokens = payload.usage?.output_tokens ?? 0;
  return {
    content: { imageGenerated: true },
    rawResponse: "[generated image]",
    usage: {
      promptTokens,
      completionTokens,
      totalTokens:
        payload.usage?.total_tokens ?? promptTokens + completionTokens,
    },
    model,
    provider: "openai" as const,
    latencyMs: Date.now() - started,
    generatedMedia: [{ type: "image" as const, mimeType: "image/png", data }],
  };
}

/**
 * ByteDance Seedream via the (synchronous) BytePlus ModelArk Images API. One
 * POST returns the image(s) directly. Reference images (image-to-image / edit)
 * go in the `image` field as base64 data URIs. Output is requested as base64
 * (`response_format: "b64_json"`) so nothing has to be re-fetched.
 * @see https://docs.byteplus.com/docs/en/modelark/image-generation-api
 */
async function generateSeedreamImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey)
    throw new Error("ByteDance (Seedream) API key is required");
  const model = request.model ?? config.model ?? "";
  const references = base64References(request);
  const body: Record<string, unknown> = {
    model,
    prompt: imagePrompt(request),
    response_format: "b64_json",
    watermark: false,
  };
  if (references.length)
    body.image = references.map(m => `data:${m.mimeType};base64,${m.data}`);

  const started = Date.now();
  const endpoint =
    config.endpointUrl ??
    "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    data?: Array<{
      b64_json?: string;
      url?: string;
      error?: { message?: string };
    }>;
  };
  if (!response.ok)
    throw new Error(
      `Seedream image generation failed: ${payload.error?.message ?? response.status}`
    );
  const media: GeneratedImage[] = [];
  for (const item of payload.data ?? []) {
    if (item.b64_json)
      media.push({ type: "image", mimeType: "image/png", data: item.b64_json });
    else if (item.url) media.push(await fetchImageAsBase64(item.url));
  }
  if (!media.length) throw new Error("Seedream returned no generated image");
  return imageResponse("bytedance", model, started, media);
}

/**
 * Black Forest Labs FLUX. Generation is asynchronous: a POST to the model's
 * submit endpoint returns a `polling_url`, which is polled (header `x-key`,
 * NOT Bearer) until `status === "Ready"`, when the image URL appears at
 * `result.sample`. That URL is signed, expires in ~10 minutes and is not
 * CORS-enabled, so it is fetched server-side and returned as base64.
 * @see https://docs.bfl.ai/api-reference
 */
async function generateFluxImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey)
    throw new Error("Black Forest Labs (FLUX) API key is required");
  const model = request.model ?? config.model ?? "";
  const references = base64References(request);
  const body: Record<string, unknown> = { prompt: imagePrompt(request) };
  if (references.length) {
    // Editing models take a source image in `input_image`; the others accept a
    // guidance image in `image_prompt`. Both are raw base64.
    const first = references[0]!.data;
    if (/kontext|flux-2|flux-3/.test(model)) body.input_image = first;
    else body.image_prompt = first;
  }

  const started = Date.now();
  const submit = await fetch(
    `https://api.bfl.ai/v1/${encodeURIComponent(model)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-key": config.apiKey },
      body: JSON.stringify(body),
    }
  );
  const submitPayload = (await submit.json()) as {
    id?: string;
    polling_url?: string;
    error?: string;
    detail?: unknown;
  };
  if (!submit.ok || !submitPayload.polling_url)
    throw new Error(
      `FLUX image request failed: ${submitPayload.error ?? JSON.stringify(submitPayload.detail) ?? submit.status}`
    );

  // Poll the signed polling_url. ~1s between polls, up to ~2 minutes.
  const pollUrl = submitPayload.polling_url;
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const poll = await fetch(pollUrl, { headers: { "x-key": config.apiKey } });
    const pollPayload = (await poll.json()) as {
      status?: string;
      result?: { sample?: string } | null;
    };
    if (!poll.ok) throw new Error(`FLUX polling failed: ${poll.status}`);
    const status = pollPayload.status;
    if (status === "Ready") {
      const sample = pollPayload.result?.sample;
      if (!sample) throw new Error("FLUX reported Ready but returned no image");
      return imageResponse("bfl", model, started, [
        await fetchImageAsBase64(sample),
      ]);
    }
    // Terminal non-success states: Error, Failed, *Moderated, No Card Generated,
    // Task not found. In-progress: Pending, Reasoning, Generating.
    if (status && !["Pending", "Reasoning", "Generating"].includes(status))
      throw new Error(`FLUX image generation did not succeed: ${status}`);
  }
  throw new Error("FLUX image generation timed out");
}

/**
 * Ideogram 3.0 via the v2 generate endpoint (synchronous). The request is
 * multipart/form-data with header `Api-Key`. `rendering_speed` is derived from
 * the model id suffix (`-turbo`/`-quality`). The response carries a temporary
 * image URL at `data[].url`, which is fetched server-side and returned base64.
 * @see https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-3
 */
async function generateIdeogramImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Ideogram API key is required");
  const model = request.model ?? config.model ?? "";
  const renderingSpeed = model.endsWith("-turbo")
    ? "TURBO"
    : model.endsWith("-quality")
      ? "QUALITY"
      : "DEFAULT";
  const references = base64References(request);

  const form = new FormData();
  form.append("prompt", imagePrompt(request));
  form.append("rendering_speed", renderingSpeed);
  references.forEach((media, index) => {
    const bytes = Buffer.from(media.data, "base64");
    form.append(
      "style_reference_images",
      new Blob([bytes], { type: media.mimeType }),
      `reference-${index}.png`
    );
  });

  const started = Date.now();
  const response = await fetch(
    "https://api.ideogram.ai/v2/image/generate/ideogram-3",
    { method: "POST", headers: { "Api-Key": config.apiKey }, body: form }
  );
  const payload = (await response.json()) as {
    error?: string;
    data?: Array<{ url?: string }>;
  };
  if (!response.ok)
    throw new Error(
      `Ideogram image generation failed: ${payload.error ?? response.status}`
    );
  const media: GeneratedImage[] = [];
  for (const item of payload.data ?? [])
    if (item.url) media.push(await fetchImageAsBase64(item.url));
  if (!media.length) throw new Error("Ideogram returned no generated image");
  return imageResponse("ideogram", model, started, media);
}

/**
 * Recraft V3 via its OpenAI-style Images API (synchronous, JSON). The `model`
 * id is passed through; base64 output is requested so nothing is re-fetched.
 * Text-to-image only here -- style references require Recraft's separate style
 * endpoints.
 * @see https://www.recraft.ai/docs/api-reference/models/recraft-v3
 */
async function generateRecraftImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Recraft API key is required");
  const model = request.model ?? config.model ?? "";
  const started = Date.now();
  const response = await fetch(
    "https://external.api.recraft.ai/v1/images/generations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        prompt: imagePrompt(request),
        model,
        response_format: "b64_json",
      }),
    }
  );
  const payload = (await response.json()) as {
    code?: string;
    message?: string;
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  if (!response.ok)
    throw new Error(
      `Recraft image generation failed: ${payload.message ?? response.status}`
    );
  const media: GeneratedImage[] = [];
  for (const item of payload.data ?? []) {
    if (item.b64_json)
      media.push({ type: "image", mimeType: "image/png", data: item.b64_json });
    else if (item.url) media.push(await fetchImageAsBase64(item.url));
  }
  if (!media.length) throw new Error("Recraft returned no generated image");
  return imageResponse("recraft", model, started, media);
}

/**
 * Stability AI via the v2beta Stable Image API (synchronous, multipart). The
 * model id selects the endpoint: `stable-image-ultra`/`-core` are their own
 * paths; the `sd3.5-*` ids hit `/sd3` with a `model` field. `Accept:
 * application/json` returns the image base64 inline.
 * @see https://docs.stability.ai/api-reference
 */
async function generateStabilityImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Stability AI API key is required");
  const model = request.model ?? config.model ?? "";
  const path = model.startsWith("sd3.5")
    ? "sd3"
    : model === "stable-image-ultra"
      ? "ultra"
      : "core";

  const form = new FormData();
  form.append("prompt", imagePrompt(request));
  form.append("output_format", "png");
  if (path === "sd3") form.append("model", model);

  const started = Date.now();
  const response = await fetch(
    `https://api.stability.ai/v2beta/stable-image/generate/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
      },
      body: form,
    }
  );
  const payload = (await response.json()) as {
    image?: string;
    finish_reason?: string;
    errors?: string[];
    message?: string;
  };
  if (!response.ok)
    throw new Error(
      `Stability image generation failed: ${payload.errors?.join(", ") ?? payload.message ?? response.status}`
    );
  if (payload.finish_reason === "CONTENT_FILTERED")
    throw new Error("Stability filtered the generated image for safety");
  if (!payload.image) throw new Error("Stability returned no generated image");
  return imageResponse("stability", model, started, [
    { type: "image", mimeType: "image/png", data: payload.image },
  ]);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * xAI Grok Imagine via the (synchronous) OpenAI-compatible Images API. Base64
 * output is requested so nothing is re-fetched. xAI controls dimensions with
 * aspect_ratio + resolution rather than a size string, and does not do
 * reference-image editing here, so references are ignored.
 * @see https://docs.x.ai/developers/model-capabilities/images/generation
 */
async function generateXaiImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("xAI API key is required");
  const model = request.model ?? config.model ?? "";
  const started = Date.now();
  const response = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt: imagePrompt(request),
      n: 1,
      response_format: "b64_json",
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    data?: Array<{ b64_json?: string; url?: string; mime_type?: string }>;
  };
  if (!response.ok)
    throw new Error(
      `xAI image generation failed: ${payload.error?.message ?? response.status}`
    );
  const media: GeneratedImage[] = [];
  for (const item of payload.data ?? []) {
    if (item.b64_json)
      media.push({
        type: "image",
        mimeType: item.mime_type ?? "image/jpeg",
        data: item.b64_json,
      });
    else if (item.url) media.push(await fetchImageAsBase64(item.url));
  }
  if (!media.length) throw new Error("xAI returned no generated image");
  return imageResponse("xai", model, started, media);
}

/**
 * fal.ai aggregator via the synchronous run endpoint with `sync_mode: true`, so
 * the image comes back inline as a data URI (no polling, no CDN re-host). The
 * model id is a full fal `owner/app[/path]` slug used verbatim in the path.
 * Text-to-image only. Billed from the catalog fallback price (fal also returns
 * a per-call price, but its field is model-specific).
 * @see https://fal.ai/docs
 */
async function generateFalMedia(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("fal.ai API key is required");
  const model = request.model ?? config.model ?? "";
  const started = Date.now();
  // Slashes in the model id are path segments -- do not encode them.
  const response = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${config.apiKey}`,
    },
    body: JSON.stringify({
      prompt: imagePrompt(request),
      num_images: 1,
      sync_mode: true,
    }),
  });
  const payload = (await response.json()) as {
    detail?: unknown;
    images?: Array<{ url?: string; content_type?: string }>;
  };
  if (!response.ok)
    throw new Error(
      `fal.ai generation failed: ${JSON.stringify(payload.detail) ?? response.status}`
    );
  const media: GeneratedImage[] = [];
  for (const image of payload.images ?? []) {
    if (!image.url) continue;
    if (image.url.startsWith("data:")) {
      // data:<mime>;base64,<data>
      const match = /^data:([^;]+);base64,(.*)$/s.exec(image.url);
      if (match)
        media.push({ type: "image", mimeType: match[1]!, data: match[2]! });
    } else {
      media.push(await fetchImageAsBase64(image.url));
    }
  }
  if (!media.length) throw new Error("fal.ai returned no generated image");
  return imageResponse("fal", model, started, media);
}

const LEONARDO_MODEL_IDS: Record<string, string> = {
  "lucid-origin": "7b592283-e8a7-4c5a-9ba6-d18c31f258b9",
  "lucid-realism": "05ce0082-2d80-4a2d-8653-4d1c85e2418e",
  "phoenix-1.0": "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3",
  "flux-dev": "b2614463-296c-462a-9586-aafdb8f00e36",
  "flux-schnell": "1dd50843-d653-4516-a8e3-f0238ee453ff",
};

/**
 * Leonardo.ai image generation (async). POST creates a job returning a
 * generationId; poll until the generation is COMPLETE, then re-host the result
 * URL. Friendly model ids map to Leonardo's model UUIDs. Text-to-image only
 * (character-consistency controlnets are a later addition).
 * @see https://docs.leonardo.ai
 */
async function generateLeonardoImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Leonardo.ai API key is required");
  const model = request.model ?? config.model ?? "";
  const modelId = LEONARDO_MODEL_IDS[model] ?? model;
  const started = Date.now();
  const create = await fetch(
    "https://cloud.leonardo.ai/api/rest/v1/generations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        prompt: imagePrompt(request),
        modelId,
        width: 1024,
        height: 1024,
        num_images: 1,
      }),
    }
  );
  const createPayload = (await create.json()) as {
    error?: string;
    sdGenerationJob?: { generationId?: string };
  };
  const generationId = createPayload.sdGenerationJob?.generationId;
  if (!create.ok || !generationId)
    throw new Error(
      `Leonardo generation request failed: ${createPayload.error ?? create.status}`
    );

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(2000);
    const poll = await fetch(
      `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
      { headers: { Authorization: `Bearer ${config.apiKey}` } }
    );
    const pollPayload = (await poll.json()) as {
      generations_by_pk?: {
        status?: string;
        generated_images?: Array<{ url?: string }>;
      };
    };
    const status = pollPayload.generations_by_pk?.status;
    if (status === "COMPLETE") {
      const media: GeneratedImage[] = [];
      for (const image of pollPayload.generations_by_pk?.generated_images ?? [])
        if (image.url) media.push(await fetchImageAsBase64(image.url));
      if (!media.length)
        throw new Error("Leonardo completed but returned no image");
      return imageResponse("leonardo", model, started, media);
    }
    if (status === "FAILED")
      throw new Error("Leonardo image generation failed");
  }
  throw new Error("Leonardo image generation timed out");
}

/**
 * Luma AI Photon image generation. Uses `sync: true` so the call returns the
 * finished generation without polling; the image URL (`assets.image`) is then
 * re-hosted to base64. Text-to-image only -- Luma accepts reference images only
 * as public URLs, not the base64 this pipeline passes.
 * @see https://docs.lumalabs.ai
 */
async function generateLumaImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Luma AI API key is required");
  const model = request.model ?? config.model ?? "photon-1";
  const started = Date.now();
  const response = await fetch(
    "https://api.lumalabs.ai/dream-machine/v1/generations/image",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        prompt: imagePrompt(request),
        model,
        sync: true,
        sync_timeout: 120,
      }),
    }
  );
  const payload = (await response.json()) as {
    state?: string;
    failure_reason?: string;
    assets?: { image?: string };
    detail?: unknown;
  };
  if (!response.ok)
    throw new Error(
      `Luma image generation failed: ${JSON.stringify(payload.detail) ?? response.status}`
    );
  if (payload.state === "failed")
    throw new Error(`Luma image generation failed: ${payload.failure_reason}`);
  if (!payload.assets?.image)
    throw new Error("Luma returned no generated image");
  return imageResponse("luma", model, started, [
    await fetchImageAsBase64(payload.assets.image),
  ]);
}

/**
 * Alibaba Qwen-Image via Model Studio's synchronous multimodal-generation
 * endpoint (international / Singapore host). The prompt goes in a single user
 * message; the result URL is re-hosted to base64.
 * @see https://help.aliyun.com/en/model-studio/qwen-image-api
 */
async function generateQwenImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey)
    throw new Error("Alibaba (Qwen-Image) API key is required");
  const model = request.model ?? config.model ?? "";
  const started = Date.now();
  const response = await fetch(
    "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: {
          messages: [
            { role: "user", content: [{ text: imagePrompt(request) }] },
          ],
        },
        parameters: { n: 1 },
      }),
    }
  );
  const payload = (await response.json()) as {
    code?: string;
    message?: string;
    output?: {
      choices?: Array<{
        message?: { content?: Array<{ image?: string }> };
      }>;
    };
  };
  if (!response.ok)
    throw new Error(
      `Qwen-Image generation failed: ${payload.message ?? payload.code ?? response.status}`
    );
  const media: GeneratedImage[] = [];
  for (const choice of payload.output?.choices ?? [])
    for (const part of choice.message?.content ?? [])
      if (part.image) media.push(await fetchImageAsBase64(part.image));
  if (!media.length) throw new Error("Qwen-Image returned no generated image");
  return imageResponse("alibaba", model, started, media);
}

/**
 * Runway Gen-4 image generation (async). Requires the dated `X-Runway-Version`
 * header. `gen4_image_turbo` requires at least one reference image. Output URLs
 * expire within 24-48h, so they are re-hosted to base64.
 * @see https://docs.dev.runwayml.com
 */
async function generateRunwayImage(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Runway API key is required");
  const model = request.model ?? config.model ?? "gen4_image";
  const references = base64References(request);
  if (model === "gen4_image_turbo" && references.length === 0)
    throw new Error("gen4_image_turbo requires at least one reference image");

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "X-Runway-Version": "2024-11-06",
  };
  const started = Date.now();
  const create = await fetch("https://api.dev.runwayml.com/v1/text_to_image", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      promptText: imagePrompt(request),
      ratio: "1024:1024",
      ...(references.length
        ? {
            referenceImages: references.slice(0, 3).map((m, i) => ({
              uri: `data:${m.mimeType};base64,${m.data}`,
              tag: `ref${i}`,
            })),
          }
        : {}),
    }),
  });
  const createPayload = (await create.json()) as {
    id?: string;
    error?: string;
  };
  if (!create.ok || !createPayload.id)
    throw new Error(
      `Runway image request failed: ${createPayload.error ?? create.status}`
    );

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(2000);
    const poll = await fetch(
      `https://api.dev.runwayml.com/v1/tasks/${createPayload.id}`,
      { headers }
    );
    const pollPayload = (await poll.json()) as {
      status?: string;
      output?: string[];
      failure?: string;
    };
    if (pollPayload.status === "SUCCEEDED") {
      const media: GeneratedImage[] = [];
      for (const url of pollPayload.output ?? [])
        media.push(await fetchImageAsBase64(url));
      if (!media.length)
        throw new Error("Runway succeeded but returned no image");
      return imageResponse("runway", model, started, media);
    }
    if (pollPayload.status === "FAILED")
      throw new Error(`Runway image generation failed: ${pollPayload.failure}`);
  }
  throw new Error("Runway image generation timed out");
}

const ELEVENLABS_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_CENTS_PER_1K: Record<string, number> = {
  eleven_flash_v2_5: 4,
};

/**
 * ElevenLabs text-to-speech (synchronous). The prompt is the text to speak; the
 * response body is raw MP3 audio. Billed per character ($0.08/1k for
 * multilingual models, $0.04/1k for flash). A default public voice is used.
 * @see https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */
async function generateElevenLabsAudio(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("ElevenLabs API key is required");
  const model = request.model ?? config.model ?? "eleven_multilingual_v2";
  const text = imagePrompt(request);
  const started = Date.now();
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": config.apiKey,
      },
      body: JSON.stringify({ text, model_id: model }),
    }
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `ElevenLabs audio generation failed: ${detail || response.status}`
    );
  }
  // Response is binary audio, not JSON.
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  if (!data) throw new Error("ElevenLabs returned no audio");
  const centsPer1k = ELEVENLABS_CENTS_PER_1K[model] ?? 8;
  const billedCostCents = (text.length / 1000) * centsPer1k;
  return mediaResponse(
    "elevenlabs",
    model,
    started,
    [{ type: "audio", mimeType: "audio/mpeg", data }],
    billedCostCents
  );
}

/** Per-second video cost in cents from the catalog's per-minute `videoOutput`. */
function videoCents(
  provider: LlmProvider,
  model: string,
  durationSeconds: number
): number {
  const perMinute = getModelPricing(model, { provider }).videoOutput ?? 0;
  return (durationSeconds / 60) * perMinute;
}

/**
 * Kuaishou Kling text-to-video (current path-based design). The model id is in
 * the URL path; auth is a plain API-key bearer. POST returns a task id; poll
 * `/tasks` until the task succeeds, then re-host the video URL to base64.
 * @see https://kling.ai/document-api
 */
async function generateKlingVideo(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Kling API key is required");
  const model = request.model ?? config.model ?? "kling-2.6";
  const duration = 5;
  const base = "https://api-singapore.klingai.com";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  const started = Date.now();
  const create = await fetch(`${base}/text-to-video/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: imagePrompt(request),
      settings: { resolution: "1080p", aspect_ratio: "16:9", duration },
    }),
  });
  const createPayload = (await create.json()) as {
    data?: { id?: string };
    message?: string;
  };
  const taskId = createPayload.data?.id;
  if (!create.ok || !taskId)
    throw new Error(
      `Kling video request failed: ${createPayload.message ?? create.status}`
    );

  for (let attempt = 0; attempt < 150; attempt++) {
    await sleep(3000);
    const poll = await fetch(
      `${base}/tasks?task_ids=${encodeURIComponent(taskId)}`,
      { headers }
    );
    const pollPayload = (await poll.json()) as {
      data?: Array<{
        status?: string;
        outputs?: Array<{ type?: string; url?: string }>;
      }>;
    };
    const task = pollPayload.data?.[0];
    if (task?.status === "succeeded") {
      const videoUrl = task.outputs?.find(o => o.type === "video")?.url;
      if (!videoUrl) throw new Error("Kling succeeded but returned no video");
      return mediaResponse(
        "kling",
        model,
        started,
        [await fetchMediaAsBase64(videoUrl, "video", "video/mp4")],
        videoCents("kling", model, duration)
      );
    }
    if (task?.status === "failed")
      throw new Error("Kling video generation failed");
  }
  throw new Error("Kling video generation timed out");
}

// MiniMax Hailuo does not publish per-second pricing first-party; this flat
// estimate (in cents) keeps the call from being billed as free. Replace once a
// first-party rate is confirmed.
const MINIMAX_ESTIMATE_CENTS = 10;

/**
 * MiniMax Hailuo text-to-video (three-step async): create -> query task ->
 * retrieve file. The file download URL is re-hosted to base64.
 * @see https://platform.minimax.io/docs/api-reference/video-generation-t2v
 */
async function generateMinimaxVideo(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("MiniMax API key is required");
  const model = request.model ?? config.model ?? "MiniMax-Hailuo-02";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  const started = Date.now();
  const create = await fetch("https://api.minimax.io/v1/video_generation", {
    method: "POST",
    headers,
    body: JSON.stringify({ model, prompt: imagePrompt(request) }),
  });
  const createPayload = (await create.json()) as {
    task_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (
    !create.ok ||
    !createPayload.task_id ||
    createPayload.base_resp?.status_code
  )
    throw new Error(
      `MiniMax video request failed: ${createPayload.base_resp?.status_msg ?? create.status}`
    );

  let fileId: string | undefined;
  for (let attempt = 0; attempt < 150; attempt++) {
    await sleep(3000);
    const poll = await fetch(
      `https://api.minimax.io/v1/query/video_generation?task_id=${encodeURIComponent(createPayload.task_id)}`,
      { headers }
    );
    const pollPayload = (await poll.json()) as {
      status?: string;
      file_id?: string;
    };
    if (pollPayload.status === "Success") {
      fileId = pollPayload.file_id;
      break;
    }
    if (pollPayload.status === "Fail")
      throw new Error("MiniMax video generation failed");
  }
  if (!fileId) throw new Error("MiniMax video generation timed out");

  const file = await fetch(
    `https://api.minimax.io/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
    { headers }
  );
  const filePayload = (await file.json()) as {
    file?: { download_url?: string };
  };
  const downloadUrl = filePayload.file?.download_url;
  if (!downloadUrl) throw new Error("MiniMax returned no video file");
  return mediaResponse(
    "minimax",
    model,
    started,
    [await fetchMediaAsBase64(downloadUrl, "video", "video/mp4")],
    MINIMAX_ESTIMATE_CENTS
  );
}

/**
 * Pika video via Pika's own multi-vendor gateway (dev.pika.art). The model id
 * is a `vendor/model/function` operation slug. Submit -> poll the job -> fetch
 * the job's content (binary). Pricing is prepaid/quoted per operation, so the
 * cost is not known here; it is left to Pika's billing (billed cost 0 locally).
 * @see https://dev.pika.art
 */
async function generatePikaVideo(
  request: Request,
  config: Config
): Promise<Response> {
  if (!config.apiKey) throw new Error("Pika API key is required");
  const model = request.model ?? config.model ?? "";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  const started = Date.now();
  const create = await fetch(`https://api.dev.pika.art/v1/media/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ promptText: imagePrompt(request) }),
  });
  const createPayload = (await create.json()) as {
    request_id?: string;
    id?: string;
    error?: string;
  };
  const requestId = createPayload.request_id ?? createPayload.id;
  if (!create.ok || !requestId)
    throw new Error(
      `Pika video request failed: ${createPayload.error ?? create.status}`
    );

  for (let attempt = 0; attempt < 150; attempt++) {
    await sleep(3000);
    const poll = await fetch(
      `https://api.dev.pika.art/v1/media/jobs/${requestId}`,
      { headers }
    );
    const pollPayload = (await poll.json()) as { status?: string };
    const status = pollPayload.status?.toLowerCase();
    if (status === "completed" || status === "succeeded" || status === "done") {
      return mediaResponse(
        "pika",
        model,
        started,
        [
          await fetchMediaAsBase64(
            `https://api.dev.pika.art/v1/media/jobs/${requestId}/content`,
            "video",
            "video/mp4",
            { headers }
          ),
        ],
        0
      );
    }
    if (status === "failed" || status === "error")
      throw new Error("Pika video generation failed");
  }
  throw new Error("Pika video generation timed out");
}
