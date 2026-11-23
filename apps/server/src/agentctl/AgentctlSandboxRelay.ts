// Serves each Sandbox's T3 server below `/sandbox/<name>/` on this server's origin, so every
// client reaches it however it reaches this server. The Sandbox's server authenticates each
// request itself, so credentials pass through untouched.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../assets/AttachmentUpload.ts";
import { WEBHOOK_ROUTE_PREFIX } from "../scheduledTasks/ScheduledTaskService.ts";
import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";

const SANDBOX_RELAY_PREFIX = "/sandbox/";

// This server's own cookies and forwarding hints mean nothing to the Sandbox's server, and
// hop-by-hop headers describe only the client's connection, which fetch refuses to forward.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-connection",
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

// The policy the Sandbox's own server gives agent HTML: scripts run, but in an opaque origin.
const RELAYED_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-downloads";

// The client decodes a compressed body, so its length no longer holds.
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  // It clears the browser's data for the origin that serves it, which is this server's.
  "clear-site-data",
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
  const nominated = new Set(
    (request.headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()),
  );
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || nominated.has(name) || value === undefined) continue;
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
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request)),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  // The client follows redirects itself, so none leads this server elsewhere. The incoming
  // request's span covers the relay, and only it redacts a signed URL's token.
  const response = yield* httpClient.execute(upstreamRequest).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  // Streamed responses, such as an event stream, must not wait in this server's compression.
  headers["cache-control"] = `${headers["cache-control"] ?? "no-store"}, no-transform`;
  // The Sandbox is less trusted than this server, so nothing it serves runs as this origin. Agent
  // HTML keeps its scripts in an opaque origin, as on its own server, and its own policy stays.
  headers["x-content-type-options"] = "nosniff";
  if (headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf") {
    const own = headers["content-security-policy"];
    headers["content-security-policy"] =
      own === undefined
        ? RELAYED_CONTENT_SECURITY_POLICY
        : `${own}, ${RELAYED_CONTENT_SECURITY_POLICY}`;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

function failureReason(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "unknown";
  const reason =
    "reason" in error && typeof error.reason === "object" && error.reason !== null
      ? error.reason
      : null;
  const reasonTag =
    reason !== null && "_tag" in reason && typeof reason._tag === "string" ? reason._tag : null;
  return reasonTag === null ? tag : `${tag}: ${reasonTag}`;
}

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
  // Only the path and query come from the client, so no path can name another origin.
  const upstreamUrl = new URL(upstream.value);
  upstreamUrl.pathname = target.path;
  upstreamUrl.search = url.value.search;
  const unreachable = (error: unknown) =>
    sandboxes.reportUnreachable(target.name).pipe(
      Effect.andThen(
        // The error names the upstream URL, which can be a signed one.
        Effect.logWarning("Could not reach a Sandbox's T3 server.", {
          sandbox: target.name,
          reason: failureReason(error),
        }),
      ),
      Effect.as(HttpServerResponse.text(`${target.name} is not reachable`, { status: 502 })),
    );
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    return yield* relayWebSocket(request, upstreamUrl.toString().replace(/^http/, "ws")).pipe(
      Effect.catch(unreachable),
    );
  }
  return yield* relayHttp(request, upstreamUrl.toString()).pipe(Effect.catch(unreachable));
});

// A Sandbox's signed URLs carry their bearer token in the path, as they do on its own server, so
// this host's spans and request logs redact everything past their prefix.
const signedUrlRoutes = [
  ASSET_ROUTE_PREFIX,
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  WEBHOOK_ROUTE_PREFIX,
].map((prefix) =>
  HttpRouter.add("*", `${SANDBOX_RELAY_PREFIX}:name${prefix}/*`, handler, {
    redactedParams: ["*"],
  }),
);

export const layer = Layer.mergeAll(
  HttpRouter.add("*", `${SANDBOX_RELAY_PREFIX}*`, handler),
  ...signedUrlRoutes,
);
