import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

/**
 * What a run, a chat reply or a repo's CLAUDE.md may put on the page: text and structure, nothing that
 * acts. DOMPurify's defaults stop scripts but keep the rest of HTML, and each of these was a way round
 * the board's own rules for text written by a model that may have read a hostile page:
 *  - a form posting to the board's own API (one click on "Show full report" approves its own work);
 *  - a style block or class names, to cover the board or hide a warning;
 *  - a picture on another site, fetched the moment the text is shown — a way to send data out with
 *    no approval card, even in a supervised run.
 */
const CLEAN = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "dialog", "picture", "source", "video", "audio", "track"],
  FORBID_ATTR: ["style", "class", "id", "name", "srcset", "background", "poster", "action", "formaction", "popover", "popovertarget"],
};

/** Pictures the board itself serves, or that travel inside the text. */
const ownImage = (src: string | null) => !!src && (/^\/api\/attachments\/[\w-]+\/raw$/.test(src) || /^data:image\//i.test(src));

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    // A link inside a transcript must not take the board away from the tab it is running in.
    if (!node.getAttribute("href")!.startsWith("#")) node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  } else if (node.tagName === "IMG" && !ownImage(node.getAttribute("src"))) {
    // Shown as a link instead: opening it is then your choice, not the text's.
    const src = node.getAttribute("src") ?? "";
    const link = document.createElement("a");
    if (/^https?:\/\//i.test(src)) {
      link.href = src;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    link.textContent = node.getAttribute("alt") || src || "image";
    node.replaceWith(link);
  } else if (node.tagName === "INPUT") {
    // Only the tick boxes of a task list ("- [x] done") are kept, and they cannot be changed.
    if (node.getAttribute("type") !== "checkbox") node.remove();
    else node.setAttribute("disabled", "");
  }
});

/**
 * Renders agent/user markdown; output is sanitised because transcripts are untrusted text.
 * `breaks`: a single line break is a line break — for text a person typed into a box, where
 * "request:" on its own line should not run into the line above (docs/DECISIONS.md D195).
 */
export function Markdown({ text, className = "", breaks = false }: { text: string; className?: string; breaks?: boolean }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? "", { async: false, breaks }) as string, CLEAN), [text, breaks]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
