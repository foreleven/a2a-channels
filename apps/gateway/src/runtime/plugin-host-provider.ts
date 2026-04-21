import {
  OpenClawPluginHost,
  type OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

export class PluginHostProvider {
  create(runtime: OpenClawPluginRuntime): OpenClawPluginHost {
    return new OpenClawPluginHost(runtime);
  }
}
