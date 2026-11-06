import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  matchServiceToComponent,
  normalizeModelId,
} from "../../../shared/componentMatch.js";
import { loadComponentCatalog, joinComponentState } from "../componentCatalog.js";

const flash = {
  id: "qwen38-flash-next-sglang-tp1-gx10",
  engine: "sglang",
  servedModelName: "qwen3.8-flash-next",
  modelAliases: ["flash-nvda", "flash", "qwen38-flash-next"],
  nameAliases: ["qwen38-flash", "qwen38-flash.service"],
  port: 30000,
  portPlaceholder: true,
};
const stock = {
  id: "qwen38-27b-stock-sglang-tp1-gx10",
  engine: "sglang",
  servedModelName: "qwen3.8-27b",
  modelAliases: ["stock", "qwen38-sglang"],
  nameAliases: ["qwen38-sglang"],
  port: 30000,
  portPlaceholder: true,
};

describe("componentMatch", () => {
  test("normalizeModelId strips org prefix and service suffix", () => {
    assert.equal(normalizeModelId("org/flash-nvda"), "flash-nvda");
    assert.equal(normalizeModelId("qwen38-flash.service"), "qwen38-flash");
  });

  test("flash-nvda on :8080 matches the flash-next definition, not stock", () => {
    const hit = matchServiceToComponent([flash, stock], {
      engine: "sglang",
      port: 8080,
      modelId: "flash-nvda",
      name: "llm-tp1",
    });
    assert.equal(hit?.id, flash.id);
  });

  test("a placeholder catalog port does not pin both lanes to the same process", () => {
    const hit = matchServiceToComponent([flash, stock], {
      engine: "sglang",
      port: 30000,
      modelId: null,
      name: "other",
    });
    assert.equal(hit, null);
  });

  test("service-name alias matches a stopped flash unit without a live model id", () => {
    const hit = matchServiceToComponent([flash, stock], {
      engine: "sglang",
      port: 8080,
      modelId: "",
      name: "qwen38-flash.service",
    });
    assert.equal(hit?.id, flash.id);
  });

  test("joinComponentState observes a running flash-nvda service", () => {
    const { components } = loadComponentCatalog();
    const joined = joinComponentState(components, [
      {
        nodeId: "gx10-1c2c",
        nodeName: "1c2c",
        services: [
          { name: "llm-tp1", engine: "sglang", port: 8080, modelId: "flash-nvda", status: "running" },
        ],
        versions: [],
      },
    ]);
    const flashRow = joined.find((c) => c.id.includes("flash-next"));
    const stockRow = joined.find((c) => c.id.includes("27b-stock"));
    assert.equal(flashRow.nodes.length, 1);
    assert.equal(flashRow.nodes[0].state, "running");
    assert.equal(stockRow.nodes.length, 0);
  });
});
