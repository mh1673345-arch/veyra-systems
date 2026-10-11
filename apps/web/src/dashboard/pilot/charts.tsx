import type { PilotSeriesPoint } from "@veyra/shared";

/**
 * Charts for the pilot dashboard.
 *
 * Deliberately plain SVG: every bar is a count the API returned, the axis
 * starts at zero, and an empty range renders an empty state rather than a
 * flattering curve. There is no smoothing, no projection and no trend line —
 * nothing here may suggest a shape the data does not have.
 */

const SERIES = [
  { key: "conversations" as const, label: "Conversations", className: "ops-chart-a" },
  { key: "bookings" as const, label: "Bookings", className: "ops-chart-b" },
  { key: "escalations" as const, label: "Handoffs", className: "ops-chart-c" }
];

function shortDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function ActivityChart({ points }: { points: PilotSeriesPoint[] }) {
  const max = Math.max(1, ...points.flatMap((point) => [point.conversations, point.bookings, point.escalations]));
  const hasAny = points.some((point) => point.conversations + point.bookings + point.escalations > 0);

  if (points.length === 0 || !hasAny) {
    return (
      <p className="ops-note" data-testid="pilot-chart-empty">
        No activity in this period yet. Nothing is charted until there is something to chart.
      </p>
    );
  }

  const width = Math.max(320, points.length * 42);
  const height = 160;
  const barGroup = width / points.length;
  const barWidth = Math.max(3, (barGroup - 8) / 3);

  return (
    <figure className="ops-chart" data-testid="pilot-activity-chart">
      <svg viewBox={`0 0 ${width} ${height + 26}`} role="img" aria-label="Daily conversations, bookings and handoffs">
        <line x1="0" y1={height} x2={width} y2={height} className="ops-chart-axis" />
        {points.map((point, index) =>
          SERIES.map((series, seriesIndex) => {
            const value = point[series.key];
            const barHeight = (value / max) * (height - 8);
            return (
              <rect
                key={`${point.date}-${series.key}`}
                x={index * barGroup + 4 + seriesIndex * barWidth}
                y={height - barHeight}
                width={barWidth}
                height={barHeight}
                className={series.className}
              >
                <title>{`${shortDate(point.date)} — ${series.label}: ${value}`}</title>
              </rect>
            );
          })
        )}
        {points.map((point, index) =>
          // Only every other label on a long range, so nothing overlaps.
          index % Math.ceil(points.length / 10) === 0 ? (
            <text key={`label-${point.date}`} x={index * barGroup + barGroup / 2} y={height + 18} textAnchor="middle" className="ops-chart-label">
              {shortDate(point.date)}
            </text>
          ) : null
        )}
      </svg>
      <figcaption className="ops-chart-legend">
        {SERIES.map((series) => (
          <span key={series.key}>
            <span className={`ops-chart-swatch ${series.className}`} aria-hidden="true" /> {series.label}
          </span>
        ))}
        <span className="ops-note">Peak in a single day: {max}</span>
      </figcaption>
    </figure>
  );
}

export function BarList({
  rows,
  emptyMessage,
  testId
}: {
  rows: { label: string; count: number; hint?: string }[];
  emptyMessage: string;
  testId?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="ops-note" data-testid={testId ? `${testId}-empty` : undefined}>
        {emptyMessage}
      </p>
    );
  }
  const max = Math.max(...rows.map((row) => row.count), 1);

  return (
    <ul className="ops-bar-list" data-testid={testId}>
      {rows.map((row) => (
        <li key={row.label}>
          <span className="ops-bar-label" title={row.hint}>
            {row.label}
          </span>
          <span className="ops-bar-track" aria-hidden="true">
            <span className="ops-bar-fill" style={{ width: `${Math.round((row.count / max) * 100)}%` }} />
          </span>
          <span className="ops-bar-count">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}
