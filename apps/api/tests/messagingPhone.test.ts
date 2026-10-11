import { describe, expect, it } from "vitest";
import { InvalidPhoneNumberError, isE164, maskPhone, toE164 } from "../src/services/messaging/phone.js";
import {
  formatForChannel,
  isLongForChannel,
  smsForm,
  whatsAppForm
} from "../src/services/messaging/format.js";

/**
 * Phone normalization and channel formatting.
 *
 * The important assertions here are the refusals. A number this code cannot
 * be certain about must not be quietly turned into one it can, because the
 * result is a message to a real stranger.
 */

describe("E.164 normalization", () => {
  it("accepts international numbers and strips only punctuation", () => {
    expect(toE164("+14155552671")).toBe("+14155552671");
    expect(toE164("+1 (415) 555-2671")).toBe("+14155552671");
    expect(toE164("  +44 7700 900123  ")).toBe("+447700900123");
    expect(toE164("+92-300-1234567")).toBe("+923001234567");
    // Non-breaking spaces and typographic hyphens come from copy-paste.
    expect(toE164("+92 300‐1234567")).toBe("+923001234567");
  });

  it("refuses a local number rather than guessing a country", () => {
    expect(() => toE164("03001234567")).toThrow(InvalidPhoneNumberError);
    expect(() => toE164("4155552671")).toThrow(/no country code/i);

    // Even with a default country configured, it is refused — the default
    // makes the message concrete, it does not convert the number.
    try {
      toE164("03001234567", { defaultCountry: "PK" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPhoneNumberError);
      expect((error as InvalidPhoneNumberError).reason).toBe("ambiguous_local");
      expect((error as Error).message).toContain("+923001234567");
    }
  });

  it("rejects everything that is not a phone number", () => {
    const cases: [string, string][] = [
      ["", "empty"],
      ["   ", "empty"],
      ["+0123456789", "not_e164"],
      ["+1abc5552671", "not_e164"],
      ["+123", "too_short"],
      [`+1${"2".repeat(20)}`, "too_long"]
    ];
    for (const [input, reason] of cases) {
      try {
        toE164(input);
        throw new Error(`"${input}" should have been refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidPhoneNumberError);
        expect((error as InvalidPhoneNumberError).reason).toBe(reason);
      }
    }
  });

  it("never reports a number it would not accept as valid", () => {
    expect(isE164("+14155552671")).toBe(true);
    expect(isE164("14155552671")).toBe(false);
    expect(isE164("+0123456789")).toBe(false);
  });

  it("masks numbers so an operator can recognise one without reading it", () => {
    const masked = maskPhone("+923001234567");
    expect(masked).toBe("+92••••67");
    expect(masked).not.toContain("300123");
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("not-a-number")).toBe("•••");
  });
});

describe("SMS formatting", () => {
  it("strips markdown a handset cannot render", () => {
    const shaped = smsForm("**Teeth whitening** is `$250`.\n\n- Monday\n- Tuesday");
    expect(shaped.text).toBe("Teeth whitening is $250.\nMonday\nTuesday");
    expect(shaped.text).not.toContain("*");
    expect(shaped.text).not.toContain("`");
  });

  it("counts GSM-7 segments, and notices when one character forces UCS-2", () => {
    const plain = smsForm("Your appointment is confirmed for Monday at 3pm.");
    expect(plain.encoding).toBe("gsm7");
    expect(plain.segments).toBe(1);
    expect(plain.multipart).toBe(false);

    // An emoji drops the whole message to 70 characters a part.
    const emoji = smsForm("Your appointment is confirmed \u{1F600}");
    expect(emoji.encoding).toBe("ucs2");

    // Curly quotes and em dashes are replaced rather than allowed to halve
    // the capacity of every message.
    const typographic = smsForm("It’s confirmed — see you then…");
    expect(typographic.encoding).toBe("gsm7");
    expect(typographic.text).toBe("It's confirmed - see you then...");
  });

  it("reports a long message as multipart instead of truncating it", () => {
    const long = "A".repeat(400);
    const shaped = smsForm(long);
    expect(shaped.segments).toBeGreaterThan(1);
    expect(shaped.multipart).toBe(true);
    // Nothing is cut: half a price is worse than two texts.
    expect(shaped.text).toHaveLength(400);
    expect(isLongForChannel("sms", long)).toBe(true);
  });
});

describe("WhatsApp formatting", () => {
  it("translates markdown bold into WhatsApp's own, and keeps bullets", () => {
    const shaped = whatsAppForm("## Prices\n\n**Whitening** is $250.\n- Monday\n- Tuesday");
    expect(shaped).toContain("*Whitening* is $250.");
    expect(shaped).not.toContain("**");
    expect(shaped).not.toContain("##");
    expect(shaped).toContain("• Monday");
  });

  it("routes through one entry point per channel", () => {
    expect(formatForChannel("sms", "**hi**")).toBe("hi");
    expect(formatForChannel("whatsapp", "**hi**")).toBe("*hi*");
  });
});

describe("formatting changes presentation only", () => {
  it("never alters a price, a time or a service name", () => {
    const answer = "**Teeth whitening** is $250 and takes 45 minutes. Next slot: Monday 3:00pm.";
    for (const channel of ["sms", "whatsapp"] as const) {
      const shaped = formatForChannel(channel, answer);
      expect(shaped).toContain("$250");
      expect(shaped).toContain("45 minutes");
      expect(shaped).toContain("3:00pm");
      expect(shaped).toContain("Teeth whitening");
    }
  });
});
