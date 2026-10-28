# agentctl Sandboxes

The server on the machine that runs agentd owns its Sandboxes, as it owns
[devices](./devices.md), so every client reaches them through its connection to that server. Each
Sandbox runs its own unmodified T3 server. The host reaches it over SSH, installing its own release
there ([tunnels](../../apps/server/src/agentctl/AgentctlSandboxTunnels.ts)), and
[relays](../../apps/server/src/agentctl/AgentctlSandboxRelay.ts) it at `/sandbox/<name>/` on its
own origin. A Sandbox therefore needs no route of its own: it is reachable however its host is,
over LAN, tailnet, Tailscale Serve or T3 Connect.

## The Sandbox authenticates, not the host

The relay passes the client's own credentials through and drops the host's cookies and forwarding
headers. Each client pairs with each Sandbox once: it asks the host for a one-time code
(`agentctl.pairSandbox`, which the host gets from the Sandbox over SSH) and redeems it with the
Sandbox's server through the relay. The host never holds a Sandbox session, and a client gets no
access to a Sandbox it could not get by asking the host.

Pairing runs in the background in [client-runtime](../../packages/client-runtime/src/sandboxes/environments.ts),
outside any UI command, where the client-side scope guard fails closed. So `agentctl.pairSandbox`
is deliberately absent from `CLIENT_GUARDED_RPC_SCOPES`, and only the server checks it.

## Routes keep their base path

A Sandbox environment's base URL has a path, so client URL helpers resolve server paths below the
base URL's directory (`environmentServerUrl`) instead of the origin's root. The Sandbox's server
stays unaware of the prefix: it emits root-absolute paths, which clients rebase. DPoP proofs name
the URL the client signed, which a prefix-stripping proxy changes, so the relay works with bearer
sessions, the only kind clients pair with a Sandbox.

## Registrations follow the host

Clients register each Sandbox they have reached as a platform bearer environment below the address
they reach its host at, so the route follows the host when its address changes, and platform
environments learn no routes from the Sandbox's own, VM-internal, addresses. A connection id per
host, Sandbox and environment id makes a recreated Sandbox pair again.

Giving a new Sandbox its project and its host's preferences still runs in the web client
([coordinator](../../apps/web/src/sandboxes/SandboxConnectionCoordinator.tsx)), so a Sandbox that
only the mobile app has connected to gets neither until it moves into client-runtime.

In development, Vite's proxy must forward `/sandbox/` with its sockets, and must not take the
`/sandboxes` page ([dev proxy](../../packages/shared/src/devProxy.ts)).
