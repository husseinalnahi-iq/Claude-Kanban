import { ATTACHMENT_TYPES } from "../../../server/src/types.ts";

/** What a file picker offers: every type the board's upload route takes. */
export const ATTACH_ACCEPT = Object.keys(ATTACHMENT_TYPES).join(",");

/** File → base64 without the `data:…;base64,` prefix, which is what the upload route expects. */
export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.readAsDataURL(file);
  });
}

/** A pasted screenshot comes without a name; the upload route needs one with an extension. */
export const fileName = (f: File) => f.name || "pasted image.png";
