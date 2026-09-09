import { z } from "zod"

// Keep model-specific options extensible: the explicitly selected upstream
// validates capability/size combinations, not Raven's chat model catalog.
const imageRequest = z
  .object({
    model: z
      .string()
      .max(256)
      .refine((value) => value.trim().length > 0),
    prompt: z
      .string()
      .max(32_000)
      .refine((value) => value.trim().length > 0),
    stream: z.literal(false).nullish(),
    n: z.number().int().min(1).max(10).nullish(),
    size: z.string().min(1).nullish(),
    quality: z.string().min(1).nullish(),
    background: z.string().min(1).nullish(),
    output_format: z.string().min(1).nullish(),
    output_compression: z.number().int().min(0).max(100).nullish(),
    moderation: z.string().min(1).nullish(),
    response_format: z.string().min(1).nullish(),
    style: z.string().min(1).nullish(),
    user: z.string().optional(),
    partial_images: z.number().int().min(0).max(3).nullish(),
  })
  .passthrough()

export type ImageGenerationRequest = z.infer<typeof imageRequest>

export function parseImageRequest(
  value: unknown,
): ImageGenerationRequest | null {
  const result = imageRequest.safeParse(value)
  return result.success ? result.data : null
}
