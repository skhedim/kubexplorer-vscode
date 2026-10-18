// The SVG charts of the drawer.
import { describe, expect, it } from "vitest";
import { renderMetrics, tooltipHtml, valuesAt } from "../../../src/webview/chart";
import type { Chart, MetricsData } from "../../../src/shared/view";

const cpu: Chart = {
  id: "cpu",
  title: "CPU",
  unit: "cpu",
  series: [
    {
      label: "Usage",
      role: "usage",
      points: [
        [1000, 0.1],
        [1060, 0.3],
        [1120, 0.2],
        [1500, 0.2],
      ],
    },
    { label: "Requests", role: "requests", value: 0.25 },
  ],
};
const data: MetricsData = {
  source: "Prometheus monitoring/prometheus",
  charts: [cpu, { ...cpu, id: "memory", title: "Memory", unit: "bytes" }],
};

describe("renderMetrics", () => {
  it("renders the selected tab with its series, reference lines and legend", () => {
    const html = renderMetrics(data, "cpu", 500);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true" data-action="chart-tab" data-chart="cpu"');
    expect(html).toContain('class="ref series-requests"');
    expect(html).toContain("Usage <b>200m</b>");
    // The gap between 1120 and 1500 breaks the line in two segments (an area and a line each).
    expect(html.match(/class="line series-usage"/g)).toHaveLength(1);
    expect(html.match(/class="dot series-usage"/g)).toHaveLength(1);
  });

  it("renders the loading state, errors and notes", () => {
    expect(renderMetrics(undefined, "cpu", 500)).toContain("Loading metrics");
    expect(renderMetrics({ source: "", charts: [], error: "boom" }, "cpu", 500)).toContain("boom");
    expect(renderMetrics({ source: "", charts: [], note: "No pod" }, "cpu", 500)).toContain("No pod");
  });

  it("gives the values of every series at the time under the mouse", () => {
    const values = valuesAt(cpu, 1050)!;
    expect(values.time).toBe(1060);
    expect(values.rows).toEqual([
      { label: "Usage", role: "usage", text: "300m" },
      { label: "Requests", role: "requests", text: "250m" },
    ]);
    expect(tooltipHtml(values)).toContain("Requests: <b>250m</b>");
  });
});
