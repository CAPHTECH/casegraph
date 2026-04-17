import { describe, expect, it } from "vitest";

import { collectAnalysisGoldenMetrics } from "./helpers/analysis-golden.js";

describe("analysis golden corpus", () => {
  it("matches expected outputs and reports exact-match hit rates", async () => {
    const metrics = await collectAnalysisGoldenMetrics();
    console.info(`analysis_golden_metrics=${JSON.stringify(metrics)}`);

    expect(metrics.overall.hit_rate).toBe(1);
    expect(metrics.scenarios.every((scenario) => scenario.passed)).toBe(true);
  });
});
