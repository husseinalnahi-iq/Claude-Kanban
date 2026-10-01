import type { Provider, Settings } from "../types.ts";
import type { SecretStore } from "../secrets.ts";
import type { ImageConfig } from "./images.ts";
import { codexModels, codexPicture, codexStatus, pictureModel } from "./providers/codexLocal.ts";
import { childEnv } from "./providers/cli/env.ts";
import { codexPlanProvider } from "./codexLink.ts";

/** Codex as the account it is signed in to, with no API key in its environment (D293). */
const SIGNED_IN: Provider = { id: "codex-pictures", label: "Codex", kind: "cli", enabled: true, authRef: "", models: [], cli: { preset: "codex", auth: "login" }, mayEditFiles: false };

/**
 * Codex's part of the picture settings, for the board's runs and for the image tool in your own Claude
 * Code alike (D297): null unless Codex makes the pictures, is on the board on a ChatGPT plan, and is
 * signed in with ChatGPT here — a Codex signed in with an API key would bill the API account. The board
 * check comes first, so a board without Codex never starts Codex to ask (D303).
 */
export async function codexImagePart(
  s: Pick<Settings, "imageProvider" | "imageModel" | "codexPictures" | "providers">,
  secrets: SecretStore,
  remember: (works: boolean, detail: string, version: string | null) => void,
): Promise<ImageConfig["codex"]> {
  if (s.imageProvider !== "codex") return null;
  if (!codexPlanProvider(s, (n) => secrets.has(n))?.enabled) return null;
  const st = await codexStatus();
  if (!st.found || st.signedIn !== "chatgpt") return null;
  const model = s.imageModel || pictureModel((await codexModels("login")) ?? []);
  if (!model) return null;
  return {
    model,
    version: st.version,
    pictures: s.codexPictures,
    make: (req) => codexPicture({ ...req, model }, { env: childEnv(SIGNED_IN, secrets, {}) }),
    remember: (works, detail) => remember(works, detail, st.version),
  };
}
