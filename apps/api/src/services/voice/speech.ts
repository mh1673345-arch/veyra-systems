/**
 * Making a written answer speakable.
 *
 * The ticket for this phase is explicit that response shortening and
 * pronunciation rules should be driven by what real calls reveal, not by
 * guesswork — so this starts deliberately small. It changes *presentation*
 * only: never a price, a time, a service name or any other fact, and never the
 * stored value. The same structured answer goes to the screen and to the
 * speaker; only the shape differs.
 *
 * Expect this to grow once real calls show what actually sounds wrong.
 */

/**
 * Text a speech engine can read cleanly.
 *
 * Only two rules so far, both safe and both about layout rather than content:
 * line breaks and bullet markers become sentence breaks (a synthesiser reads
 * them as odd pauses or, worse, says "dash"), and runs of whitespace collapse.
 */
export function spokenForm(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    // A bullet at the start of a line is layout, not something to pronounce.
    .replace(/^\s*[-*•]\s+/gm, "")
    // A line break between sentences should sound like a full stop, not a gap.
    .replace(/\n+/g, (match, offset: number, whole: string) => {
      const before = whole.slice(0, offset).trimEnd();
      return before.endsWith(".") || before.endsWith("?") || before.endsWith("!") ? " " : ". ";
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Whether a spoken reply is long enough to be worth shortening.
 *
 * Not used to truncate anything: a caller being told half a price is worse
 * than a caller hearing a long sentence. It exists so real calls can be
 * reviewed against a number instead of an impression, and so §37's
 * channel-aware formatter has somewhere to hook in when there is evidence for
 * what to cut.
 */
export const LONG_SPOKEN_REPLY_CHARS = 320;

export function isLongForSpeech(text: string): boolean {
  return spokenForm(text).length > LONG_SPOKEN_REPLY_CHARS;
}
