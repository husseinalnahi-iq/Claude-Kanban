import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

/**
 * Renders agent/user markdown; output is sanitised because transcripts are untrusted text.
 * `breaks`: a single line break is a line break — for text a person typed into a box, where
 * "request:" on its own line should not run into the line above (docs/DECISIONS.md D195).
 */
export function Markdown({ text, className = "", breaks = false }: { text: string; className?: string; breaks?: boolean }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? "", { async: false, breaks }) as string), [text, breaks]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
