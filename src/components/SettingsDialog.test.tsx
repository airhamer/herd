import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanupRenders, flush, render } from "../testing/render";
import type { Settings } from "../api/types";

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("./AlertsDialog", () => ({ AlertsDialog: () => null }));
vi.mock("./BrowserAlertsSettings", () => ({ BrowserAlertsSettings: () => null }));

import { fetchSettings, updateSettings } from "../api/client";
import { SettingsDialog } from "./SettingsDialog";

const load = vi.mocked(fetchSettings);
const save = vi.mocked(updateSettings);

afterEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    pollIntervalMs: 2000,
    defaultLlmPort: 8000,
    autoHideOffline: false,
    hideWorkers: false,
    temperatureUnit: "celsius",
    benchDebugTraces: false,
    density: "compact",
    showFleetEnergy: true,
    showFleetExceptions: false,
    showOverviewSearch: false,
    benchShareImage: true,
    metricsHistory: false,
    electricityPricePerKwh: 0.17,
    electricityCurrency: "USD",
    energyIdleBaselineW: 40,
    energyHostBaselines: {},
    ...overrides,
  };
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open(initial: Settings) {
  load.mockResolvedValue(initial);
  const onSaved = vi.fn();
  const view = render(<SettingsDialog open onClose={() => {}} onSaved={onSaved} />);
  await flush();
  await flush();
  return { ...view, onSaved };
}

describe("SettingsDialog Fleet energy (issue #33)", () => {
  it("shows the toggle on with price, currency and idle-baseline fields", async () => {
    const { container } = await open(settings());
    expect(container.textContent).toContain("Show Fleet energy");
    expect(container.textContent).toContain("On by default");
    const price = container.querySelector<HTMLInputElement>("[aria-label='Electricity price per kWh']");
    const currency = container.querySelector<HTMLInputElement>("[aria-label='Electricity currency']");
    const idle = container.querySelector<HTMLInputElement>("[aria-label='Idle baseline watts per host']");
    expect(price?.value).toBe("0.17");
    expect(currency?.value).toBe("USD");
    expect(idle?.value).toBe("40");
  });

  it("saves edited price, currency and baseline", async () => {
    const { container } = await open(settings());
    setInput(container.querySelector<HTMLInputElement>("[aria-label='Electricity price per kWh']")!, "0.32");
    setInput(container.querySelector<HTMLInputElement>("[aria-label='Electricity currency']")!, "eur");
    setInput(container.querySelector<HTMLInputElement>("[aria-label='Idle baseline watts per host']")!, "55");
    save.mockImplementation(async (next) => next as Settings);
    const saveButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save");
    expect(saveButton).toBeDefined();
    await act(async () => {
      saveButton!.click();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      electricityPricePerKwh: 0.32,
      electricityCurrency: "EUR",
      energyIdleBaselineW: 55,
      showFleetEnergy: true,
    });
  });

  it("hides the energy fields when the card is turned off", async () => {
    const { container } = await open(settings({ showFleetEnergy: false }));
    expect(container.querySelector("[aria-label='Electricity price per kWh']")).toBeNull();
    const toggle = [...container.querySelectorAll<HTMLButtonElement>("button[role=switch]")].find((b) =>
      b.parentElement?.textContent?.includes("Show Fleet energy")
    );
    act(() => toggle!.click());
    expect(container.querySelector("[aria-label='Electricity price per kWh']")).not.toBeNull();
  });
});
