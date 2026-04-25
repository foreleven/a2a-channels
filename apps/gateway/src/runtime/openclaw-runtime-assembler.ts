import { injectable } from "inversify";

import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
  type PluginRuntimeOptions,
} from "@a2a-channels/openclaw-compat";

import { registerAllPlugins } from "../register-plugins.js";

/** Pair of OpenClaw runtime objects needed by the gateway relay runtime. */
export interface OpenClawRuntimeAssembly {
  runtime: OpenClawPluginRuntime;
  pluginHost: OpenClawPluginHost;
}

/** Assembles the OpenClaw runtime and plugin host for gateway startup. */
@injectable()
export class OpenClawRuntimeAssembler {
  /** Creates a runtime, registers plugins on a host, and returns both objects. */
  assemble(options: PluginRuntimeOptions): OpenClawRuntimeAssembly {
    const runtime = this.createRuntime(options);
    const pluginHost = this.createPluginHost(runtime);
    return { runtime, pluginHost };
  }

  /** Factory hook for tests/subclasses that need to replace the runtime instance. */
  protected createRuntime(
    options: PluginRuntimeOptions,
  ): OpenClawPluginRuntime {
    return new OpenClawPluginRuntime(options);
  }

  /** Factory hook that registers all gateway-supported OpenClaw channel plugins. */
  protected createPluginHost(
    runtime: OpenClawPluginRuntime,
  ): OpenClawPluginHost {
    const host = new OpenClawPluginHost(runtime);
    registerAllPlugins(host);
    return host;
  }
}
