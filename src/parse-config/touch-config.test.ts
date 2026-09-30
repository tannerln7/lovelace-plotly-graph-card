import type { HomeAssistant } from "custom-card-helpers";
import type { InputConfig } from "../types";
import { ConfigParser } from "./parse-config";

const cssVars = {
  "card-background-color": "",
  "primary-background-color": "",
  "primary-color": "",
  "primary-text-color": "",
  "secondary-text-color": "",
  "font-family": "",
  "font-size": "",
  "font-weight": "",
};

const hass = {
  locale: { language: "en", first_weekday: "language" },
  states: {},
} as unknown as HomeAssistant;

const base: InputConfig = {
  type: "custom:plotly-graph",
  entities: [],
};

const parse = async (overrides: Partial<InputConfig> = {}) => {
  const parser = new ConfigParser();
  return (
    await parser.update({
      yaml: { ...base, ...overrides },
      hass,
      css_vars: cssVars,
    })
  ).parsed;
};

describe("parsed touch feature configuration", () => {
  beforeEach(() => {
    (globalThis as any).window = {};
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("defaults touch hover off", async () => {
    expect((await parse()).touch_hover).toBe(false);
  });

  it.each([
    [true, true],
    ["$ex false", false],
    ["$ex true", true],
  ] as const)("parses touch_hover %p as %p", async (input, expected) => {
    expect(
      (
        await parse({
          touch_hover: input as unknown as boolean,
        })
      ).touch_hover,
    ).toBe(expected);
  });

  it("uses touch hover supplied by a preset", async () => {
    (globalThis as any).window.PlotlyGraphCardPresets = {
      touch: { ...base, touch_hover: true },
    };
    expect((await parse({ preset: "touch" })).touch_hover).toBe(true);
  });

  it("keeps zoom and hover feature gates independent", async () => {
    const parsed = await parse({
      disable_pinch_to_zoom: true,
      touch_hover: "$ex true" as unknown as boolean,
    });
    expect(parsed.disable_pinch_to_zoom).toBe(true);
    expect(parsed.touch_hover).toBe(true);
  });
});
