# Mini Agent

A small [agentctl](https://github.com/digdir/digdir-agents) Agent for running
[Pi](https://pi.dev) from T3 Code on the aivar gateway: Ubuntu with Node 24, `gh`, Git and Pi,
configured for `sigma2:Qwen3.8-27B`. It has no desktop and clones nothing; repositories go under
`/home/agent/code`.

```sh
cp agents/mini/.env.sample agents/mini/.env   # fill in AIVAR_API_KEY and Git identity
agentctl apply -f agents/mini/agent.yaml --wait
```

The Sandbox then shows up in the T3 Code desktop app, with Pi enabled and the aivar model selected
for threads and generated titles and commit messages. The API key stays on the host: the Sandbox
sees a placeholder that the network mediator swaps for the key on requests to `api.aivar.no`.

[`home/.pi/agent/models.json`](./home/.pi/agent/models.json) defines the gateway's models. Add a
model there to use it from Pi; `contextWindow`, `maxTokens` and `compat` must match what the
gateway serves. agentctl requires a harness, so the manifest declares Claude Code as an optional
one for agentctl Sessions. It is skipped when agentctl has no Claude login.
