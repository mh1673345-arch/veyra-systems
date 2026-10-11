import type { MessagingChannel } from "@veyra/shared";

/**
 * Making a written answer fit a messaging channel.
 *
 * Presentation only, exactly like the voice adapter next door: never a price,
 * a time, a service name, or any other fact, and never the stored value. The
 * same answer from the same Reception brain goes to the screen, the speaker
 * and the handset — only the shape differs.
 *
 * Nothing here truncates. A customer receiving half a price is worse than one
 * receiving two texts, so long replies are reported as long and the decision
 * is left to the caller rather than silently cutting a sentence in half.
 */

/**
 * One GSM-7 SMS segment is 160 characters, and 153 per part once a message is
 * split. Anything with a non-GSM character (an em dash, an emoji, most
 * curly quotes) drops the whole message to UCS-2 at 70 / 67.
 */
export const SMS_SINGLE_SEGMENT_GSM = 160;
export const SMS_MULTI_SEGMENT_GSM = 153;
export const SMS_SINGLE_SEGMENT_UCS2 = 70;
export const SMS_MULTI_SEGMENT_UCS2 = 67;

/** WhatsApp's own limit is far higher; this is a readability line, not a hard one. */
export const WHATSAPP_COMFORTABLE_CHARS = 1000;

/** The GSM 03.38 basic set, plus the extension characters that cost two septets. */
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

/** Characters people paste constantly that would force UCS-2 for no benefit. */
const TYPOGRAPHIC_REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/—/g, "-"],
  [/–/g, "-"],
  [/…/g, "..."],
  [/ /g, " "]
];

export interface SmsShape {
  text: string;
  encoding: "gsm7" | "ucs2";
  /** How many messages a carrier would bill and a handset would stitch. */
  segments: number;
  /** True when it will arrive as more than one text. Never truncated. */
  multipart: boolean;
}

/**
 * SMS form: plain, unadorned, no markdown, no bullet glyphs.
 *
 * Markdown is the important one. A handset renders none of it, so asterisks
 * around a price arrive as literal asterisks and read like noise.
 */
export function smsForm(text: string): SmsShape {
  let out = text.replace(/\r\n/g, "\n");
  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) out = out.replace(pattern, replacement);

  out = out
    // Bullets are layout; a plain line reads the same and costs less.
    .replace(/^\s*[-*•]\s+/gm, "")
    // Emphasis markers a handset cannot render.
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, "$1$2")
    .replace(/(^|\s)_(\S[^_]*?)_(?=\s|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    // Collapse blank lines: vertical space costs characters and buys nothing.
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  const encoding = isGsm7(out) ? "gsm7" : "ucs2";
  const single = encoding === "gsm7" ? SMS_SINGLE_SEGMENT_GSM : SMS_SINGLE_SEGMENT_UCS2;
  const multi = encoding === "gsm7" ? SMS_MULTI_SEGMENT_GSM : SMS_MULTI_SEGMENT_UCS2;
  const length = encoding === "gsm7" ? gsm7Length(out) : out.length;
  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi);

  return { text: out, encoding, segments, multipart: segments > 1 };
}

/**
 * WhatsApp form: keeps light structure, because WhatsApp renders a little of
 * it, but assumes nothing beyond what the app definitely supports. Headings,
 * tables and links-with-labels are not among them.
 */
export function whatsAppForm(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) out = out.replace(pattern, replacement);

  return out
    // Markdown bold is **x**; WhatsApp bold is *x*.
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // Headings have no equivalent, so keep the words and drop the hashes.
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    // A bullet list is fine here, but normalise the glyph to one WhatsApp shows.
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** The one entry point a channel should use. */
export function formatForChannel(channel: MessagingChannel, text: string): string {
  return channel === "sms" ? smsForm(text).text : whatsAppForm(text);
}

export function isLongForChannel(channel: MessagingChannel, text: string): boolean {
  return channel === "sms"
    ? smsForm(text).multipart
    : whatsAppForm(text).length > WHATSAPP_COMFORTABLE_CHARS;
}

function isGsm7(text: string): boolean {
  for (const character of text) {
    if (!GSM_BASIC.includes(character) && !GSM_EXTENDED.includes(character)) return false;
  }
  return true;
}

/** Extension characters occupy two septets each. */
function gsm7Length(text: string): number {
  let length = 0;
  for (const character of text) length += GSM_EXTENDED.includes(character) ? 2 : 1;
  return length;
}
