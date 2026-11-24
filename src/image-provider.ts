import {
  createLLMProvider,
  getModelPricing,
} from "@sudobility/shapeshyft_engine";

type Provider = ReturnType<typeof createLLMProvider>;
type Request = Parameters<Provider["generate"]>[0];
type Response = Awaited<ReturnType<Provider["generate"]>>;
type Config = Parameters<typeof createLLMProvider>[1];
type LlmProvider = Response["provider"];
type GeneratedImage = { type: "image"; mimeType: string; data: string };

/**
 * Add image output for providers whose image path is not in the shared engine.
 * Gemini (`generateContent` with `responseModalities`) and OpenAI (the Images
 * API) are full LLM providers whose image path is layered on here; the
 * dedicated image-generation vendors (ByteDance Seedream, Black Forest Labs
 * FLUX, Ideogram, Recraft, Stability) have no text path at all -- the engine
 * returns an image-only stub and this wrapper makes their real API calls.
 *
 * Routing happens only when `expectsMediaOutput.image` is set; every other call
 * passes through to the base provider unchanged. Dedicated image providers have
 * no non-image path, so their stub throws for non-image requests.
 */
export const createImageProvider: typeof createLLMProvider = (
  providerType,
  config
) => {
  const base = createLLMProvider(providerType, config);
  switch (providerType) {
    case "gemini":
      return wrapImageGenerate(base, r => generateGeminiImage(r, config));
    case "openai":
      return wrapImageGenerate(base, r => generateOpenAIImage(r, config));
    case "bytedance":
      return wrapImageGenerate(base, r => generateSeedreamImage(r, config));
    case "bfl":
      return wrapImageGenerate(base, r => generateFluxImage(r, config));
    case "ideogram":
      return wrapImageGenerate(base, r => generateIdeogramImage(r, config));
    case "recraft":
      return wrapImageGenerate(base, r => generateRecraftImage(r, config));
    case "stability":
      return wrapImageGenerate(base, r => generateStabilityImage(r, config));
    default:
      return base;
  }
};

/**
 * Usage for a per-image provider that bills per generated image rather than by
 * token. `billedCostCents` is the authoritative cost (see `estimateUsageCost`),
 * computed from the catalog's per-image price so these providers are not billed
 * as free. Token counts are zero: these APIs report none.
 */
function perImageUsage(
  provider: LlmProvider,
  model: string,
  imageCount: number
): Response["usage"] {
  const perImageCents = getModelPricing(model, { provider }).imageOutput ?? 0;
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    billedCostCents: perImageCents * imageCount,
  };
}

/** Build the prompt string the image APIs take from system + user prompt. */
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
 * Download a generated image and return it as base64 with its MIME type. Used
 * by providers that return a (often short-lived, non-CORS) result URL rather
 * than inline bytes -- the image must be fetched server-side and re-hosted.
 */
async function fetchImageAsBase64(url: string): Promise<GeneratedImage> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Failed to download generated image: ${res.status}`);
  const mimeType =
    res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  return { type: "image", mimeType, data };
}

/** Assemble an LLMResponse from generated image bytes. */
function imageResponse(
  provider: LlmProvider,
  model: string,
  startedMs: number,
  media: GeneratedImage[]
): Response {
  return {
    content: { imageGenerated: true },
    rawResponse: "[generated image]",
    usage: perImageUsage(provider, model, media.length),
    model,
    provider,
    latencyMs: Date.now() - startedMs,
    generatedMedia: media,
  };
}

/**
 * Wrap a provider so that image-output requests are handled by `generateImage`
 * and everything else falls through to the base provider.
 */
function wrapImageGenerate(
  base: Provider,
  generateImage: (request: Request) => Promise<Response>
): Provider {
  return new Proxy(base, {
    get(target, property) {
      if (property === "generate")
        return (request: Request) =>
          request.expectsMediaOutput?.image
            ? generateImage(request)
            : target.generate(request);
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
