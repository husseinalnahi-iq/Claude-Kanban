import { useEffect, useState } from "react";
import type { ImageProvider, ImageStatus } from "../../../../server/src/types.ts";
import { api, type ImageTry } from "../../lib/api.ts";
import { Button, ErrorLine, Field, inputCls, useAction } from "../../components/ui.tsx";

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
function ImageTryButton({ saved }: { saved: boolean }) {
  const [r, setR] = useState<ImageTry | null>(null);
  const { busy, run } = useAction();
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          busy={busy}
          disabled={!saved}
          title={saved ? "Makes one small image with the provider and key set here" : "Save settings first: the test uses the saved settings"}
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
        <span className="text-[11px] text-ink-500">{saved ? "makes one small picture (10–30 seconds)" : "save first, then try it"}</span>
      </div>
      {r ? (
        <div className={`mt-2 rounded-md border px-3 py-2 text-[12px] ${r.ok ? "border-moss/40 text-ink-300" : "border-rust/50 text-rust"}`}>
          {r.ok && r.dataUrl ? (
            <>
              <div className="mb-1.5 text-moss">
                It works · {(r.latencyMs / 1000).toFixed(1)} s · {r.provider === "cloudflare" ? "Cloudflare Workers AI" : "Pollinations.ai"}
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
  provider, setProvider, accountId, setAccountId, saved,
}: { provider: ImageProvider; setProvider: (p: ImageProvider) => void; accountId: string; setAccountId: (v: string) => void; saved: boolean }) {
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const { error, run } = useAction();
  useEffect(() => void run(async () => setStatus(await api.imageStatus())), [saved]);

  const options: { id: ImageProvider; label: string; blurb: string }[] = [
    { id: "pollinations", label: "Pollinations.ai — works now, nothing to set up", blurb: "Free, no account. Without a key: a small watermark and about one image every 15 seconds. A free key (enter.pollinations.ai) removes both." },
    { id: "cloudflare", label: "Cloudflare Workers AI — no watermark, free daily allowance", blurb: "FLUX.1 schnell on a free Cloudflare account (no card): roughly 500 images a day, 1024×1024. Needs your account id and an API token with the Workers AI permission." },
    { id: "off", label: "Off", blurb: "Runs get no image tool. A task that needs a picture leaves a placeholder or asks you." },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {options.map((o) => (
          <label key={o.id} className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="radio" name="image-provider" className="mt-1 accent-amber" checked={provider === o.id} onChange={() => setProvider(o.id)} />
            <span>
              {o.label}
              <span className="block text-[11.5px] text-ink-400">{o.blurb}</span>
            </span>
          </label>
        ))}
      </div>

      {provider === "pollinations" ? (
        <Field label="Pollinations key (optional)" hint="Removes the watermark and the 15-second wait. Free: sign in at enter.pollinations.ai and create a secret key (sk_…).">
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
              status.ready ? <span className="text-moss">Ready · {status.detail}</span> : <span className="text-amber">{status.detail}</span>
            ) : null}
            {!saved ? <span className="ml-2 text-ink-500">(unsaved changes)</span> : null}
          </div>
          <ImageTryButton saved={saved && Boolean(status?.ready)} />
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
