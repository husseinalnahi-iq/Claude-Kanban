import { ANTHROPIC_PROVIDER_ID, type ModelEntry, type Provider } from "../../../../server/src/types.ts";
import { claudeModelStatus } from "../../../../server/src/engine/claudeModels.ts";
import { claudeOptions, claudeWarning, useClaudeModels } from "../../lib/claudeModels.ts";
import { useCatalogs } from "../../lib/catalog.ts";
import { useAppData } from "../../lib/store.tsx";
import { providerVisibleIn, visibleIn } from "../../lib/modelLists.ts";
import { ModelCombobox, type ModelOption } from "../ModelCombobox.tsx";

/** A provider's model as one id in the list: Claude's ids stay as they are. */
const SEP = "::";
export const chatPick = (provider: string, model: string) => (provider === ANTHROPIC_PROVIDER_ID ? model : `${provider}${SEP}${model}`);
export function readChatPick(id: string): { provider: string; model: string } {
  const at = id.indexOf(SEP);
  return at > 0 ? { provider: id.slice(0, at), model: id.slice(at + SEP.length) } : { provider: ANTHROPIC_PROVIDER_ID, model: id };
}

/** Only providers that speak Claude's API can run the chat: it runs inside Claude Code, with the board's tools (D301). */
export const chatCapable = (p: Provider) => p.enabled && p.kind === "anthropic-compatible";

/**
 * The chat's model: Claude, then every Claude-compatible provider's models, in one searchable list,
 * minus what Settings → Model lists hides from the chat (D300, D301).
 */
export function ChatModelPicker({ provider, model, onChange, models }: { provider: string; model: string; onChange: (v: { provider: string; model: string }) => void; models: ModelEntry[] }) {
  const { settings } = useAppData();
  const claude = useClaudeModels();
  const providers = (settings?.providers ?? []).filter((p) => chatCapable(p) && providerVisibleIn(settings, "chat", p.id, provider));
  const lists = useCatalogs(providers);
  const options: ModelOption[] = [
    ...claudeOptions(models, claude.result)
      .filter((o) => visibleIn(settings, "chat", ANTHROPIC_PROVIDER_ID, o.id, provider === ANTHROPIC_PROVIDER_ID ? model : undefined))
      .map((o) => ({ ...o, group: `Claude — ${o.group}` })),
    ...providers.flatMap((p) => {
      const listed = lists.get(p.id)?.models ?? p.models.map((m) => ({ id: m.id, label: m.label || m.id }));
      return listed
        .filter((m) => visibleIn(settings, "chat", p.id, m.id, provider === p.id ? model : undefined))
        .map((m) => ({ id: chatPick(p.id, m.id), label: `${m.label || m.id}`, group: `${p.label} · through Claude Code` }));
    }),
  ];
  const isClaude = provider === ANTHROPIC_PROVIDER_ID;
  return (
    <ModelCombobox
      value={chatPick(provider, model)}
      onChange={(id) => onChange(readChatPick(id))}
      options={options}
      loading={claude.loading && !claude.result}
      warn={isClaude ? claudeWarning(claudeModelStatus(model, claude.result)) : undefined}
    />
  );
}
