import type { PluginRuntime } from "openclaw/plugin-sdk";

type PluginRuntimeImageGeneration = PluginRuntime["imageGeneration"];
type PluginRuntimeVideoGeneration = PluginRuntime["videoGeneration"];

type ImageGenResult = Awaited<
  ReturnType<PluginRuntimeImageGeneration["generate"]>
>;
type VideoGenResult = Awaited<
  ReturnType<PluginRuntimeVideoGeneration["generate"]>
>;

/**
 * Build the `imageGeneration` surface of a `PluginRuntime`.
 * All methods are stubs — the gateway does not generate images.
 */
export function buildImageGenerationCompat(): PluginRuntimeImageGeneration {
  return {
    generate: async () =>
      ({
        images: [],
        provider: "",
        model: "",
        attempts: [],
        ignoredOverrides: [],
      }) as ImageGenResult,
    listProviders: () => [],
  };
}

/**
 * Build the `videoGeneration` surface of a `PluginRuntime`.
 * All methods are stubs — the gateway does not generate videos.
 */
export function buildVideoGenerationCompat(): PluginRuntimeVideoGeneration {
  return {
    generate: async () =>
      ({
        videos: [],
        provider: "",
        model: "",
        attempts: [],
        ignoredOverrides: [],
      }) as VideoGenResult,
    listProviders: () => [],
  };
}
