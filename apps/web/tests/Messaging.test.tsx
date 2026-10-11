import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { MessagingChannelStatus, MessagingOverview } from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { MessagingSettings } from "../src/dashboard/messaging/MessagingSettings";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  return { ...actual, getMessagingOverview: vi.fn(), updateMessagingSettings: vi.fn() };
});

const BUSINESS_ID = "biz-1";

function channel(patch: Partial<MessagingChannelStatus> = {}): MessagingChannelStatus {
  return {
    channel: "sms",
    enabled: true,
    entitled: true,
    provider: "fake",
    sender: "+14••••00",
    health: "configured",
    detail: "Development SMS provider — no messages are sent. Nothing is delivered to a real handset.",
    simulated: true,
    inbound: { configured: false, routed: false, detail: "No provider is configured." },
    warnings: [],
    ...patch
  };
}

function overview(patch: Partial<MessagingOverview> = {}): MessagingOverview {
  return {
    businessId: BUSINESS_ID,
    sms: channel(),
    whatsapp: channel({ channel: "whatsapp" }),
    customerMessagingEnabled: true,
    operatorMessagingEnabled: false,
    defaultCountry: "PK",
    usage: { smsMessages: null, whatsappMessages: null },
    canManage: true,
    ...patch
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MessagingSettings businessId={BUSINESS_ID} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("messaging settings", () => {
  it("reports inbound separately from outbound health", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(
      overview({
        whatsapp: channel({
          channel: "whatsapp",
          provider: "meta",
          simulated: false,
          health: "healthy",
          inbound: {
            configured: true,
            routed: false,
            detail: "No WhatsApp number is mapped to this business, so an inbound message has nowhere to land."
          }
        })
      })
    );
    renderPage();

    // Outbound healthy, inbound not: the card must not imply both work.
    expect(await screen.findByTestId("messaging-whatsapp-health")).toHaveTextContent("Healthy");
    expect(screen.getByTestId("messaging-whatsapp-inbound")).toHaveTextContent("Not receiving");
    expect(screen.getByTestId("messaging-whatsapp-inbound")).toHaveTextContent("nowhere to land");
  });

  it("shows an operational warning about a temporary credential", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(
      overview({
        whatsapp: channel({
          channel: "whatsapp",
          provider: "meta",
          simulated: false,
          warnings: ["The Meta access token in use is temporary and expires roughly 24 hours after it was issued."]
        })
      })
    );
    renderPage();

    expect(await screen.findByTestId("messaging-whatsapp-warning")).toHaveTextContent(/temporary/i);
  });

  it("never describes a development provider as live", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(overview());
    renderPage();

    expect(await screen.findByTestId("messaging-sms-health")).toHaveTextContent("Configured");
    expect(screen.getByTestId("messaging-sms-health")).not.toHaveTextContent("Healthy");
    expect(screen.getByTestId("messaging-sms-simulated")).toHaveTextContent(
      /nothing is delivered to a real handset/i
    );
  });

  it("shows a healthy channel as healthy once a real provider proves it", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(
      overview({
        sms: channel({ health: "healthy", simulated: false, provider: "carrier", detail: "Provider reachable." })
      })
    );
    renderPage();

    expect(await screen.findByTestId("messaging-sms-health")).toHaveTextContent("Healthy");
    expect(screen.queryByTestId("messaging-sms-simulated")).toBeNull();
  });

  it("says a channel needs rollout rather than pretending it is available", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(
      overview({
        whatsapp: channel({
          channel: "whatsapp",
          entitled: false,
          enabled: false,
          health: "not_configured",
          detail: "WhatsApp is not included in this plan."
        })
      })
    );
    renderPage();

    expect(await screen.findByTestId("messaging-whatsapp-entitled")).toHaveTextContent(
      /rollout \/ integration required/i
    );
    // A channel the plan does not include cannot be switched on from here.
    expect(screen.getByTestId("messaging-whatsapp-toggle")).toBeDisabled();
  });

  it("shows a masked sender and never a full number", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(overview());
    renderPage();

    const sender = await screen.findByTestId("messaging-sms-sender");
    expect(sender).toHaveTextContent("+14••••00");
    expect(sender.textContent).not.toMatch(/\d{7,}/);
  });

  it("reports no usage as 'Not available' rather than zero", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(overview());
    renderPage();

    expect(await screen.findByTestId("messaging-usage")).toHaveTextContent("SMS: Not available");
  });

  it("shows real usage once there is some", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(
      overview({ usage: { smsMessages: 12, whatsappMessages: 3 } })
    );
    renderPage();

    const usage = await screen.findByTestId("messaging-usage");
    expect(usage).toHaveTextContent("SMS: 12");
    expect(usage).toHaveTextContent("WhatsApp: 3");
  });

  it("switches a channel on through the API", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(
      overview({ sms: channel({ enabled: false }) })
    );
    vi.mocked(ops.updateMessagingSettings).mockResolvedValue(overview());
    renderPage();

    await userEvent.click(await screen.findByTestId("messaging-sms-toggle"));
    expect(ops.updateMessagingSettings).toHaveBeenCalledWith(BUSINESS_ID, { smsEnabled: true });
  });

  it("gives a viewer nothing to click", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(overview({ canManage: false }));
    renderPage();

    expect(await screen.findByTestId("messaging-sms-toggle")).toBeDisabled();
    expect(screen.queryByTestId("messaging-customer-toggle")).toBeNull();
  });

  it("explains that the default country never guesses a number", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(overview());
    renderPage();

    expect(await screen.findByTestId("messaging-default-country")).toHaveTextContent(
      /never to guess one/i
    );
  });

  it("surfaces a server refusal instead of silently failing", async () => {
    vi.mocked(ops.getMessagingOverview).mockResolvedValue(overview({ sms: channel({ enabled: false }) }));
    vi.mocked(ops.updateMessagingSettings).mockRejectedValue(
      new Error("SMS is not included in this plan.")
    );
    renderPage();

    await userEvent.click(await screen.findByTestId("messaging-sms-toggle"));
    expect(await screen.findByTestId("messaging-error")).toHaveTextContent("not included in this plan");
  });
});
