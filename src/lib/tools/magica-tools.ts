import { defineTool } from "@/contracts/tools";
import {
  CropImageInputSchema,
  CropImageOutputSchema,
  MergeVideosInputSchema,
  MergeVideosOutputSchema,
  GenerateImageInputSchema,
  GenerateImageOutputSchema,
  EditImageInputSchema,
  EditImageOutputSchema,
} from "@/contracts/tools";
import { runNodeAndWait, MagicaError } from "@/lib/magica/client";
import { toolRegistry } from "./registry";

// Costs are in our own credit units (SIGNUP_GRANT_CREDITS = 100), not
// Magica's microcredits — these are flat per-call charges, roughly ordered
// by Magica's own relative pricing tier for each node (crop_image and
// merge_videos are cheap utility nodes; gpt_image_2 is a real paid model).
const CROP_IMAGE_COST = 1;
const MERGE_VIDEOS_COST = 3;
const GPT_IMAGE_2_COST = 5;

// Every tool here spends real credits, so every one of them is gated on a
// human approval (see requestApproval). The skills tools are free and stay
// ungated. One "Approve all" answer covers the rest of that turn, so a
// multi-step job asks once rather than once per call.

export const cropImageTool = defineTool({
  name: "crop_image",
  description: "Crop an image to a rectangular region, specified as percentages of the source image's dimensions.",
  inputSchema: CropImageInputSchema,
  outputSchema: CropImageOutputSchema,
  cost: CROP_IMAGE_COST,
  requiresApproval: true,
  execute: async (input) => {
    const output = (await runNodeAndWait("crop_image", {
      input: {
        image_url: input.imageUrl,
        x_percent: input.xPercent,
        y_percent: input.yPercent,
        width_percent: input.widthPercent,
        height_percent: input.heightPercent,
      },
    })) as { image_url?: string };

    const imageUrl = output.image_url;
    if (!imageUrl) throw new MagicaError("crop_image run completed without an output image");
    return { imageUrl };
  },
});

export const mergeVideosTool = defineTool({
  name: "merge_videos",
  description: "Concatenate multiple videos into one, in the given order, with an optional transition between clips.",
  inputSchema: MergeVideosInputSchema,
  outputSchema: MergeVideosOutputSchema,
  cost: MERGE_VIDEOS_COST,
  requiresApproval: true,
  execute: async (input) => {
    const output = (await runNodeAndWait("merge_videos", {
      input: {
        video_urls: input.videoUrls,
        transition: input.transition,
      },
    })) as { video_url?: string };

    const videoUrl = output.video_url;
    if (!videoUrl) throw new MagicaError("merge_videos run completed without an output video");
    return { videoUrl };
  },
});

// Confirmed live against the real API (not in the static docs for this
// model): gpt_image_2 proxies through an external provider ("fal"), and its
// run output is `{ result: string[], provider, creditUsed, resultMetadata }`
// — not the `zodExpectedName` from the catalog's UI field metadata, which
// only describes the input/output form widgets, not the run response shape.
function extractImageUrls(output: unknown, nodeType: string): string[] {
  const result = (output as { result?: unknown } | null)?.result;
  if (!Array.isArray(result) || result.length === 0 || !result.every((u) => typeof u === "string")) {
    throw new MagicaError(`${nodeType} run completed with an unrecognized output shape`);
  }
  return result;
}

export const generateImageTool = defineTool({
  name: "generate_image",
  description: "Generate an image from a text prompt using GPT Image 2.",
  inputSchema: GenerateImageInputSchema,
  outputSchema: GenerateImageOutputSchema,
  cost: GPT_IMAGE_2_COST,
  requiresApproval: true,
  execute: async (input) => {
    const output = await runNodeAndWait("gpt_image_2", {
      subModelId: "gpt-image-2-text",
      input: {
        prompt: input.prompt,
        size: input.size,
        quality: input.quality,
        background: input.background,
        n: input.numberOfImages,
        output_format: input.outputFormat,
      },
    });
    return { imageUrls: extractImageUrls(output, "gpt_image_2 (text)") };
  },
});

export const editImageTool = defineTool({
  name: "edit_image",
  description: "Edit one or more existing images from a text prompt using GPT Image 2, optionally masking the region to change.",
  inputSchema: EditImageInputSchema,
  outputSchema: EditImageOutputSchema,
  cost: GPT_IMAGE_2_COST,
  requiresApproval: true,
  execute: async (input) => {
    const output = await runNodeAndWait("gpt_image_2", {
      subModelId: "gpt-image-2-edit",
      input: {
        prompt: input.prompt,
        uploadedImages: input.imageUrls,
        mask: input.maskUrl,
        size: input.size,
        quality: input.quality,
        background: input.background,
        n: input.numberOfImages,
        output_format: input.outputFormat,
      },
    });
    return { imageUrls: extractImageUrls(output, "gpt_image_2 (edit)") };
  },
});

export function registerMagicaTools(): void {
  toolRegistry.register(cropImageTool);
  toolRegistry.register(mergeVideosTool);
  toolRegistry.register(generateImageTool);
  toolRegistry.register(editImageTool);
}
