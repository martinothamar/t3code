import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientResponse, HttpRouter } from "effect/http";

import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";
import * as AgentctlSandboxRelay from "./AgentctlSandboxRelay.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (options: { readonly reachable?: boolean; readonly fail?: boolean } = {}) => {
  const requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  const unreachable: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push({ url: request.url, headers: request.headers });
      if (options.fail) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
        });
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
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, unreachable };
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
