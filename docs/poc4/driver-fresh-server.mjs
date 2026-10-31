/**
 * live-seam-server.mjs — POC4 leg against a FRESH server instance from
 * batch/8 HEAD (PORT from env, loopback). Same read-only tripwire pattern:
 * an impossible serviceName cannot execute anything on the deployed agent.
 */
import { buildComponentAction, proxyComponentAction } from "./server/fleet/componentActions.js";

const PORT = Number(process.env.TEST_PORT || 5556);
const REC = { endpoint: `127.0.0.1:${PORT}`, lanIp: "127.0.0.1", agentPort: PORT };
const out = [];

// Server half (batch/8 buildComponentAction) -> server proxy (batch/8 route code) -> agent.
const built = buildComponentAction(
  { componentId: "qwen38-27b-stock-sglang-tp1-gx10", type: "start", exclusiveWith: "qwen38-flash-next-sglang-tp1-gx10", dryRun: true },
  { nodeId: "gx10-1c2c", actor: "poc4-live-test" }
);
if (!built.ok) throw new Error("build failed: " + built.error);
const r1 = await proxyComponentAction(REC, built.request);
out.push({ leg: "S1 batch/8 route: v2 body verbatim -> fresh server -> agent", request: built.request, response: r1 });

const r2 = await proxyComponentAction(REC, { ...built.request, serviceName: "__poc4_probe_impossible__" });
out.push({ leg: "S2 batch/8 route: v2 body + v1-guard tripwire -> fresh server -> agent", response: r2 });

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
