import { z } from "zod";

// The one shape every tool in the system has: a Zod input schema, a Zod
// output schema, and an execute function in between. The agent loop never
// touches chat state directly from inside a tool — it calls execute(),
// gets back a validated, typed result, and the loop itself decides what to
// persist. This is what "tools don't mutate chat state directly" means in
// practice: a tool can't reach into Prisma and write a Message row itself.
export interface ToolExecutionContext {
  runId: string;
  chatId: string;
  ownerId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  /** Credits charged per call. Omitted/0 for free tools (e.g. the skills tools). */
  cost?: number;
  /**
   * Gates the call behind a human approval waitpoint before execute() ever
   * runs — for anything a model shouldn't be able to trigger unilaterally
   * (a real charge, a destructive action). Rejected or timed-out approval
   * short-circuits to a failed tool_result; execute() is never called.
   */
  requiresApproval?: boolean;
  /** How long to wait for a decision before treating it as expired. Default 5 minutes. */
  approvalTimeoutSeconds?: number;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}

/**
 * Type-safe constructor — infers TInput/TOutput from the schemas instead of
 * making the caller spell them out. Returns `def` as-is: annotating the
 * return type as `ToolDefinition<In, Out>` here trips up on function
 * parameter contravariance (the same reason the registry itself stores
 * `ToolDefinition<any, any>` — a heterogeneous collection of differently
 * typed tools can't be variance-safe at the collection's type, only at each
 * tool's own definition site, which is what callers of defineTool get).
 */
export function defineTool<TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  cost?: number;
  requiresApproval?: boolean;
  approvalTimeoutSeconds?: number;
  execute: (input: z.infer<TInputSchema>, ctx: ToolExecutionContext) => Promise<z.infer<TOutputSchema>>;
}) {
  return def;
}

// --- load_skill -----------------------------------------------------------

export const LoadSkillInputSchema = z.object({
  name: z.string().describe("The skill's name, as listed in the available-skills summary."),
});

export const LoadSkillOutputSchema = z.object({
  name: z.string(),
  content: z.string().describe("The skill's full guidance, in markdown."),
});

// --- read_skill_asset -------------------------------------------------------

export const ReadSkillAssetInputSchema = z.object({
  skillName: z.string().describe("The skill this asset belongs to."),
  assetPath: z
    .string()
    .describe("Path to the asset, relative to that skill's assets/ folder, e.g. \"formulas.md\"."),
});

export const ReadSkillAssetOutputSchema = z.object({
  content: z.string(),
});

// --- crop_image (Magica `crop_image`) --------------------------------------

export const CropImageInputSchema = z.object({
  imageUrl: z.string().url().describe("URL of the image to crop."),
  xPercent: z.number().min(0).max(100).default(0).describe("Crop start position from the left, as a percentage of image width."),
  yPercent: z.number().min(0).max(100).default(0).describe("Crop start position from the top, as a percentage of image height."),
  widthPercent: z.number().min(0).max(100).default(100).describe("Crop width, as a percentage of image width."),
  heightPercent: z.number().min(0).max(100).default(100).describe("Crop height, as a percentage of image height."),
});

export const CropImageOutputSchema = z.object({
  imageUrl: z.string().describe("URL of the cropped image."),
});

// --- merge_videos (Magica `merge_videos`) -----------------------------------

export const MergeVideosInputSchema = z.object({
  videoUrls: z
    .array(z.string().url())
    .min(2)
    .max(100)
    .describe("URLs of the videos to concatenate, in order. Between 2 and 100."),
  transition: z.enum(["none", "fade", "dissolve"]).default("none").describe("Transition effect between clips."),
});

export const MergeVideosOutputSchema = z.object({
  videoUrl: z.string().describe("URL of the merged video."),
});

// --- generate_image / edit_image (Magica `gpt_image_2`) ---------------------

const ImageSizeSchema = z
  .enum(["Auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"])
  .default("Auto")
  .describe("Output image dimensions, or Auto to let the model choose.");

const ImageQualitySchema = z.enum(["High", "Medium", "Low"]).default("High").describe("Rendering quality; higher costs more.");

const ImageBackgroundSchema = z
  .enum(["Auto", "Opaque", "Transparent"])
  .default("Auto")
  .describe("Transparent requires outputFormat PNG or WebP.");

const ImageOutputFormatSchema = z.enum(["PNG", "JPEG", "WebP"]).default("PNG");

function refineTransparentBackground<T extends { background: string; outputFormat: string }>(data: T, ctx: z.RefinementCtx) {
  if (data.background === "Transparent" && data.outputFormat === "JPEG") {
    ctx.addIssue({
      code: "custom",
      path: ["outputFormat"],
      message: "Transparent background requires outputFormat PNG or WebP, not JPEG.",
    });
  }
}

export const GenerateImageInputSchema = z
  .object({
    prompt: z.string().min(1).max(4000).describe("Description of the image to generate."),
    size: ImageSizeSchema,
    quality: ImageQualitySchema,
    background: ImageBackgroundSchema,
    numberOfImages: z.number().int().min(1).max(4).default(1).describe("How many image variations to generate."),
    outputFormat: ImageOutputFormatSchema,
  })
  .superRefine(refineTransparentBackground);

export const GenerateImageOutputSchema = z.object({
  imageUrls: z.array(z.string()).describe("URLs of the generated images."),
});

export const EditImageInputSchema = z
  .object({
    prompt: z.string().min(1).max(4000).describe("Description of how to edit the image(s)."),
    imageUrls: z.array(z.string().url()).min(1).max(10).describe("Source images to edit, 1 to 10."),
    maskUrl: z.string().url().optional().describe("Optional mask image URL marking the region to edit."),
    size: ImageSizeSchema,
    quality: ImageQualitySchema,
    background: ImageBackgroundSchema,
    numberOfImages: z.number().int().min(1).max(4).default(1).describe("How many edited variations to generate."),
    outputFormat: ImageOutputFormatSchema,
  })
  .superRefine(refineTransparentBackground);

export const EditImageOutputSchema = z.object({
  imageUrls: z.array(z.string()).describe("URLs of the edited images."),
});
