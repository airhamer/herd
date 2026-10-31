/**
 * browser-identical.mjs — replays EXACTLY what the built ComponentsPage sends:
 * POST /api/fleet/nodes/<id>/component-actions with body
 * { type, componentId, groupRef:null, exclusiveWith:null, confirmationToken:null,
 *   dryRun:true, recipeName:null, timeoutMs:null }   (dryRun leg; confirm=null)
 * against the fresh batch/8 server (loopback :5556) -> real gx10-1c2c agent.
 */
const PORT = Number(process.env.TEST_PORT || 5556);
const url = `http://127.0.0.1:${PORT}/api/fleet/nodes/gx10-1c2c/component-actions`;
const body = {
  type: "start",
  componentId: "qwen38-27b-stock-sglang-tp1-gx10",
  groupRef: null,
  exclusiveWith: null,
  confirmationToken: null,
  dryRun: true,
  recipeName: null,
  timeoutMs: null,
};
const r = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
console.log(JSON.stringify({ browserBody: body, httpStatus: r.status, response: await r.json().catch(() => null) }, null, 2));
