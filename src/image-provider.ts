import { createLLMProvider } from "@sudobility/shapeshyft_engine";

type Provider = ReturnType<typeof createLLMProvider>;
type Request = Parameters<Provider["generate"]>[0];
type Response = Awaited<ReturnType<Provider["generate"]>>;
type Config = Parameters<typeof createLLMProvider>[1];

/**
 * Add image output for providers whose image path is not yet in the shared
 * engine: Gemini (`generateContent` with `responseModalities`) and OpenAI (the
 * Images API). Both are routed only when `expectsMediaOutput.image` is set;
 * every other call passes through to the base provider unchanged.
 */
export const createImageProvider: typeof createLLMProvider = (
  providerType,
  config
) => {
  const base = createLLMProvider(providerType, config);
  if (providerType === "gemini")
    return wrapImageGenerate(base, request =>
      generateGeminiImage(request, config)
    );
  if (providerType === "openai")
    return wrapImageGenerate(base, request =>
      generateOpenAIImage(request, config)
    );
  return base;
};

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
