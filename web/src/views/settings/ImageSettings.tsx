import { useEffect, useState } from "react";
import type { ImageProvider, ImageStatus } from "../../../../server/src/types.ts";
import { api, type ImageTry } from "../../lib/api.ts";
import { Button, ErrorLine, Field, inputCls, useAction } from "../../components/ui.tsx";
import { ModelCombobox } from "../../components/ModelCombobox.tsx";
import { useAppData } from "../../lib/store.tsx";
import { useCatalog } from "../../lib/catalog.ts";
import { visibleIn } from "../../lib/modelLists.ts";
import { useWs } from "../../lib/ws.ts";

const MAKER: Record<string, string> = { codex: "Codex on your ChatGPT plan", cloudflare: "Cloudflare Workers AI", pollinations: "Pollinations.ai" };

const POLLINATIONS_KEY = "POLLINATIONS_API_KEY";
const CLOUDFLARE_TOKEN = "CLOUDFLARE_API_TOKEN";

/** A write-only key field: the board only ever says whether one is set. */
function KeyField({ name, isSet, placeholder, onChanged }: { name: string; isSet: boolean; placeholder: string; onChanged: (s: ImageStatus) => void }) {
  const [value, setValue] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          className={`${inputCls} font-mono`}
          placeholder={isSet ? "•••••••• (set — paste to replace)" : placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button size="sm" busy={busy} disabled={!value.trim()} onClick={() => run(async () => { onChanged(await api.setImageSecret(name, value.trim())); setValue(""); })}>
          Save key
        </Button>
        {isSet ? (
          <Button size="sm" variant="ghost" busy={busy} onClick={() => run(async () => onChanged(await api.deleteImageSecret(name)))}>
            Clear
          </Button>
        ) : null}
      </div>
      <div className="mt-1 text-[11px] text-ink-500">
        {isSet ? <span className="text-moss">Key is set.</span> : <span className="text-ink-400">No key.</span>} Stored in the board's own secrets file, never in settings; the
        environment variable <span className="font-mono">{name}</span> works too.
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/** Try it: one small image from exactly what is set now, shown here, so a wrong key shows up before a task depends on it. */
function ImageTryButton({ saved, ready }: { saved: boolean; ready: boolean }) {
  const [r, setR] = useState<ImageTry | null>(null);
  const { busy, run } = useAction();
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          busy={busy}
          disabled={!saved || !ready}
          title={!saved ? "Save settings first: the test uses the saved settings" : ready ? "Makes one small image with the provider and key set here" : "No picture maker is ready yet"}
          onClick={() =>
            run(async () => {
              setR(null);
              try {
                setR(await api.testImage());
              } catch (err) {
                setR({ ok: false, dataUrl: null, provider: "", latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
              }
            })
          }
        >
          Try it
        </Button>
        <span className="text-[11px] text-ink-500">{!saved ? "save first, then try it" : ready ? "makes one small picture (10 seconds to a minute)" : "once a picture maker is ready"}</span>
      </div>
      {r ? (
        <div className={`mt-2 rounded-md border px-3 py-2 text-[12px] ${r.ok ? "border-moss/40 text-ink-300" : "border-rust/50 text-rust"}`}>
          {r.ok && r.dataUrl ? (
            <>
              <div className="mb-1.5 text-moss">
                It works · {(r.latencyMs / 1000).toFixed(1)} s · {MAKER[r.provider] ?? r.provider}
              </div>
              <img src={r.dataUrl} alt="A test image made just now" className="max-h-64 rounded-md border border-ink-800" />
            </>
          ) : (
            <>Could not make an image: {r.error}</>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Settings → Images. The provider and the Cloudflare account id are saved with the page's Save button
 * (they travel with settings); the keys save on their own buttons and never come back to the browser.
 */
export function ImageSettings({
  provider, setProvider, accountId, setAccountId, imageModel, setImageModel, saved,
}: {
  provider: ImageProvider;
  setProvider: (p: ImageProvider) => void;
  accountId: string;
  setAccountId: (v: string) => void;
  imageModel: string;
  setImageModel: (v: string) => void;
  saved: boolean;
}) {
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const { error, run } = useAction();
  const { settings } = useAppData();
  const refresh = () => void run(async () => setStatus(await api.imageStatus()));
  useEffect(refresh, [saved, settings?.codexPictures?.works, settings?.codexPictures?.version]);
  // Signing Codex in from Setup or Providers changes what this says.
  useWs((m) => {
    if (m.type === "codex.updated") refresh();
  });
  const codexEntry = settings?.providers.find((p) => p.enabled && p.kind === "cli" && p.cli?.preset === "codex" && p.cli.auth !== "api-key");
  const codexList = useCatalog(provider === "codex" ? codexEntry : undefined);
  const codex = status?.codex;
  const codexWhy = !codex ? "" : !codex.found ? "Codex is not on this computer yet (Setup → Codex)." : codex.signedIn !== "chatgpt" ? "Codex is not signed in with ChatGPT yet (Setup → Codex → Sign in)." : "";

  const options: { id: ImageProvider; label: string; blurb: string }[] = [
    {
      id: "codex",
      label: "Codex · your ChatGPT plan — no extra cost",
      blurb:
        "Codex's own image model, on the ChatGPT plan you are signed in to. Until Codex is on the board and can make pictures on this computer, tasks simply run without a picture tool." +
        (codexWhy ? ` ${codexWhy}` : ""),
    },
    { id: "cloudflare", label: "Cloudflare Workers AI — no watermark, free daily allowance", blurb: "FLUX.1 schnell on a free Cloudflare account (no card): roughly 500 images a day, 1024×1024. Needs your account id and an API token with the Workers AI permission." },
    { id: "pollinations", label: "Pollinations.ai — with your key", blurb: "Needs your key from enter.pollinations.ai: without one its free tier turns requests away, so it is never used without." },
    { id: "off", label: "Off", blurb: "Runs get no image tool and are told nothing about pictures. A task that needs one leaves a placeholder." },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {options.filter((o) => o.id === "off" || visibleIn(settings, "pictures", "pictures", o.id, provider)).map((o) => (
          <label key={o.id} className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="radio" name="image-provider" className="mt-1 accent-amber" checked={provider === o.id} onChange={() => setProvider(o.id)} />
            <span>
              {o.label}
              <span className="block text-[11.5px] text-ink-400">{o.blurb}</span>
            </span>
          </label>
        ))}
      </div>

      {provider === "codex" ? (
        <>
          <Field label="Codex model for pictures" hint="Any of your plan's models can call Codex's image tool; the newest Luna is the cheapest. Leave it on automatic to follow newer Lunas.">
            <ModelCombobox
              value={imageModel}
              onChange={setImageModel}
              loading={codexList.loading}
              placeholder="Automatic (the newest Luna)"
              options={[
                { id: "", label: "Automatic — the newest Luna", group: "Codex" },
                ...(codexList.result?.models ?? [])
                  .filter((m) => visibleIn(settings, "pictures", codexEntry?.id, m.id, imageModel))
                  .map((m) => ({ id: m.id, label: m.label, group: "Your ChatGPT plan's models", tag: m.warning })),
              ]}
              note={codexEntry ? null : "Codex is not on the board yet: Setup → Codex → Use it adds it."}
            />
          </Field>
          {codex?.pictures.works === false ? (
            <div className="flex items-start gap-2 rounded-md border border-amber/40 bg-amber/5 px-3 py-2 text-[12px] text-amber">
              <span className="flex-1">
                {codex.pictures.detail || "Codex could not make a picture on this computer."} Until it can, tasks run without a picture tool.
                <span className="block text-[11px] text-ink-400">Checked with {codex.pictures.version ?? "this Codex"}; a newer Codex is tried again by itself.</span>
              </span>
              <Button size="sm" onClick={() => run(async () => { await api.codexPicturesReset(); setStatus(await api.imageStatus()); })}>Check again</Button>
            </div>
          ) : null}
        </>
      ) : null}

      {provider === "pollinations" ? (
        <Field label="Pollinations key" hint="Needed: sign in at enter.pollinations.ai and create a secret key (sk_…).">
          <KeyField name={POLLINATIONS_KEY} isSet={status?.hasPollinationsKey ?? false} placeholder="sk_…" onChanged={setStatus} />
        </Field>
      ) : null}

      {provider === "cloudflare" ? (
        <>
          <Field label="Cloudflare account id" hint="Cloudflare dashboard → Workers AI → Use REST API shows it. Letters and digits; saved with Save settings.">
            <input className={`${inputCls} font-mono`} value={accountId} onChange={(e) => setAccountId(e.target.value.trim())} placeholder="32 characters" />
          </Field>
          <Field label="Cloudflare API token" hint="Same page → Create a Workers AI API token (or any token with Workers AI read and edit).">
            <KeyField name={CLOUDFLARE_TOKEN} isSet={status?.hasCloudflareToken ?? false} placeholder="paste the token" onChanged={setStatus} />
          </Field>
        </>
      ) : null}

      {provider !== "off" ? (
        <>
          <div className="text-[12px]">
            {status ? (
              status.ready ? (
                <span className="text-moss">Ready · {status.detail}</span>
              ) : codex?.pictures.works === false && provider === "codex" ? null : (
                // The amber box above already says why Codex cannot.
                <span className="text-amber">{status.detail}</span>
              )
            ) : null}
            {!saved ? <span className="ml-2 text-ink-500">(unsaved changes)</span> : null}
          </div>
          <ImageTryButton saved={saved} ready={Boolean(status?.ready)} />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-ink-500">
                <tr><th className="py-1 pr-3 font-medium">Making an image</th><th className="py-1 pr-3 font-medium">Autonomous</th><th className="py-1 font-medium">Supervised</th></tr>
              </thead>
              <tbody className="text-ink-300">
                <tr className="border-t border-ink-800">
                  <td className="py-1 pr-3">Saved inside the task's folder (never above it, never over an existing file); a copy lands in the task's Files tab</td>
                  <td className="py-1 pr-3 text-moss">yes</td>
                  <td className="py-1">approval card, showing the description</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="rounded-md border border-ink-800 bg-ink-950/60 p-3">
            <div className="text-[12.5px] text-ink-200">The same tool in your own Claude Code</div>
            <div className="mt-0.5 text-[11.5px] text-ink-400">
              Run this once in a terminal. Claude Code then has <span className="font-mono">generate_image</span> in every project, using the provider and key set here.
              Setup can run it for you too. Undo with <span className="font-mono">claude mcp remove images</span>.
            </div>
            {status ? (
              <div className="mt-2 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded border border-ink-800 bg-ink-950 px-2.5 py-1.5 font-mono text-[11.5px] text-ink-200">{status.claudeCodeCommand}</pre>
                <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(status.claudeCodeCommand).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}
