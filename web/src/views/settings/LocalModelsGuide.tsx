import { useEffect, useState, type ReactNode } from "react";
import type { Provider, ProviderTestResult } from "../../../../server/src/types.ts";
import { api, type LocalModelsStatus, type ProviderPreset } from "../../lib/api.ts";
import { Button } from "../../components/ui.tsx";

/**
 * "Free AI on this computer": a step-by-step guide to LM Studio or Ollama for people who have never
 * run a model locally. Every step says what to click, and ticks itself off by looking at the machine.
 */

type App = "lmstudio" | "ollama";
type State = "done" | "todo" | "warn" | "info";

const LINKS = {
  lmstudio: "https://lmstudio.ai/download",
  ollama: "https://ollama.com/download",
  ollamaSearch: "https://ollama.com/search?c=cloud",
};

const KEY = "kanban.localGuide";
function remembered(): { app?: App; open?: boolean; ctxDone?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as { app?: App; open?: boolean; ctxDone?: boolean };
  } catch {
    return {};
  }
}
function remember(patch: { app?: App; open?: boolean; ctxDone?: boolean }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...remembered(), ...patch }));
  } catch {
    // per-browser convenience only
  }
}

const Mark = ({ s }: { s: State }) => (
  <span
    className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
      s === "done" ? "bg-moss/20 text-moss" : s === "warn" ? "bg-amber/20 text-amber" : "bg-ink-800 text-ink-400"
    }`}
  >
    {s === "done" ? "✓" : s === "warn" ? "!" : "·"}
  </span>
);

function Step({ n, title, state, detail, current, children }: { n: number; title: string; state: State; detail?: ReactNode; current: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = current || open || state === "warn";
  return (
    <li className={`rounded-lg border px-3 py-2.5 ${current ? "border-amber/50 bg-amber/5" : "border-ink-800 bg-ink-900/40"}`}>
      <button type="button" className="flex w-full cursor-pointer items-start gap-2.5 text-left" onClick={() => setOpen((o) => !o)}>
        <Mark s={state} />
        <span className="min-w-0 flex-1">
          <span className={`text-[13px] font-medium ${state === "done" && !current ? "text-ink-300" : "text-ink-100"}`}>
            {n}. {title}
          </span>
          {detail ? <span className="block text-[11.5px] text-ink-400">{detail}</span> : null}
        </span>
        {!current && state !== "warn" ? <span className="text-[11px] text-ink-500">{show ? "hide" : "how"}</span> : null}
      </button>
      {show && children ? <div className="mt-2 ml-7.5 space-y-2 text-[12.5px] leading-relaxed text-ink-300">{children}</div> : null}
    </li>
  );
}

const Kbd = ({ children }: { children: ReactNode }) => <b className="font-semibold text-ink-100">{children}</b>;

function Picks({ s }: { s: LocalModelsStatus }) {
  const [copied, setCopied] = useState("");
  const chip = { fast: ["Fast here", "text-moss border-moss/40"], ok: ["Works well", "text-cyan border-cyan/40"], slow: ["Slow here", "text-amber border-amber/40"], "too-big": ["Too big", "text-rust border-rust/40"] } as const;
  const order = { fast: 0, ok: 1, slow: 2, "too-big": 3 } as const;
  return (
    <div className="overflow-x-auto rounded-md border border-ink-800">
      <table className="w-full text-[12px]">
        <tbody>
          {[...s.picks].sort((a, b) => order[a.verdict] - order[b.verdict]).map((p) => (
            <tr key={p.name} className="border-b border-ink-800 last:border-0">
              <td className="px-2 py-1.5 font-medium whitespace-nowrap text-ink-100">{p.name}</td>
              <td className="px-2 py-1.5 whitespace-nowrap text-ink-400">~{p.sizeGB} GB</td>
              <td className="px-2 py-1.5"><span className={`rounded border px-1.5 py-px text-[10.5px] whitespace-nowrap ${chip[p.verdict][1]}`}>{chip[p.verdict][0]}</span></td>
              <td className="px-2 py-1.5 text-ink-400">{p.note}</td>
              <td className="px-2 py-1.5 text-right">
                <button
                  type="button"
                  className="cursor-pointer text-[11px] whitespace-nowrap text-ink-400 hover:text-ink-100"
                  onClick={() => void navigator.clipboard?.writeText(p.search).then(() => setCopied(p.name))}
                  title="Copy the name, then paste it into LM Studio's search box"
                >
                  {copied === p.name ? "copied ✓" : "copy name"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hardware({ s }: { s: LocalModelsStatus }) {
  const h = s.hardware;
  const bits = [
    h.gpu ?? "graphics card not detected",
    h.vramGB ? `${h.vramGB} GB ${h.unified ? "for models" : "graphics memory"}` : null,
    h.unified ? null : `${h.ramGB} GB memory`,
    h.diskFreeGB !== null ? `${h.diskFreeGB} GB free disk` : null,
  ].filter(Boolean);
  return (
    <div className="rounded-md border border-ink-800 bg-ink-900/50 px-3 py-2 text-[12px]">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-500">Your computer</div>
      <div className="text-ink-200">{bits.join(" · ")}</div>
      <div className="mt-0.5 text-ink-400">
        {s.budget.fastGB ? <>Fast: models up to <Kbd>{s.budget.fastGB} GB</Kbd>. </> : null}
        {s.budget.okGB > (s.budget.fastGB ?? 0) ? <>Usable: models with <Kbd>A3B</Kbd> or <Kbd>A4B</Kbd> in the name up to <Kbd>{s.budget.okGB} GB</Kbd> (only a small part of them works at a time, so they run well from memory). </> : null}
        {!s.budget.fastGB && s.budget.okGB < 6 ? <>This computer is small for local models: Ollama's free cloud models are the better choice.</> : null}
      </div>
    </div>
  );
}

export function LocalModelsGuide({ providers, presets }: { providers: Provider[]; presets: ProviderPreset[] }) {
  const saved = remembered();
  const [open, setOpen] = useState(saved.open ?? !providers.some((p) => p.id.startsWith("lmstudio") || p.id.startsWith("ollama")));
  const [app, setApp] = useState<App>(saved.app ?? "lmstudio");
  const [s, setS] = useState<LocalModelsStatus | null>(null);
  const [ctxDone, setCtxDone] = useState(saved.ctxDone ?? false);
  const [adding, setAdding] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Look again every few seconds while the guide is open, so each step ticks itself off.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => void api.localModels().then((r) => live && setS(r)).catch(() => null);
    load();
    const t = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [open, providers]);

  const toggle = (v: boolean) => {
    setOpen(v);
    remember({ open: v });
  };
  const pickApp = (a: App) => {
    setApp(a);
    setTest(null);
    remember({ app: a });
  };

  const a = s ? s[app] : null;
  const providerId = app === "lmstudio" ? "lmstudio" : "ollama";
  const onBoard = providers.find((p) => p.id === providerId || (app === "ollama" ? p.id.startsWith("ollama") && p.kind === "anthropic-compatible" : p.id.startsWith("lmstudio")));

  const addToBoard = async () => {
    const preset = presets.find((p) => p.id === providerId);
    if (!preset) return;
    setAdding(true);
    try {
      const { blurb: _b, help: _h, seedSecret: _s, ...rest } = preset;
      const next = onBoard ? providers.map((p) => (p.id === onBoard.id ? { ...p, enabled: true } : p)) : [...providers, { ...rest, enabled: true }];
      await api.patchSettings({ providers: next });
    } finally {
      setAdding(false);
    }
  };

  const runTest = async () => {
    if (!onBoard) return;
    setTesting(true);
    try {
      setTest(await api.testProvider(onBoard.id));
    } catch (err) {
      setTest({ ok: false, latencyMs: 0, modelEcho: null, usageReported: false, costReported: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const ready = (x: App) => s && s[x].running && s[x].models.length > 0 && s[x].added;
  if (!open) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-ink-800 bg-ink-900/50 px-3 py-2 text-[12.5px]">
        <span className="font-medium text-ink-100">Free AI on this computer</span>
        <span className="text-ink-400">— run models locally with LM Studio or Ollama.</span>
        <button type="button" className="ml-auto cursor-pointer text-amber hover:underline" onClick={() => toggle(true)}>Open the step-by-step guide</button>
      </div>
    );
  }

  // Each step's state, in order; the first one not done is where you are.
  const loadedSmall = a?.models.find((m) => m.loaded && m.contextLength && m.contextLength < (s?.minContext ?? 32000));
  const loadedBig = a?.models.find((m) => m.loaded && (m.contextLength ?? 0) >= (s?.minContext ?? 32000));
  const states: State[] = !s || !a ? [] : [
    a.installed ? "done" : "todo",
    a.running ? "done" : "todo",
    a.models.length ? "done" : "todo",
    app === "lmstudio" ? (loadedSmall ? "warn" : loadedBig || ctxDone ? "done" : "info") : ctxDone ? "done" : "info",
    a.added ? "done" : "todo",
    test?.ok ? "done" : "todo",
  ];
  const current = states.findIndex((x) => x === "todo" || x === "warn" || x === "info");

  return (
    <div className="mb-4 rounded-xl border border-ink-700 bg-ink-850/60 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-ink-100">Free AI on this computer</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-400">
            A model that runs on your own computer: free, and nothing leaves it. It is less capable than Claude, so it suits
            reviewing a plan, small changes, or carrying on when Claude's limit is reached. Follow the steps; each one ticks itself off.
          </p>
        </div>
        <button type="button" className="cursor-pointer text-[12px] text-ink-400 hover:text-ink-100" onClick={() => toggle(false)}>hide</button>
      </div>

      {s ? <div className="mt-3"><Hardware s={s} /></div> : <p className="mt-3 text-[12px] text-ink-500">Looking at this computer…</p>}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {([
          ["lmstudio", "LM Studio", "Easiest to start: an app with a model store, like an app store for AI models."],
          ["ollama", "Ollama", "Runs quietly in the background. Also has free cloud models that need no download."],
        ] as const).map(([id, name, blurb]) => (
          <button
            key={id}
            type="button"
            onClick={() => pickApp(id)}
            className={`cursor-pointer rounded-lg border p-3 text-left ${app === id ? "border-amber/60 bg-amber/5" : "border-ink-800 bg-ink-900/40 hover:border-ink-600"}`}
          >
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ink-100">
              {name}
              {id === "lmstudio" ? <span className="rounded bg-amber/15 px-1.5 text-[10px] font-medium text-amber">recommended</span> : null}
              {ready(id) ? <span className="ml-auto text-[11px] font-medium text-moss">ready ✓</span> : null}
            </div>
            <div className="mt-0.5 text-[11.5px] text-ink-400">{blurb}</div>
          </button>
        ))}
      </div>

      {s && a ? (
        <ol className="mt-3 space-y-1.5">
          {app === "lmstudio" ? (
            <>
              <Step n={1} title="Install LM Studio" state={states[0]} current={current === 0} detail={a.installed ? "Installed." : "Not found on this computer yet."}>
                <p>Download it, open the file, and click through the installer like any other app.</p>
                <a href={LINKS.lmstudio} target="_blank" rel="noreferrer"><Button size="sm" variant="primary">Download LM Studio ↗</Button></a>
              </Step>
              <Step n={2} title="Turn on its local server" state={states[1]} current={current === 1} detail={a.running ? `On, at ${a.url}${a.locked ? " (asks for a token — see the key field below)" : ""}.` : "Off: the board cannot reach LM Studio yet."}>
                <p>Open LM Studio. Click the <Kbd>gear</Kbd> (Settings) at the bottom left, then <Kbd>Local Model API</Kbd>, and switch <Kbd>Local API server</Kbd> on.</p>
                <p>Leave <Kbd>Just-in-time model loading</Kbd> on: then the board can start a model by itself when a task needs it.</p>
                <p className="text-ink-500">In older versions this is the <Kbd>Developer</Kbd> tab → <Kbd>Start server</Kbd>. The address should stay <span className="font-mono">http://localhost:1234</span>.</p>
              </Step>
              <Step n={3} title="Download a model" state={states[2]} current={current === 2} detail={a.models.length ? `${a.models.length} downloaded: ${a.models.map((m) => m.id).join(", ")}` : "No chat models downloaded yet."}>
                <p>
                  <Kbd>Easiest:</Kbd> the <a className="text-amber hover:underline" href="#/setup">Setup page</a> downloads <Kbd>Gemma 4 12B</Kbd> (small, for simple tasks) or{" "}
                  <Kbd>Qwen3.8 27B</Kbd> (smarter, for a strong PC) in one click, and says how each runs on this computer.
                </p>
                <p>Or in LM Studio click <Kbd>Explore</Kbd> (the magnifying glass), paste a name from this list into the search box, pick it and click <Kbd>Download</Kbd>. Picked for your computer:</p>
                <Picks s={s} />
                <p className="text-ink-500">Any model marked <Kbd>Tools</Kbd> in LM Studio works. LM Studio also shows “Full GPU offload possible” for ones that fit your graphics card — those are the fastest.</p>
              </Step>
              <Step
                n={4}
                title="Give models enough room to read (32k context)"
                state={states[3]}
                current={current === 3}
                detail={loadedSmall ? `${loadedSmall.id} is loaded with only ${Math.round((loadedSmall.contextLength ?? 0) / 1000)}k — a task would fail.` : loadedBig ? `${loadedBig.id} is loaded with ${Math.round((loadedBig.contextLength ?? 0) / 1000)}k. Good.` : "The board reads a lot of code at once; the default (4k) is too small."}
              >
                <p>In LM Studio: <Kbd>gear</Kbd> → <Kbd>Local Model Defaults</Kbd> → set <Kbd>Minimum AutoFit context length</Kbd> to <Kbd>32000</Kbd> or more (64000 is better if your computer copes).</p>
                {loadedSmall ? <p className="text-amber">Then eject the loaded model (<Kbd>Loaded Instances</Kbd>) so it loads again with the new size.</p> : null}
                {!ctxDone ? <Button size="sm" onClick={() => { setCtxDone(true); remember({ ctxDone: true }); }}>I've set it</Button> : null}
              </Step>
            </>
          ) : (
            <>
              <Step n={1} title="Install Ollama" state={states[0]} current={current === 0} detail={a.installed ? "Installed." : "Not found on this computer yet."}>
                <p>Download it, open the file, and click through the installer.</p>
                <a href={LINKS.ollama} target="_blank" rel="noreferrer"><Button size="sm" variant="primary">Download Ollama ↗</Button></a>
              </Step>
              <Step n={2} title="Open the Ollama app" state={states[1]} current={current === 1} detail={a.running ? `Running, at ${a.url}.` : "Not running."}>
                <p>Open <Kbd>Ollama</Kbd> from the Start menu (or Applications). It keeps running in the background, with a small llama icon near the clock.</p>
              </Step>
              <Step n={3} title="Get a model" state={states[2]} current={current === 2} detail={a.models.length ? `${a.models.length} ready: ${a.models.map((m) => m.id).join(", ")}` : "None yet."}>
                <p><Kbd>Easiest — free cloud models, nothing to download:</Kbd> in the Ollama app, <Kbd>sign in</Kbd> (free account), then choose a model ending in <span className="font-mono">cloud</span> in the app's model box and send it one message. It then appears here. They run on Ollama's servers: free up to hourly and weekly limits; some need a paid plan.</p>
                <p><Kbd>Or on this computer:</Kbd> choose a model without “cloud” in the app's model box; Ollama downloads it the first time you use it. Sizes are on each model's page at <a className="text-amber hover:underline" href="https://ollama.com/search" target="_blank" rel="noreferrer">ollama.com/search</a>.</p>
                <p className="text-ink-500">What suits your computer (the same models exist in Ollama under similar names):</p>
                <Picks s={s} />
              </Step>
              <Step n={4} title="Give models enough room to read (64k context)" state={states[3]} current={current === 3} detail="The board reads a lot of code at once; Ollama's default is too small.">
                <p>Ollama app → <Kbd>Settings</Kbd> → move <Kbd>Context length</Kbd> to <Kbd>64k</Kbd>. Cloud models ignore this.</p>
                {!ctxDone ? <Button size="sm" onClick={() => { setCtxDone(true); remember({ ctxDone: true }); }}>I've set it</Button> : null}
              </Step>
            </>
          )}
          <Step n={5} title={`Add ${app === "lmstudio" ? "LM Studio" : "Ollama"} to the board`} state={states[4]} current={current === 4} detail={a.added ? "Added: it shows in every pipeline's provider box." : "One click."}>
            {!a.added ? <Button size="sm" variant="primary" busy={adding} onClick={() => void addToBoard()}>Add {app === "lmstudio" ? "LM Studio" : "Ollama"}</Button> : null}
            <p className="text-ink-500">No key is needed{app === "lmstudio" ? " unless you switched on “Require authentication” in LM Studio" : ""}.</p>
          </Step>
          <Step n={6} title="Try it, then use it in a task" state={states[5]} current={current === 5} detail={test ? (test.ok ? `Works — answered in ${(test.latencyMs / 1000).toFixed(1)} s.` : `Did not work: ${test.error}`) : "Send it one tiny message."}>
            <Button size="sm" busy={testing} disabled={!a.added || !a.models.length} onClick={() => void runTest()}>Send a test message</Button>
            <p>
              Then open a task, go to <Kbd>Pipeline</Kbd>, and in a stage's first box choose <Kbd>{onBoard?.id ?? providerId}</Kbd>, then pick the model.
              The first answer can take a minute while the model loads.
            </p>
          </Step>
        </ol>
      ) : null}
    </div>
  );
}
