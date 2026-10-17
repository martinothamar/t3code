import { describe, expect, it } from "@effect/vitest";

import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { speechStreamUrl } from "./environment.ts";

const ticketUrlFor = (httpBaseUrl: string) =>
  makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).auth.webSocketTicketFor({
    params: { use: "media" },
  });

describe("speechStreamUrl", () => {
  it.each([
    ["at the origin's root", "https://host.test:3773", "wss://host.test:3773/ws/voice"],
    [
      "below a host's path, as a Sandbox is",
      "https://host.test/sandbox/worker/",
      "wss://host.test/sandbox/worker/ws/voice",
    ],
    ["over plain http", "http://127.0.0.1:3773/", "ws://127.0.0.1:3773/ws/voice"],
  ])("streams from the server that issued the ticket, %s", (_name, httpBaseUrl, expected) => {
    expect(speechStreamUrl(ticketUrlFor(httpBaseUrl)).toString()).toBe(expected);
  });
});
