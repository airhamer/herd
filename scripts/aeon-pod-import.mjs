#!/usr/bin/env node
/**
 * Import AEON Bench Pod runs into Herd's bench results (BENCH7).
 * Zero dependencies; Node 18+. Runbook: docs/AEON-POD.md.
 *
 *   node scripts/aeon-pod-import.mjs --pod http://<pod-host>:8091 --run <pod run id> [--run <id> …] \
 *     --herd http://127.0.0.1:5555 --node <spark or node id> [--port 8888] \
 *     [--board-status not_submitted|self_reported|attested] [--board-url https://aeon-bench.com/…] \
 *     [--client-location network|local] [--dry-run]
 *
 *   --file run.json   read a saved GET /api/runs/<id> body instead of --pod/--run
 *   --list            list the pod's runs (GET /api/runs) and exit
 */

import fs from "node:fs";
import { slimPodRun } from "../server/bench/aeonPod/importer.js";

function parseArgs(argv) {
  const out = { run: [], file: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "dry-run" || key === "list" || key === "help") {
      out[key] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (key === "run" || key === "file") out[key].push(v);
    else out[key] = v;
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 14).join("\n"));
    return;
  }
  const pod = args.pod ? args.pod.replace(/\/+$/, "") : null;
  if (args.list) {
    if (!pod) throw new Error("--list needs --pod");
    const { runs } = await getJson(`${pod}/api/runs`);
    for (const r of runs || []) {
      console.log(`${r.id}\t${r.suite_id}\t${r.status}\t${r.model}\t${r.harness || ""}`);
    }
    return;
  }
  const herd = (args.herd || "http://127.0.0.1:5555").replace(/\/+$/, "");
  const runs = [];
  for (const f of args.file) runs.push(JSON.parse(fs.readFileSync(f, "utf8")));
  for (const id of args.run) {
    if (!pod) throw new Error("--run needs --pod");
    runs.push(await getJson(`${pod}/api/runs/${encodeURIComponent(id)}`));
  }
  if (runs.length === 0) throw new Error("nothing to import: pass --pod and --run, or --file");
  let failed = 0;
  for (const run of runs) {
    const body = {
      run: slimPodRun(run),
      node_id: args.node ?? null,
      port: args.port ?? null,
      board_status: args["board-status"] ?? "not_submitted",
      board_url: args["board-url"] ?? null,
      pod_url: pod,
      client_location: args["client-location"] ?? "network",
      dry_run: Boolean(args["dry-run"]),
    };
    const res = await fetch(`${herd}/api/bench-results/import/aeon-pod`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      failed++;
      console.error(`✗ ${run?.id}: HTTP ${res.status} ${out.error || ""}`);
      for (const r of out.rejected || []) console.error(`    ${r.id}: ${(r.errors || []).join("; ")}`);
      continue;
    }
    const verb = body.dry_run ? "would import" : `imported (${out.added} new, ${out.updated} replaced, ${out.removed} removed)`;
    console.log(`✓ ${run.id} ${out.suite} → ${out.run_id}: ${out.ids.length} records ${verb}; board ${out.board_status}, pod says ${out.pod_trust_tier}`);
    for (const s of out.skipped || []) console.log(`    skipped ${s.case_id}: ${s.reason}`);
    for (const w of out.warnings || []) console.log(`    warning: ${w}`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
