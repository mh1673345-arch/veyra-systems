import type { E164 } from "./types.js";

/**
 * Phone numbers, stored in exactly one shape: E.164.
 *
 * The rule that matters here is what this does NOT do. It never guesses a
 * country. A bare "03001234567" is a valid local number in several countries
 * and a different subscriber in each, so attaching a default country to it
 * would not be normalization — it would be picking a stranger to message. An
 * ambiguous number is rejected with an explanation instead.
 *
 * A business may configure a default country, and that is used only to say
 * "this looks like a local number, write it as +92…" — never applied
 * silently.
 */

export class InvalidPhoneNumberError extends Error {
  constructor(
    message: string,
    /** Safe to show an operator; contains no number of someone else's. */
    readonly reason: "empty" | "not_e164" | "ambiguous_local" | "too_short" | "too_long"
  ) {
    super(message);
    this.name = "InvalidPhoneNumberError";
  }
}

/** E.164: a leading +, a non-zero country code, 15 digits at the outside. */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** Only separators and the visual noise people type. Never digits. */
const PUNCTUATION = /[\s()\-. ‐-―]/g;

/**
 * Parses a number into E.164, or explains why it cannot.
 *
 * `defaultCountry` is deliberately not used to convert anything; it only
 * makes the rejection message concrete. Two arguments would be needed to do
 * that safely — a dialling plan and a trunk-prefix rule per country — and
 * guessing with neither is how a confirmation text reaches the wrong person.
 */
export function toE164(raw: string, options: { defaultCountry?: string | null } = {}): E164 {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new InvalidPhoneNumberError("A phone number is required.", "empty");

  const compact = trimmed.replace(PUNCTUATION, "");

  if (!compact.startsWith("+")) {
    const hint = options.defaultCountry
      ? ` This business's default country is ${options.defaultCountry}; write the number in full international form, for example +${exampleFor(options.defaultCountry)}.`
      : " Include the country code, for example +14155552671.";
    throw new InvalidPhoneNumberError(
      `"${redactForMessage(compact)}" has no country code, so Veyra cannot tell which country it belongs to.${hint}`,
      "ambiguous_local"
    );
  }

  const digits = compact.slice(1);
  if (!/^\d+$/.test(digits)) {
    throw new InvalidPhoneNumberError(
      "A phone number may only contain digits after the country code.",
      "not_e164"
    );
  }
  if (digits.length < 7) {
    throw new InvalidPhoneNumberError("That number is too short to be a phone number.", "too_short");
  }
  if (digits.length > 15) {
    throw new InvalidPhoneNumberError("That number is longer than E.164 allows (15 digits).", "too_long");
  }
  if (!E164_PATTERN.test(compact)) {
    throw new InvalidPhoneNumberError("That is not a valid international phone number.", "not_e164");
  }
  return compact;
}

/** True when the value is already canonical. Does not attempt to fix it. */
export function isE164(value: string): value is E164 {
  return E164_PATTERN.test(value);
}

/**
 * For the Console and for logs. Keeps the country code and the last two
 * digits, which is enough for an operator to recognise a number they already
 * know, and not enough to be a phone number.
 */
export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!isE164(value)) return "•••";
  const country = value.slice(0, Math.min(3, value.length - 4));
  const tail = value.slice(-2);
  return `${country}••••${tail}`;
}

/** Only ever used inside an error message about the input the caller just gave. */
function redactForMessage(value: string): string {
  return value.length <= 4 ? value : `${value.slice(0, 2)}…${value.slice(-2)}`;
}

/** An illustrative full number for a country, for error copy only. */
function exampleFor(country: string): string {
  const examples: Record<string, string> = {
    PK: "923001234567",
    GB: "447700900123",
    US: "14155552671",
    CA: "14155552671",
    AE: "971501234567",
    IN: "919812345678"
  };
  return examples[country.toUpperCase()] ?? "14155552671";
}
