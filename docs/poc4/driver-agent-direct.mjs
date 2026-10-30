/**
 * live-seam-poc4.mjs — POC4 (airhamer/herd#8) live seam driver.
 *
 * Drives the REAL server functions buildComponentAction + proxyComponentAction
 * (server/fleet/componentActions.js, batch/6+7 code) against the DEPLOYED
 * gx10-1c2c node agent (v0.3.0). Read-only by construction: every request
 * carries an impossible serviceName (the deployed agent's v1 envelope guard
 * fires BEFORE the recipe lookup, and an existing recipe name would EXECUTE
 * docker/systemd). The node is never mutated.
 */
import { buildComponentAction, proxyComponentAction } from "./server/fleet/componentActions.js";

const REC = { endpoint: "192.168.50.226:30091", lanIp: "192.168.50.226", agentPort: 30091 };
const IMPOSSIBLE = "__poc4_probe_impossible__";
const out = [];

// Leg A1: server half alone — browser payload -> buildComponentAction (v2 envelope)
const built = buildComponentAction(
  {
    componentId: "qwen38-27b-stock-sglang-tp1-gx10",
    type: "start",
    exclusiveWith: "qwen38-flash-next-sglang-tp1-gx10",
    dryRun: true,
  },
  { nodeId: "gx10-1c2c", actor: "poc4-live-test" }
);
if (!built.ok) throw new Error("build failed: " + built.error);
out.push({ leg: "A1 server buildComponentAction -> v2 ComponentActionRequest", response: built.request });

// Leg A2: full server seam -> proxyComponentAction -> deployed agent POST /actions.
// serviceName is injected ONLY as the v1-guard tripwire (see header); with it
// removed the v2 fields ride verbatim. No execution is possible from this call.
const legA2 = await proxyComponentAction(REC, { ...built.request, serviceName: IMPOSSIBLE });
out.push({ leg: "A2 full seam (v2 request, v1-guard tripwire) -> deployed agent", response: legA2 });

// Leg A3: same proxy call without the tripwire — pure v2 body, verbatim.
const legA3 = await proxyComponentAction(REC, built.request);
out.push({ leg: "A3 full seam (v2 body verbatim, no serviceName)", response: legA3 });

// Leg B: direct control on the agent with a v1-legal envelope — proves the
// agent's action path is alive and refuses ONLY because the service is unknown
// (i.e. there is no materialized recipe for the catalog component ids).
const legB = await fetch(`http://${REC.endpoint}/actions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ actionId: "poc4-b", type: "start", serviceName: IMPOSSIBLE }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
out.push({ leg: "B direct v1-legal control on the deployed agent", response: legB });

// Leg C: traffic seam (proxy) + lane state from the live agent snapshot
const tel = await fetch(`http://${REC.endpoint}/telemetry`).then((r) => r.json());
out.push({
  leg: "C traffic-seam proxy state + lanes (agent telemetry)",
  response: {
    agentVersion: tel.agentVersion,
    proxy: tel.proxy,
    lanes: (tel.lanes?.pools ?? []).map((p) => p.lanes.map((l) => `${l.recipe}:${l.state}`)),
    versions: tel.versions,
    llmPorts: (tel.llm ?? []).map((l) => ({ port: l.port, backend: l.backend, version: l.version, modelId: l.modelId })),
  },
});

// Leg D: durable log channel (agent GET /audit)
const audit = await fetch(`http://${REC.endpoint}/audit?limit=5`).then((r) => r.json());
out.push({ leg: "D agent audit log (GET /audit)", response: audit });

console.log = console.log;
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
