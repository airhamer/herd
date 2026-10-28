// S3.1 — place in agent/nodeAgent.js between containerStop() and _reconcile().
// ALSO: add router cases lane_create/lane_start/lane_stop/lane_remove beside the
// container_start cases (dispatch to these methods with (params, id)); private
// field/method names (#runner, #emit, state, stats) must be re-checked against the
// real nodeAgent.js on the next attempt — this snippet is from worker context, verify.
// Lane lifecycle (S3.1): mirrors the container* pattern — runner-backed, per-action
// idempotency, one-way events, no reconcile. name == sanitized name (never rename
// agent-side); the sanitizer mirrors server/fleet/fleet.ts laneNameOf exactly.

const LANES_MAX = 8;
const sanitizeLaneName = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64);

// inside class NodeAgent:
  async laneCreate(params, id) {
    const name = sanitizeLaneName(params.name);
    if (!name) return { ok: false, error: "invalid lane name" };
    if (!this.#runner) return { ok: false, error: "no docker runner configured" };
    const lanes = this.state.lanes ?? {};
    const existing = Object.values(lanes).find((l) => l.name === name);
    if (existing?.status === "running") if (existing?.status === "running") return { ok: true, id: existing.container_id }; // idempotent no-op
    if (!existing && Object.keys(lanes).length >= LANES_MAX) return { ok: false, error: `lane limit reached (${LANES_MAX})` };
    const image = String(params.image ?? "").trim();
    const args = ["-d", "--pull", "always", "--label", "sparkdash-managed=true"];
    for (const port of params.ports ?? []) args.push("-p", String(port));
    for (const vol of params.volumes ?? []) args.push("-v", String(vol));
    if (params.cpu_limit != null) args.push("--cpus", String(params.cpu_limit));
    if (params.mem_limit != null) args.push("--memory", String(params.mem_limit));
    if (params.gpu) args.push("--gpus", "all");
    args.push(image);
    try {
      const containerId = (await this.#runner(["run", ...args])).trim();
      const shortId = containerId.slice(0, 12);
      lanes[name] = { name, container_id: shortId, status: "running", updated_at: Date.now() };
      this.#emit("lane_created", { id, name, container_id: shortId });
      this.stats.containersStarted += 1;
      return { ok: true, id: shortId };
    } catch (err) {
      this.#emit("lane_create_failed", { id, name, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async laneStart(name, id) {
    const key = sanitizeLaneName(name);
    const lane = this.state.lanes?.[key];
    if (!lane) return { ok: false, error: `no lane ${name}` };
    if (!this.#runner) return { ok: false, error: "no docker runner configured" };
    try {
      await this.#runner(["start", lane.container_id]);
      lane.status = "running";
      lane.updated_at = Date.now();
      this.#emit("lane_started", { id, name: lane.name });
      return { ok: true };
    } catch (err) {
      this.#emit("lane_start_failed", { id, name: lane.name, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async laneStop(name, id) {
    const key = sanitizeLaneName(name);
    const lane = this.state.lanes?.[key];
    if (!lane) return { ok: false, error: `no lane ${name}` };
    if (!this.#runner) return { ok: false, error: "no docker docker configured" };
    try {
      await this.#runner(["stop", lane.container_id]);
      lane.status = "stopped";
      lane.updated_at = Date.now();
      this.#emit("lane_stopped", { id, name: lane.name });
      return { ok: true };
    } catch (err) {
      this.#emit("lane_stop_failed", { id, name: lane.name, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async laneRemove(name, id) {
    const key = sanitizeLaneName(name);
    const lane = this.state.lanes?.[key];
    if (!lane) return { ok: false, error: `no lane ${name}` };
    if (!this.#runner) return { ok: false, error: "no docker runner configured" };
    try {
      await this.#runner(["rm", "-f", lane.container_id]);
      delete this.state.lanes[key];
      this.#emit("lane_deleted", { id, name: lane.name });
      return { ok: true };
    } catch (err) {
      this.#emit("lane_remove_failed", { id, name: lane.name, error: err.message });
      return { ok: false, error: err.message };
    }
  }
