# Single-Spark components on gx10-1c2c

The catalog already ships two tp=1 SGLang definitions meant to be switched on
a standalone GB10 such as gx10-1c2c:

| Component id | Lane | Served name | Aliases (also matched) | Install unit |
| --- | --- | --- | --- | --- |
| `qwen38-flash-next-sglang-tp1-gx10` | Flash-Next | `qwen3.8-flash-next` | `flash-nvda`, `flash`, `qwen38-flash-next` | `qwen38-flash.service` (container `qwen38-flash`) |
| `qwen38-27b-stock-sglang-tp1-gx10` | Stock 27B | `qwen3.8-27b` | `stock`, `qwen38-sglang`, `qwen38-27b` | `qwen38-sglang.service` |

They are mutually exclusive: Hasso's installer binds the engine at
`127.0.0.1:8080` (loopback by default) and the keepalive / guard proxy at
`:8081` for *whichever lane is serving*. Clients (opencode, OpenAI-shaped
callers) use `http://<node>:8081`. The catalog `ports.engine = 30000` value is
a host placeholder, not the live port — matching uses the aliases above,
never that placeholder alone.

## What you should see

After the dashboard polls 1c2c while Flash is serving `flash-nvda`:

- The flash-next component is **running** (observed via the live model id or
  the `qwen38-flash` unit/container name).
- The stock 27B component is listed and **not** running (installed, not
  enabled). It is switchable through the existing component-action preview
  (`Preview switch…` / dry-run, then confirm). Herd will not start a lane
  without that confirm path.

Switching uses the existing component orchestration (stop the serving lane,
start the other). Do not start both — they share `:8080` / `:8081`.

## Config the dashboard does not invent

Herd does not write per-host ports or API keys into the global catalog, and it
does not overwrite `config/stacks.json` if you already saved stacks. To point
the dashboard at the keepalive proxy (liveness only — this is **not** the
herd usage relay that fills Traffic / Requests), set Settings → Guard proxy
URL to `http://<1c2c-host>:8081` with `apiKeyRef` as `env:…` or `file:…`.
See `docs/guard-proxy.md`.

Traffic and the Requests tab need the **herd** usage relay on the node agent
(`LLM_PROXY`, agent 0.5+). That is separate from the Hasso keepalive proxy.
See `docs/usage-relay.md` once present (issue #98).

## Operator notes

- Do not mutate the Hugging Face cache; recipe pins live in the catalog JSON.
- Stock is installed by `./switch-model.sh stock` / cockpit Load; Flash by
  the flash lane (`target.flash=flash-nvda` in Hasso `installed.json`).
- A leftover topology role of `head` on a single Spark is not a group. Groups
  come from `config/groups.json`; a node in no active group is standalone.
