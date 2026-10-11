import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaWhatsAppProvider,
  metaWhatsAppConfig,
  missingMetaWhatsAppConfig,
  type MetaWhatsAppConfig
} from "../src/services/messaging/providers/metaWhatsApp.js";
import { whatsAppProviderFor, MessagingProviderError } from "../src/services/messaging/registry.js";

/**
 * The Meta WhatsApp adapter.
 *
 * Every request here is intercepted — nothing in this file reaches Meta, and
 * nothing in it claims a real message was sent. What it proves is that the
 * request Meta would receive is the one we think it is, that a refusal is
 * classified correctly rather than retried forever, and that the access
 * token cannot escape in an error string.
 */

const TOKEN = "EAAtest_token_do_not_use";

function config(): MetaWhatsAppConfig {
  return {
    accessToken: TOKEN,
    phoneNumberId: "123456789",
    businessAccountId: "987654321",
    graphVersion: "v21.0",
    baseUrl: "https://graph.facebook.com"
  };
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit)
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const sentBody = (spy: ReturnType<typeof stubFetch>) =>
  JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body)) as Record<string, never>;

const accepted = () =>
  new Response(
    JSON.stringify({
      messaging_product: "whatsapp",
      contacts: [{ input: "923001234567", wa_id: "923001234567" }],
      messages: [{ id: "wamid.TEST==", message_status: "accepted" }]
    }),
    { status: 200 }
  );

const session = {
  kind: "session" as const,
  to: "+923001234567",
  from: "+15550001111",
  body: "Your appointment with Colour pix is confirmed for 3 Oct at 10:00 AM."
};

const template = {
  kind: "template" as const,
  to: "+923001234567",
  from: "+15550001111",
  templateName: "hello_world",
  templateLanguage: "en_US",
  templateVariables: [] as string[],
  body: "Hello World"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configuration", () => {
  it("names exactly what is missing", () => {
    expect(missingMetaWhatsAppConfig({})).toEqual([
      "META_WHATSAPP_ACCESS_TOKEN",
      "META_WHATSAPP_PHONE_NUMBER_ID"
    ]);
    expect(missingMetaWhatsAppConfig({ META_WHATSAPP_ACCESS_TOKEN: TOKEN })).toEqual([
      "META_WHATSAPP_PHONE_NUMBER_ID"
    ]);
    // Whitespace is not configuration.
    expect(missingMetaWhatsAppConfig({ META_WHATSAPP_ACCESS_TOKEN: "  ", META_WHATSAPP_PHONE_NUMBER_ID: "1" })).toEqual(
      ["META_WHATSAPP_ACCESS_TOKEN"]
    );
  });

  it("defaults the graph version and url, and treats the business id as optional", () => {
    const resolved = metaWhatsAppConfig({
      META_WHATSAPP_ACCESS_TOKEN: TOKEN,
      META_WHATSAPP_PHONE_NUMBER_ID: "123"
    });
    expect(resolved?.graphVersion).toBe("v21.0");
    expect(resolved?.baseUrl).toBe("https://graph.facebook.com");
    expect(resolved?.businessAccountId).toBeNull();
    expect(metaWhatsAppConfig({})).toBeNull();
  });

  it("is selectable by name, and refuses when its credentials are absent", () => {
    delete process.env.META_WHATSAPP_ACCESS_TOKEN;
    delete process.env.META_WHATSAPP_PHONE_NUMBER_ID;
    expect(() => whatsAppProviderFor("meta")).toThrow(MessagingProviderError);
    expect(() => whatsAppProviderFor("meta")).toThrow(/META_WHATSAPP_ACCESS_TOKEN/);

    process.env.META_WHATSAPP_ACCESS_TOKEN = TOKEN;
    process.env.META_WHATSAPP_PHONE_NUMBER_ID = "123";
    const provider = whatsAppProviderFor("meta");
    expect(provider.name).toBe("meta");
    // A real vendor is never flagged as a development stand-in.
    expect(provider.simulated).toBe(false);

    delete process.env.META_WHATSAPP_ACCESS_TOKEN;
    delete process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  });
});

describe("request mapping", () => {
  it("sends free-form text inside a session, with link previews off", async () => {
    const spy = stubFetch(() => accepted());
    const result = await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session);

    expect(spy.mock.calls[0][0]).toBe("https://graph.facebook.com/v21.0/123456789/messages");
    const body = sentBody(spy);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      // Meta wants the number without a plus; Veyra stores E.164 everywhere else.
      to: "923001234567",
      type: "text",
      text: { preview_url: false, body: session.body }
    });

    expect(result).toMatchObject({ accepted: true, status: "accepted", retryable: false });
    expect(result.providerMessageId).toBe("wamid.TEST==");
    expect(result.detail).toContain("wamid.TEST==");
  });

  it("sends a template with no components when it declares no variables", async () => {
    const spy = stubFetch(() => accepted());
    await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(template);

    const body = sentBody(spy) as Record<string, { name?: string; language?: { code?: string } }>;
    expect(body.type).toBe("template");
    expect(body.template).toMatchObject({ name: "hello_world", language: { code: "en_US" } });
    // Meta rejects a components array a template did not ask for.
    expect(body.template).not.toHaveProperty("components");
  });

  it("maps declared variables to positional body parameters", async () => {
    const spy = stubFetch(() => accepted());
    await new MetaWhatsAppProvider(config()).sendWhatsAppMessage({
      ...template,
      templateName: "booking_confirmed",
      templateVariables: ["Colour pix", "3 Oct at 10:00 AM"]
    });

    const body = sentBody(spy) as unknown as {
      template: { components: { type: string; parameters: { type: string; text: string }[] }[] };
    };
    expect(body.template.components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Colour pix" },
          { type: "text", text: "3 Oct at 10:00 AM" }
        ]
      }
    ]);
  });

  it("authenticates with a bearer token and sends JSON", async () => {
    const spy = stubFetch(() => accepted());
    await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session);

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
  });
});

describe("failure classification", () => {
  it("treats a recipient outside the test allow-list as permanent", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "(#131030) Recipient phone number not in allowed list",
              code: 131030,
              error_data: { details: "Add the number in the dashboard." }
            }
          }),
          { status: 400 }
        )
    );

    const result = await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(template);
    expect(result.accepted).toBe(false);
    // Never retried: it will refuse just as firmly in an hour.
    expect(result.retryable).toBe(false);
    expect(result.detail).toContain("not in allowed list");
    expect(result.detail).toContain("Add the number in the dashboard.");
  });

  it("treats an expired token as permanent, not a blip", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Error validating access token: Session has expired", code: 190 } }),
          { status: 401 }
        )
    );
    const result = await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session);
    expect(result.retryable).toBe(false);
    expect(result.detail).toContain("Session has expired");
  });

  it("retries a rate limit and a server fault", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: "rate limited", code: 130429 } }), { status: 400 }));
    expect((await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session)).retryable).toBe(true);

    stubFetch(() => new Response(JSON.stringify({ error: { message: "oops" } }), { status: 503 }));
    expect((await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session)).retryable).toBe(true);

    stubFetch(() => new Response("{}", { status: 429 }));
    expect((await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session)).retryable).toBe(true);
  });

  it("reports a network failure as retryable rather than as a send", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND graph.facebook.com");
    });
    const result = await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session);
    expect(result).toMatchObject({ accepted: false, retryable: true });
    expect(result.detail).toMatch(/could not be reached/i);
  });

  it("says plainly when a send was cancelled by a lost claim lease", async () => {
    const controller = new AbortController();
    stubFetch(async () => {
      controller.abort();
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    });

    const result = await new MetaWhatsAppProvider(config()).sendWhatsAppMessage({
      ...session,
      signal: controller.signal
    });
    expect(result.detail).toMatch(/lost its claim lease/);
  });

  it("never lets the access token into an error string", async () => {
    // A proxy echoing the Authorization header back is exactly how a token
    // ends up in a log file.
    stubFetch(
      () => new Response(JSON.stringify({ error: { message: `Bad auth: Bearer ${TOKEN}` } }), { status: 401 })
    );
    const result = await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session);
    expect(result.detail).not.toContain(TOKEN);
    expect(result.detail).toContain("[redacted]");
  });

  it("bounds the reason instead of pasting a whole payload", async () => {
    stubFetch(() => new Response("x".repeat(5000), { status: 500 }));
    const result = await new MetaWhatsAppProvider(config()).sendWhatsAppMessage(session);
    expect(result.detail.length).toBeLessThanOrEqual(240);
  });
});

describe("health", () => {
  it("reports the sender when Meta answers", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ display_phone_number: "+1 555 000 1111", verified_name: "Veyra Test", quality_rating: "GREEN" }),
          { status: 200 }
        )
    );
    const health = await new MetaWhatsAppProvider(config()).health();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("Veyra Test");
  });

  it("names an expired temporary token rather than saying something went wrong", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ error: { message: "Session has expired", code: 190 } }), { status: 401 })
    );
    const health = await new MetaWhatsAppProvider(config()).health();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/temporary token expires after 24 hours/i);
    expect(health.detail).not.toContain(TOKEN);
  });
});
