# Memory pools: unified Sparks vs discrete GPUs

## Recommendation: should Elephant-AI services be part of the "floor"?

**Count them as measured infra usage, not as a second floor.**

- On a GB10 Spark the CPU and GPU share one LPDDR5X pool. The existing 3 GiB
  line is a Spark OOM-livelock floor (Hasso): it is about *remaining available
  unified memory*, not about any one service. herd displays it; it does not
  abort generations.
- Essential Elephant-AI / node-agent / keepalive-proxy processes already show
  up in `/proc/meminfo` used/available (and in GPU allocations when they
  allocate). Deducting a second "Elephant floor" on top of that would hide
  the same memory twice and make "can another service fit?" too pessimistic.
- If you want a cushion *beyond* what is already used, configure a separately
  named **safety reserve**. It is labeled as such and subtracted once from
  free VRAM (discrete) or shown next to the Spark floor (unified). It is not
  the 3 GiB Spark floor reused under another name.

So: measured once as system/infra; extra reserve named separately; unknown
readings stay "unknown", never displayed as 0.

## Discrete GPU hosts (Narthex)

VRAM is the inference budget. System RAM is shown separately and is **not**
added to VRAM as one interchangeable capacity. CPU offload is mentioned only
when an engine is explicitly configured to place weights in RAM.

The 3 GiB Spark floor does not apply to VRAM on these cards.
