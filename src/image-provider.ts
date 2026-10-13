import { createLLMProvider } from "@sudobility/shapeshyft_engine";

type Provider = ReturnType<typeof createLLMProvider>;
type Request = Parameters<Provider["generate"]>[0];

/** Add Gemini image output until the shared engine's image path is released. */
export const createImageProvider: typeof createLLMProvider = (
  providerType,
  config
) => {
  const base = createLLMProvider(providerType, config);
  if (providerType !== "gemini") return base;

  const generateImage = async (request: Request) => {
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
  };

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
};
