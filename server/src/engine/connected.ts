/**
 * The systems people connect to Claude (claude.ai connectors and the usual MCP servers), by the words
 * they use for them. Pure and shared with the web: the chat offers its connectors switch when a
 * message names one of these while the switch is off, without a model call (D349).
 */
const SYSTEMS: [name: string, words: RegExp][] = [
  ["Slack", /\bslack\b/i],
  ["Gmail", /\bgmail\b/i],
  ["your email", /\b(?:e-?mails?|inbox|mailbox)\b/i],
  ["your calendar", /\b(?:calendar|google meet)\b/i],
  ["Google Drive", /\b(?:google drive|gdrive)\b/i],
  ["Google Sheets", /\bgoogle sheets?\b/i],
  ["Google Docs", /\bgoogle docs?\b/i],
  ["Notion", /\bnotion\b/i],
  ["Jira", /\bjira\b/i],
  ["Confluence", /\bconfluence\b/i],
  ["Linear", /\blinear\b(?! (?:regression|algebra|time|search|scale))/i],
  ["Asana", /\basana\b/i],
  ["Trello", /\btrello\b/i],
  ["GitHub", /\bgithub\b/i],
  ["GitLab", /\bgitlab\b/i],
  ["Figma", /\bfigma\b/i],
  ["HubSpot", /\bhubspot\b/i],
  ["Salesforce", /\bsalesforce\b/i],
  ["Zendesk", /\bzendesk\b/i],
  ["Intercom", /\bintercom\b/i],
  ["Stripe", /\bstripe\b/i],
  ["Airtable", /\bairtable\b/i],
  ["Supabase", /\bsupabase\b/i],
  ["Vercel", /\bvercel\b/i],
  ["Dropbox", /\bdropbox\b/i],
  ["CloudSync", /\bcloudsync\b/i],
  ["SharePoint", /\bsharepoint\b/i],
  ["Microsoft Teams", /\bms teams\b|\bmicrosoft teams\b/i],
  ["Discord", /\bdiscord\b/i],
  ["Telegram", /\btelegram\b/i],
  ["WhatsApp", /\bwhatsapp\b/i],
  ["Zoom", /\bzoom\b(?! (?:in|out|level))/i],
  ["your MCP server", /\bmcp\b/i],
];

/**
 * The first connected system a message names, as the chat should call it ("Slack", "your email"), or
 * null. A plain "sheet" or "doc" is not one: a spreadsheet the user attached would match.
 */
export function connectedSystemIn(text: string): string | null {
  for (const [name, words] of SYSTEMS) if (words.test(text)) return name;
  return null;
}
