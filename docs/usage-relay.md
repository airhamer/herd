# Herd usage relay vs Hasso keepalive / guard proxy

These are two different processes. Mixing them up is why Traffic and Requests
look empty even while a model is serving.

## Hasso keepalive / guard proxy (`:8081` on 1c2c)

Installed by the Hasso Qwen38 cockpit. It fronts the engine (`127.0.0.1:8080`,
loopback by default) so clients can call:

- `http://<host>:8081/v1/chat/completions`
- `http://<host>:8081/v1/messages`

Herd can *probe* that proxy for liveness (Settings → Guard proxy URL, see
`docs/guard-proxy.md`). The proxy does **not** expose herd's per-request
metadata endpoints. Pointing Guard proxy at `:8081` will not fill Traffic's
Recent requests table.

Clients such as opencode already use `:8081` (`~/.config/qwen38/opencode.json`).
That traffic never passes through herd unless you add the usage relay in front
of it (or point those clients at the relay listen port instead).

The engine itself is not reachable from another machine unless
`ENGINE_BIND=0.0.0.0`. Dashboard probes should use the node's address and the
configured proxy port, never assume `localhost` on the dashboard host is 1c2c.

Spark Cockpit (separate UI) may listen at `http://<host>:30090`; that is not
the herd usage relay either.

## Herd usage relay (`LLM_PROXY`, node agent 0.5+)

The node agent (sparkdash-node-agent) can optionally run a small relay:

```
LLM_PROXY=<listen>-><upstream>
```

Example on the node, chaining in front of the Hasso engine (not required to
use the keepalive port):

```
LLM_PROXY=127.0.0.1:8082->http://127.0.0.1:8080
```

or, to meter what clients already send to the keepalive proxy:

```
LLM_PROXY=127.0.0.1:8082->http://127.0.0.1:8081
```

Then point clients at the **listen** port (`:8082` here), restart the node
agent, and Traffic should show recent rows. This work does not change a live
host's env; that remains an operator step (issue #104).

### Prerequisite chain

1. Node agent **0.4+** exports raw engine counters (tok/s, token totals). Those
   can label a lane even without the relay, using the served model id from the
   engine or from the matching service (`flash-nvda`, etc.).
2. Node agent **0.5+** understands `LLM_PROXY`.
3. `LLM_PROXY` is actually set and the relay appears in the snapshot's
   `llmProxy[]`.
4. Clients send traffic through the listen port.

If any step is missing, the Traffic / Requests empty states list it. Herd
does not invent request counters.

Current 1c2c note from live testing: the node agent there was 0.3.0, so steps
2–4 cannot succeed until the agent is upgraded (#104). Engine lanes can still
show a served-model name and engine counters once the agent is 0.4+ and the
dashboard can read them (possibly via the keepalive proxy for loopback
engines — see SRV1).
