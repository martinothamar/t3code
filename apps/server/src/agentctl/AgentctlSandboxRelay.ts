// Serves each Sandbox's T3 server below `/sandbox/<name>/` on this server's origin, so every
// client reaches it however it reaches this server. The Sandbox's server authenticates each
// request itself, so credentials pass through untouched.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";

const SANDBOX_RELAY_PREFIX = "/sandbox/";

// This server's own cookies and forwarding hints mean nothing to the Sandbox's server.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "content-length",
  "accept-encoding",
  "origin",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

/** The Sandbox and the path on its server, or null for a path outside any Sandbox. */
export function parseRelayPath(
  pathname: string,
): { readonly name: string; readonly path: string } | null {
  if (!pathname.startsWith(SANDBOX_RELAY_PREFIX)) return null;
  const rest = pathname.slice(SANDBOX_RELAY_PREFIX.length);
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  // Agent names are DNS labels.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) return null;
  return { name, path: slash === -1 ? "/" : rest.slice(slash) };
}

const forwardHeaders = (request: HttpServerRequest.HttpServerRequest) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  return headers;
};

const pumpFrames =
  /* Frame pumping runs continuously; a span per frame stream adds no diagnostic value. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const relayWebSocket = Effect.fn("AgentctlSandboxRelay.relayWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, { openTimeout: "10 seconds" }).pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructor),
  );
  const client = yield* request.upgrade;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const relayHttp = Effect.fn("AgentctlSandboxRelay.relayHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  // Streamed responses, such as an event stream, must not wait in this server's compression.
  headers["cache-control"] = `${headers["cache-control"] ?? "no-store"}, no-transform`;
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const target = parseRelayPath(url.value.pathname);
  if (target === null) return HttpServerResponse.text("Not Found", { status: 404 });
  const sandboxes = yield* AgentctlSandboxes.AgentctlSandboxes;
  const upstream = yield* sandboxes.relayUpstream(target.name);
  if (Option.isNone(upstream)) {
    return HttpServerResponse.text(`${target.name} is not reachable`, { status: 503 });
  }
  const upstreamUrl = new URL(`${target.path.slice(1)}${url.value.search}`, upstream.value);
  const unreachable = (error: unknown) =>
    sandboxes
      .reportUnreachable(target.name)
      .pipe(
        Effect.andThen(Effect.logWarning("Could not reach a Sandbox's T3 server.", { error })),
        Effect.as(HttpServerResponse.text(`${target.name} is not reachable`, { status: 502 })),
      );
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    return yield* relayWebSocket(request, upstreamUrl.toString().replace(/^http/, "ws")).pipe(
      Effect.catch(unreachable),
    );
  }
  return yield* relayHttp(request, upstreamUrl.toString()).pipe(Effect.catch(unreachable));
});

export const layer = HttpRouter.add("*", `${SANDBOX_RELAY_PREFIX}*`, handler);
