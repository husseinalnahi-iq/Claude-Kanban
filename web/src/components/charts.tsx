import { useState, type ReactNode } from "react";

/**
 * Small hand-built SVG charts. Palettes are the dataviz reference instance, stepped for our dark
 * surface (#121310) and checked with the skill's validator — categorical, 2-series and the ordinal
 * priority ramp all pass lightness, chroma, CVD separation, normal-vision and contrast.
 */
export const CATEGORICAL = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];
export const SERIES_A = "#3987e5";
export const SERIES_B = "#199e70";
export const MONEY = "#d95926";
/** p0 (most urgent) → p3, one hue, visible steps. */
export const PRIORITY_RAMP = ["#b7d3f6", "#6da7ec", "#2a78d6", "#184f95"];

const AXIS = "#3a3b34";
const INK_MUTED = "#83827a";

export function Panel({ title, hint, children, right }: { title: string; hint?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold text-ink-100">{title}</h2>
        {hint ? <span className="text-[11.5px] text-ink-500">{hint}</span> : null}
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone = "text-ink-100" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`mt-1 text-[22px] font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11.5px] text-ink-400">{sub}</div> : null}
    </div>
  );
}

export interface Slice {
  key: string;
  count: number;
  color?: string;
  dot?: string;
}

/** Horizontal bars: the form for "how many of each", with the category named in text, never colour alone. */
export function BarRows({ data, total, unit = "" }: { data: Slice[]; total?: number; unit?: string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const sum = total ?? data.reduce((s, d) => s + d.count, 0);
  if (!sum) return <div className="py-6 text-center text-[12px] text-ink-500">Nothing yet.</div>;
  return (
    <div className="space-y-1.5">
      {data.map((d) => (
        <div key={d.key} className="flex items-center gap-2" title={`${d.key}: ${d.count}${unit} of ${sum}`}>
          <span className="flex w-28 shrink-0 items-center gap-1.5 text-[12px] capitalize text-ink-300">
            {d.dot ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.dot}`} /> : null}
            {d.key}
          </span>
          <span className="h-3.5 flex-1 overflow-hidden rounded-sm bg-ink-850">
            <span
              className="block h-full rounded-r-[4px] transition-[width]"
              style={{ width: `${Math.max(d.count ? 2 : 0, (d.count / max) * 100)}%`, background: d.color ?? SERIES_A }}
            />
          </span>
          <span className="w-10 text-right font-mono text-[11.5px] tabular-nums text-ink-300">{d.count}{unit}</span>
        </div>
      ))}
    </div>
  );
}

/** Donut for a part-to-whole with few slices; every slice is also named in the legend. */
export function Donut({ data, size = 132 }: { data: Slice[]; size?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (!total) return <div className="py-6 text-center text-[12px] text-ink-500">Nothing yet.</div>;
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const shown = data.filter((d) => d.count > 0);
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Distribution by type">
        <g transform={`translate(${size / 2} ${size / 2}) rotate(-90)`}>
          {shown.map((d, i) => {
            const frac = d.count / total;
            const dash = frac * c;
            const el = (
              <circle
                key={d.key}
                r={r}
                fill="none"
                stroke={d.color ?? CATEGORICAL[i % CATEGORICAL.length]}
                strokeWidth={hover === d.key ? 20 : 16}
                strokeDasharray={`${Math.max(0, dash - 2)} ${c - Math.max(0, dash - 2)}`}
                strokeDashoffset={-offset}
                onMouseEnter={() => setHover(d.key)}
                onMouseLeave={() => setHover(null)}
                style={{ transition: "stroke-width .12s" }}
              >
                <title>{`${d.key}: ${d.count} (${Math.round(frac * 100)}%)`}</title>
              </circle>
            );
            offset += dash;
            return el;
          })}
        </g>
        <text x="50%" y="48%" textAnchor="middle" className="fill-ink-100" style={{ fontSize: 20, fontWeight: 600 }}>{total}</text>
        <text x="50%" y="62%" textAnchor="middle" fill={INK_MUTED} style={{ fontSize: 10 }}>tasks</text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1">
        {shown.map((d, i) => (
          <li key={d.key} className="flex items-center gap-2 text-[12px]">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: d.color ?? CATEGORICAL[i % CATEGORICAL.length] }} />
            <span className="flex-1 capitalize text-ink-300">{d.key}</span>
            <span className="font-mono tabular-nums text-ink-400">{d.count}</span>
            <span className="w-9 text-right font-mono text-[11px] tabular-nums text-ink-500">{Math.round((d.count / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface LinePoint {
  date: string;
  values: number[];
}

/**
 * Change over time. One y-scale only — money gets its own chart rather than a second axis.
 * Hover gives a crosshair and the day's numbers.
 */
export function LineChart({
  points,
  series,
  height = 150,
  format = (n: number) => String(n),
  area,
}: {
  points: LinePoint[];
  series: { label: string; color: string }[];
  height?: number;
  format?: (n: number) => string;
  area?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 640;
  const padL = 34;
  const padB = 18;
  const padT = 8;
  const max = Math.max(1, ...points.flatMap((p) => p.values));
  const x = (i: number) => padL + (i * (w - padL - 8)) / Math.max(1, points.length - 1);
  const y = (v: number) => padT + (1 - v / max) * (height - padT - padB);
  const ticks = [0, max / 2, max];

  if (!points.length) return <div className="py-6 text-center text-[12px] text-ink-500">Nothing yet.</div>;

  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="w-full"
        role="img"
        aria-label={series.map((s) => s.label).join(" and ") + " over time"}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * w;
          const i = Math.round(((px - padL) / (w - padL - 8)) * (points.length - 1));
          setHover(Math.min(points.length - 1, Math.max(0, i)));
        }}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={w - 8} y1={y(t)} y2={y(t)} stroke={AXIS} strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fill={INK_MUTED} style={{ fontSize: 9 }}>{format(Math.round(t * 100) / 100)}</text>
          </g>
        ))}
        {series.map((s, si) => {
          const d = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.values[si] ?? 0)}`).join(" ");
          return (
            <g key={s.label}>
              {area ? <path d={`${d} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={s.color} opacity={0.14} /> : null}
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {points.length <= 45
                ? points.map((p, i) => ((p.values[si] ?? 0) > 0 ? <circle key={i} cx={x(i)} cy={y(p.values[si])} r={2.5} fill={s.color} /> : null))
                : null}
            </g>
          );
        })}
        {hover !== null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={height - padB} stroke="#57574e" strokeWidth={1} />
            {series.map((s, si) => (
              <circle key={s.label} cx={x(hover)} cy={y(points[hover].values[si] ?? 0)} r={4} fill={s.color} stroke="#121310" strokeWidth={2} />
            ))}
          </g>
        ) : null}
        <text x={padL} y={height - 5} fill={INK_MUTED} style={{ fontSize: 9 }}>{points[0]?.date.slice(5)}</text>
        <text x={w - 8} y={height - 5} textAnchor="end" fill={INK_MUTED} style={{ fontSize: 9 }}>{points.at(-1)?.date.slice(5)}</text>
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11.5px]">
        {series.map((s, si) => (
          <span key={s.label} className="flex items-center gap-1.5 text-ink-300">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label}
            <span className="font-mono tabular-nums text-ink-500">
              {hover !== null ? format(points[hover].values[si] ?? 0) : format(points.reduce((a, p) => a + (p.values[si] ?? 0), 0))}
            </span>
          </span>
        ))}
        <span className="ml-auto font-mono text-[11px] text-ink-500">{hover !== null ? points[hover].date : `last ${points.length} days`}</span>
      </div>
    </div>
  );
}

/** Every chart ships a table view: identity and values must never depend on colour or hover alone. */
export function TableToggle({ rows, headers }: { rows: (string | number)[][]; headers: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="cursor-pointer font-mono text-[10.5px] text-ink-500 underline-offset-2 hover:text-ink-200 hover:underline" onClick={() => setOpen(!open)}>
        {open ? "hide table" : "table"}
      </button>
      {open ? (
        <table className="mt-2 w-full text-left text-[11.5px]">
          <thead className="text-ink-500">
            <tr>{headers.map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="font-mono tabular-nums text-ink-300">
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-ink-800">
                {r.map((c, j) => <td key={j} className="py-1 pr-3">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
