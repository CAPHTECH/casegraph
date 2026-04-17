import path from "node:path";
import { describe, expect, it } from "vitest";

import { collectEventEvalMetrics } from "./helpers/analysis-eval.js";
import { collectAnalysisGoldenMetrics } from "./helpers/analysis-golden.js";

describe("analysis evaluation harness", () => {
  it("combines exact-match, invariant, and partial-label metrics", async () => {
    const builtinManifestPath = path.resolve(
      process.cwd(),
      "tests/fixtures/analysis-eval-manifest.fixture.json"
    );
    const externalManifestPath = process.env.CASEGRAPH_ANALYSIS_EVAL_MANIFEST
      ? path.resolve(process.cwd(), process.env.CASEGRAPH_ANALYSIS_EVAL_MANIFEST)
      : undefined;

    const exactMatch = await collectAnalysisGoldenMetrics();
    const eventEval = await collectEventEvalMetrics({
      builtinManifestPath,
      externalManifestPath
    });

    const metrics = {
      exact_match: {
        scenario_count: exactMatch.scenario_count,
        check_count: exactMatch.check_count,
        overall: exactMatch.overall,
        by_check: exactMatch.by_check
      },
      event_eval: eventEval
    };

    console.info(`analysis_eval_metrics=${JSON.stringify(metrics)}`);

    expect(metrics.exact_match.overall.hit_rate).toBe(1);
    expect(metrics.event_eval.invariant.overall.hit_rate).toBe(1);
    expect(metrics.event_eval.partial_labels.overall.hit_rate).toBe(1);
  });
});
