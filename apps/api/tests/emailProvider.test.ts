import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleEmailProvider,
  createEmailProvider,
  notificationIdempotencyKey,
  resolveEmailProviderChoice,
  setEmailProvider
} from "../src/services/notifications/providers.js";
import {
  type ResendConfig,
  ResendEmailProvider,
  missingResendConfig,
  resendConfig
} from "../src/services/notifications/resendProvider.js";
import { validateStartupConfig, ConfigurationError } from "../src/config/startup.js";

/**
 * Email provider selection and the Resend adapter.
 *
 * Nothing here proves real delivery — every request is intercepted. What it
 * does prove is that the right provider is chosen, that a half-configured
 * server fails closed instead of silently dropping mail, and that the request
 * Resend would receive is the one we think it is.
 */

const API_KEY = "re_test_key_do_not_use";

function config(): ResendConfig {
  return {
    apiKey: API_KEY,
    from: "onboarding@resend.dev",
    replyTo: null,
    endpoint: "https://api.resend.com/emails"
  };
}

/** One intercepted fetch, so no test can reach the network. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit)
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sentBody(spy: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const init = spy.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentHeaders(spy: ReturnType<typeof stubFetch>): Record<string, string> {
  const init = spy.mock.calls[0][1] as RequestInit;
  return init.headers as Record<string, string>;
}

const message = {
  to: "owner@example.com",
  subject: "Veyra Reception — Email Acceptance Test",
  body: "This is a development acceptance test."
};

afterEach(() => {
  vi.unstubAllGlobals();
  setEmailProvider(null);
});

describe("email provider selection", () => {
  it("defaults to the capture provider outside production", () => {
    expect(resolveEmailProviderChoice({}, "development")).toEqual({ kind: "console" });
    expect(resolveEmailProviderChoice({ VEYRA_EMAIL_PROVIDER: "console" }, "test")).toEqual({
      kind: "console"
    });
  });

  it("refuses the capture provider in production, however it was asked for", () => {
    const explicit = resolveEmailProviderChoice({ VEYRA_EMAIL_PROVIDER: "console" }, "production");
    expect(explicit.kind).toBe("unconfigured");
    expect(explicit.reason).toMatch(/refused in production/i);

    // Unset is a different mistake and gets a different explanation.
    const unset = resolveEmailProviderChoice({}, "production");
    expect(unset.kind).toBe("unconfigured");
    expect(unset.reason).toMatch(/VEYRA_EMAIL_PROVIDER is not set/);
  });

  it("selects Resend only when its credentials are present", () => {
    const configured = {
      VEYRA_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: API_KEY,
      VEYRA_EMAIL_FROM: "onboarding@resend.dev"
    };
    expect(resolveEmailProviderChoice(configured, "production")).toEqual({ kind: "resend" });
    expect(resolveEmailProviderChoice(configured, "development")).toEqual({ kind: "resend" });
  });

  it("names the variables a half-configured Resend setup is missing", () => {
    const partial = resolveEmailProviderChoice(
      { VEYRA_EMAIL_PROVIDER: "resend", VEYRA_EMAIL_FROM: "onboarding@resend.dev" },
      "production"
    );
    expect(partial.kind).toBe("unconfigured");
    expect(partial.reason).toContain("RESEND_API_KEY");
    // The one that *is* set must not be reported as missing.
    expect(partial.reason).not.toContain("VEYRA_EMAIL_FROM");

    expect(missingResendConfig({ VEYRA_EMAIL_PROVIDER: "resend" })).toEqual([
      "RESEND_API_KEY",
      "VEYRA_EMAIL_FROM"
    ]);
    // Whitespace is not configuration.
    expect(missingResendConfig({ RESEND_API_KEY: "   ", VEYRA_EMAIL_FROM: "  " })).toEqual([
      "RESEND_API_KEY",
      "VEYRA_EMAIL_FROM"
    ]);
  });

  it("fails closed on an unknown provider name rather than guessing", () => {
    const choice = resolveEmailProviderChoice({ VEYRA_EMAIL_PROVIDER: "mailgun" }, "development");
    expect(choice.kind).toBe("unconfigured");
    expect(choice.reason).toContain("mailgun");
  });

  it("builds the provider the choice names, and an unconfigured one never claims success", async () => {
    process.env.VEYRA_EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = API_KEY;
    process.env.VEYRA_EMAIL_FROM = "onboarding@resend.dev";
    expect(createEmailProvider().name).toBe("resend");

    setEmailProvider(null);
    delete process.env.RESEND_API_KEY;
    const unconfigured = createEmailProvider();
    expect(unconfigured.name).toBe("unconfigured");

    const result = await unconfigured.send(message);
    expect(result.delivered).toBe(false);
    expect(result).toMatchObject({ providerName: "unconfigured" });

    setEmailProvider(null);
    delete process.env.VEYRA_EMAIL_PROVIDER;
    delete process.env.VEYRA_EMAIL_FROM;
    expect(createEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
  });

  it("reads reply-to as optional and treats an empty value as unset", () => {
    const base = { RESEND_API_KEY: API_KEY, VEYRA_EMAIL_FROM: "onboarding@resend.dev" };
    expect(resendConfig(base)?.replyTo).toBeNull();
    expect(resendConfig({ ...base, VEYRA_EMAIL_REPLY_TO: "   " })?.replyTo).toBeNull();
    expect(resendConfig({ ...base, VEYRA_EMAIL_REPLY_TO: "hello@veyra.test" })?.replyTo).toBe(
      "hello@veyra.test"
    );
    expect(resendConfig({ VEYRA_EMAIL_FROM: "a@b.test" })).toBeNull();
  });
});

describe("startup email status", () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://veyra:pw@127.0.0.1:5434/veyra_dev";
    process.env.VEYRA_API_KEY = "dev-local-key";
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it("reports the provider that will actually be used, not a guess from NODE_ENV", () => {
    process.env.NODE_ENV = "development";
    expect(validateStartupConfig().email).toBe("console");

    process.env.VEYRA_EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = API_KEY;
    process.env.VEYRA_EMAIL_FROM = "onboarding@resend.dev";
    expect(validateStartupConfig().email).toBe("resend");

    // Selected but not configured is "unconfigured", not "resend".
    delete process.env.RESEND_API_KEY;
    const report = validateStartupConfig();
    expect(report.email).toBe("unconfigured");
    expect(report.warnings.join(" ")).toContain("RESEND_API_KEY");
  });

  it("warns that the capture provider is not delivering anything", () => {
    process.env.NODE_ENV = "development";
    expect(validateStartupConfig().warnings.join(" ")).toMatch(/captured in the log, not delivered/);
  });

  it("refuses to boot production with the capture provider", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:pass@db/veyra";
    process.env.VEYRA_WEB_ORIGIN = "https://app.example.com";
    process.env.VEYRA_EMAIL_PROVIDER = "console";

    expect(() => validateStartupConfig()).toThrow(ConfigurationError);
    expect(() => validateStartupConfig()).toThrow(/must not be used in production/);
  });

  it("never prints a secret value in the startup warnings", () => {
    process.env.NODE_ENV = "development";
    process.env.VEYRA_EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = API_KEY;
    delete process.env.VEYRA_EMAIL_FROM;

    const report = validateStartupConfig();
    expect(report.warnings.join(" ")).not.toContain(API_KEY);
  });
});

describe("Resend request mapping", () => {
  it("sends what Resend expects, with the configured sender", async () => {
    const spy = stubFetch(() => new Response(JSON.stringify({ id: "res_123" }), { status: 200 }));
    const provider = new ResendEmailProvider(config());

    const result = await provider.send({
      ...message,
      idempotencyKey: notificationIdempotencyKey("ntf_abc")
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe("POST");

    const body = sentBody(spy);
    expect(body.from).toBe("onboarding@resend.dev");
    expect(body.to).toEqual(["owner@example.com"]);
    expect(body.subject).toBe("Veyra Reception — Email Acceptance Test");
    expect(body.text).toBe("This is a development acceptance test.");
    // No reply-to configured means no reply-to key at all, not an empty one.
    expect(body).not.toHaveProperty("reply_to");

    expect(result).toMatchObject({ delivered: true, providerName: "resend" });
    // The vendor id is what an operator needs to find it in Resend's own log.
    expect(result.delivered && result.detail).toContain("res_123");
  });

  it("includes reply-to only when configured", async () => {
    const spy = stubFetch(() => new Response(JSON.stringify({ id: "res_1" }), { status: 200 }));
    await new ResendEmailProvider({ ...config(), replyTo: "hello@veyra.test" }).send(message);
    expect(sentBody(spy).reply_to).toBe("hello@veyra.test");
  });

  it("passes the notification's idempotency key as Resend's header", async () => {
    const spy = stubFetch(() => new Response(JSON.stringify({ id: "res_1" }), { status: 200 }));
    const key = notificationIdempotencyKey("ntf_abc");

    await new ResendEmailProvider(config()).send({ ...message, idempotencyKey: key });
    expect(sentHeaders(spy)["idempotency-key"]).toBe(key);

    // Stable across retries: the key is derived from the notification id alone.
    expect(notificationIdempotencyKey("ntf_abc")).toBe(key);
    expect(notificationIdempotencyKey("ntf_other")).not.toBe(key);
  });

  it("omits the idempotency header when the caller supplies no key", async () => {
    const spy = stubFetch(() => new Response(JSON.stringify({ id: "res_1" }), { status: 200 }));
    await new ResendEmailProvider(config()).send(message);
    expect(sentHeaders(spy)).not.toHaveProperty("idempotency-key");
  });

  it("still reports acceptance when the success body cannot be parsed", async () => {
    stubFetch(() => new Response("accepted", { status: 200 }));
    const result = await new ResendEmailProvider(config()).send(message);
    expect(result).toMatchObject({ delivered: true, providerName: "resend" });
  });
});

describe("Resend error normalization", () => {
  it("reports the provider's own words for a rejected request", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ message: "The gmail.com domain is not verified." }), {
          status: 403
        })
    );

    const result = await new ResendEmailProvider(config()).send(message);
    expect(result.delivered).toBe(false);
    expect(!result.delivered && result.reason).toContain("403");
    expect(!result.delivered && result.reason).toContain("domain is not verified");
  });

  it("handles a nested error body and a non-JSON body without throwing", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: "Invalid `to` field." } }), { status: 422 }));
    const nested = await new ResendEmailProvider(config()).send(message);
    expect(!nested.delivered && nested.reason).toContain("Invalid `to` field.");

    stubFetch(() => new Response("<html>gateway timeout</html>", { status: 504 }));
    const html = await new ResendEmailProvider(config()).send(message);
    expect(!html.delivered && html.reason).toContain("504");
  });

  it("does not let a vendor error carry the API key into a log", async () => {
    // A provider that echoes the Authorization header back at us is exactly
    // how a key ends up in a log file.
    stubFetch(() => new Response(JSON.stringify({ message: `Bad token: Bearer ${API_KEY}` }), { status: 401 }));

    const result = await new ResendEmailProvider(config()).send(message);
    expect(result.delivered).toBe(false);
    expect(!result.delivered && result.reason).not.toContain(API_KEY);
    expect(!result.delivered && result.reason).toContain("[redacted]");
  });

  it("bounds the reason instead of pasting a whole payload", async () => {
    stubFetch(() => new Response("x".repeat(5000), { status: 500 }));
    const result = await new ResendEmailProvider(config()).send(message);
    expect(!result.delivered && result.reason.length).toBeLessThan(300);
  });

  it("reports a network failure as a failure, not a send", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND api.resend.com");
    });

    const result = await new ResendEmailProvider(config()).send(message);
    expect(result).toMatchObject({ delivered: false, providerName: "resend" });
    expect(!result.delivered && result.reason).toMatch(/could not be reached/i);
  });

  it("says plainly when a send was cancelled by a lost claim lease", async () => {
    const controller = new AbortController();
    stubFetch(async (_url, init) => {
      // Mimic fetch: reject when the caller's signal fires mid-flight.
      controller.abort();
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      void init;
      throw error;
    });

    const result = await new ResendEmailProvider(config()).send({ ...message, signal: controller.signal });
    expect(result.delivered).toBe(false);
    expect(!result.delivered && result.reason).toMatch(/lost its claim lease/);
  });

  it("passes an abort signal to fetch so a lapsed lease can cancel the request", async () => {
    const spy = stubFetch(() => new Response(JSON.stringify({ id: "res_1" }), { status: 200 }));
    const controller = new AbortController();

    await new ResendEmailProvider(config()).send({ ...message, signal: controller.signal });

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });
});
