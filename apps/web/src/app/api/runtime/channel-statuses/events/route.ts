import { GatewayServerClient } from "@/lib/gateway-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(request: Request) {
  const gateway = new GatewayServerClient();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const publish = async () => {
        try {
          send("snapshot", {
            statuses: await gateway.listRuntimeChannelStatuses(),
            generatedAt: new Date().toISOString(),
          });
        } catch (error) {
          send(
            "error-state",
            error instanceof Error ? error.message : String(error),
          );
        }
      };

      await publish();
      const timer = setInterval(() => void publish(), 5000);
      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
