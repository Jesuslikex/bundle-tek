import { describe, expect, it } from "vitest";
import { projectPulseCycle, validatePulseStrategy } from "@/lib/pulse-validation";

describe("validatePulseStrategy", () => {
  it("accepts a strategy at the supported boundaries", () => {
    expect(validatePulseStrategy({
      strategy: "Balanced", agents: 1, budget: 0.5, cadence: 180,
      orderSize: 0.1, spread: 300, inventory: 20,
    })).toMatchObject({ strategy: "Balanced", agents: 1, budget: 0.5 });
  });

  it("rejects non-finite numeric inputs", () => {
    expect(() => validatePulseStrategy({
      strategy: "Balanced", agents: 2, budget: "not-a-number", cadence: 30,
      orderSize: 0.5, spread: 80, inventory: 50,
    })).toThrow();
  });
});

describe("projectPulseCycle", () => {
  it("produces a deterministic simulation projection", () => {
    expect(projectPulseCycle({
      strategy: "Balanced", agents: 6, budget: 4, cadence: 45,
      orderSize: 0.8, spread: 90, inventory: 50,
    })).toEqual({ orders: 432, turnover: 200.45, risk: 58 });
  });
});
