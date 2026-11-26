import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";

import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../assets/AttachmentUpload.ts";
import { WEBHOOK_ROUTE_PREFIX } from "../scheduledTasks/ScheduledTaskService.ts";
import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";
import * as AgentctlSandboxRelay from "./AgentctlSandboxRelay.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (
  options: {
    readonly reachable?: boolean;
    readonly fail?: boolean;
    readonly respond?: () => Response;
  } = {},
) => {
  const requests: Array<{
    url: string;
    headers: Readonly<Record<string, string>>;
    redirect: string | undefined;
  }> = [];
  const unreachable: string[] = [];
  const spans: Array<Tracer.NativeSpan> = [];
  const clientSpans: Array<Tracer.NativeSpan> = [];
  const client = HttpClient.make((request, _url, _signal, fiber) =>
    Effect.gen(function* () {
      requests.push({
        url: request.url,
        headers: request.headers,
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      });
      if (options.fail) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
        });
      }
      if (options.respond !== undefined) {
        return HttpClientResponse.fromWeb(request, options.respond());
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response('{"ok":true}', {
          headers: {
            "content-type": "application/json",
            "set-cookie": "sandbox=1",
            // As a compressed body reports it, before the client decoded it.
            "content-length": "3",
          },
        }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    AgentctlSandboxRelay.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(AgentctlSandboxes.AgentctlSandboxes, {
          relayUpstream: (name: string) =>
            Effect.succeed(
              name === "worker-1" && options.reachable !== false
                ? Option.some("http://127.0.0.1:4010/")
                : Option.none(),
            ),
          reportUnreachable: (name: string) => Effect.sync(() => void unreachable.push(name)),
        } as unknown as AgentctlSandboxes.AgentctlSandboxes["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(
        Layer.succeed(
          Tracer.Tracer,
          Tracer.make({
            span: (spanOptions) => {
              const span = new Tracer.NativeSpan(spanOptions);
              if (spanOptions.kind === "server") spans.push(span);
              else if (spanOptions.kind === "client") clientSpans.push(span);
              return span;
            },
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, unreachable, spans, clientSpans };
};

describe("parseRelayPath", () => {
  it("names the Sandbox and the path on its server", () => {
    expect(AgentctlSandboxRelay.parseRelayPath("/sandbox/worker-1/api/auth/session")).toEqual({
      name: "worker-1",
      path: "/api/auth/session",
    });
    expect(AgentctlSandboxRelay.parseRelayPath("/sandbox/worker-1")).toEqual({
      name: "worker-1",
      path: "/",
    });
  });

  it.each(["/sandbox/", "/sandbox/../api", "/sandbox/Worker/ws", "/api/sandbox/worker-1/"])(
    "refuses %s",
    (pathname) => {
      expect(AgentctlSandboxRelay.parseRelayPath(pathname)).toBeNull();
    },
  );
});

describe("Sandbox relay", () => {
  it("forwards the client's own credentials to the Sandbox's server and nothing of the host's", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request("http://host.test:3773/sandbox/worker-1/api/auth/session?x=1", {
        headers: {
          authorization: "Bearer sandbox-token",
          cookie: "t3_session=host-cookie",
          "x-forwarded-host": "host.test",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("3");
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:4010/api/auth/session?x=1",
    ]);
    expect(requests[0]?.headers.authorization).toBe("Bearer sandbox-token");
    expect(requests[0]?.headers.cookie).toBeUndefined();
    expect(requests[0]?.headers["x-forwarded-host"]).toBeUndefined();
  });

  it.each([
    [
      "/sandbox/worker-1/http://127.0.0.1:9000/private",
      "http://127.0.0.1:4010/http://127.0.0.1:9000/private",
    ],
    ["/sandbox/worker-1//evil.test/x", "http://127.0.0.1:4010//evil.test/x"],
  ])("keeps %s on the Sandbox's server", async (path, upstream) => {
    const { handler, requests } = fixture();
    await handler(new Request(`http://host.test${path}`));
    expect(requests.map((request) => request.url)).toEqual([upstream]);
  });

  it("forwards no headers about the client's own connection", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request("http://host.test/sandbox/worker-1/api/upload", {
        method: "POST",
        body: "chunk",
        headers: {
          connection: "keep-alive, x-hop",
          "transfer-encoding": "chunked",
          "x-hop": "1",
          "content-type": "text/plain",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(requests[0]?.headers["transfer-encoding"]).toBeUndefined();
    expect(requests[0]?.headers["x-hop"]).toBeUndefined();
    expect(requests[0]?.headers["content-type"]).toBe("text/plain");
  });

  it("leaves redirects to the client", async () => {
    const { handler, requests } = fixture();
    await handler(new Request("http://host.test/sandbox/worker-1/api/auth/session"));
    expect(requests[0]?.redirect).toBe("manual");
  });

  it("redacts the token of a Sandbox's signed URLs in this host's spans", async () => {
    const { handler, requests, spans, clientSpans } = fixture();
    for (const path of [
      `${ASSET_ROUTE_PREFIX}/payload.signature/image.png`,
      `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/payload.signature`,
      `${WEBHOOK_ROUTE_PREFIX}/task-1/webhook-token`,
      "/api/auth/session",
    ]) {
      await handler(new Request(`http://host.test/sandbox/worker-1${path}?v=1`));
    }
    expect(spans.map((span) => span.attributes.get("url.path"))).toEqual([
      `/sandbox/worker-1${ASSET_ROUTE_PREFIX}/REDACTED`,
      `/sandbox/worker-1${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/REDACTED`,
      `/sandbox/worker-1${WEBHOOK_ROUTE_PREFIX}/REDACTED`,
      "/sandbox/worker-1/api/auth/session",
    ]);
    // The forward to the Sandbox records no span of its own, which would carry the token.
    expect(clientSpans).toEqual([]);
    // The Sandbox's server still gets the whole URL.
    expect(requests[0]?.url).toBe(
      `http://127.0.0.1:4010${ASSET_ROUTE_PREFIX}/payload.signature/image.png?v=1`,
    );
  });

  it("serves nothing from a Sandbox that can run as this server's origin", async () => {
    const policy = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
    const served = async (contentType: string, headers: Record<string, string> = {}) => {
      const { handler } = fixture({
        respond: () =>
          new Response("<script>fetch('/api/auth/session')</script>", {
            headers: { "content-type": contentType, ...headers },
          }),
      });
      return (await handler(new Request("http://host.test/sandbox/worker-1/api/assets/x/page")))
        .headers;
    };
    // A compromised Sandbox can serve HTML without its own server's policy.
    const html = await served("text/html", { "clear-site-data": '"cookies", "storage"' });
    // It would clear this server's cookies and storage, whatever the response is.
    expect(html.get("clear-site-data")).toBeNull();
    expect(html.get("content-security-policy")).toBe(policy);
    expect(html.get("x-content-type-options")).toBe("nosniff");
    // The Sandbox's stricter policy still applies beside this one.
    expect(
      (
        await served("image/svg+xml", { "content-security-policy": "default-src 'none'; sandbox" })
      ).get("content-security-policy"),
    ).toBe(`default-src 'none'; sandbox, ${policy}`);
    // A PDF opens in the browser's viewer, which a sandbox would block.
    const pdf = await served("application/pdf");
    expect(pdf.get("content-security-policy")).toBeNull();
    expect(pdf.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 503 for a Sandbox that is not reachable", async () => {
    const { handler, requests } = fixture({ reachable: false });
    const response = await handler(new Request("http://host.test/sandbox/worker-1/ws"));
    expect(response.status).toBe(503);
    expect(requests).toEqual([]);
  });

  it("reports a forward that stopped answering, so it opens again", async () => {
    const { handler, unreachable } = fixture({ fail: true });
    const response = await handler(
      new Request("http://host.test/sandbox/worker-1/.well-known/t3/environment"),
    );
    expect(response.status).toBe(502);
    expect(unreachable).toEqual(["worker-1"]);
  });
});
