import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { CustomerContactDto } from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { ContactCard } from "../src/dashboard/contacts/ContactCard";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  return {
    ...actual,
    getCustomerContact: vi.fn(),
    updateCustomerContact: vi.fn(),
    getConfirmationDestinations: vi.fn()
  };
});

const BUSINESS_ID = "biz-1";
const CONTACT_ID = "contact-1";
const CONVERSATION_ID = "conv-1";

function contact(patch: Partial<CustomerContactDto> = {}): CustomerContactDto {
  return {
    id: CONTACT_ID,
    displayName: "Sam Customer",
    phone: "+14••••71",
    email: "sam@customer.test",
    phoneState: "provided",
    emailState: "provided",
    source: "web",
    emailTransactionalAllowed: true,
    smsConsent: "unknown",
    whatsappConsent: "unknown",
    bookingCount: 1,
    conversationCount: 2,
    createdAt: "2026-09-20T10:00:00.000Z",
    ...patch
  };
}

function renderCard(canEdit = true) {
  return render(
    <MemoryRouter>
      <ContactCard
        businessId={BUSINESS_ID}
        contactId={CONTACT_ID}
        conversationId={CONVERSATION_ID}
        canEdit={canEdit}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ops.getConfirmationDestinations).mockResolvedValue({ available: [], blocked: [] });
});

describe("contact card", () => {
  it("shows a masked phone and never the full number", async () => {
    vi.mocked(ops.getCustomerContact).mockResolvedValue(contact());
    renderCard();

    const phone = await screen.findByTestId("contact-phone");
    expect(phone).toHaveTextContent("+14••••71");
    expect(phone.textContent).not.toMatch(/\d{7,}/);
  });

  it("says how firmly each detail is known rather than showing a tick", async () => {
    vi.mocked(ops.getCustomerContact).mockResolvedValue(
      contact({ phoneState: "channel_confirmed", emailState: "provided" })
    );
    renderCard();

    expect(await screen.findByTestId("contact-phone")).toHaveTextContent("confirmed on this channel");
    expect(screen.getByTestId("contact-email")).toHaveTextContent("given, not verified");
    // Nothing claims verification, because nothing verifies anything yet.
    expect(screen.getByTestId("contact-phone")).not.toHaveTextContent(/^verified/);
  });

  it("shows where a confirmation would actually go", async () => {
    vi.mocked(ops.getCustomerContact).mockResolvedValue(contact());
    vi.mocked(ops.getConfirmationDestinations).mockResolvedValue({
      available: [{ channel: "sms", to: "+14••••71", reason: "The customer gave this number." }],
      blocked: [{ channel: "whatsapp", reason: "WhatsApp needs an approved template." }]
    });
    renderCard();

    const list = await screen.findByTestId("contact-destinations");
    expect(list).toHaveTextContent("sms");
    // A blocked channel is explained, not hidden.
    expect(list).toHaveTextContent("whatsapp unavailable");
    expect(list).toHaveTextContent("approved template");
  });

  it("says plainly when there is nowhere to send a confirmation", async () => {
    vi.mocked(ops.getCustomerContact).mockResolvedValue(
      contact({ phone: null, email: null, phoneState: "unknown", emailState: "unknown" })
    );
    renderCard();

    expect(await screen.findByTestId("contact-no-destination")).toHaveTextContent(/nowhere/i);
  });

  it("gives a viewer nothing to edit", async () => {
    vi.mocked(ops.getCustomerContact).mockResolvedValue(contact());
    renderCard(false);

    await screen.findByTestId("contact-name");
    expect(screen.queryByTestId("contact-edit")).toBeNull();
  });

  it("leaves the phone alone when the operator does not retype it", async () => {
    vi.mocked(ops.getCustomerContact).mockResolvedValue(contact());
    vi.mocked(ops.updateCustomerContact).mockResolvedValue(contact({ displayName: "Samantha" }));
    renderCard();

    await userEvent.click(await screen.findByTestId("contact-edit"));
    // The field starts empty rather than pre-filled with the mask.
    expect(screen.getByTestId("contact-phone-input")).toHaveValue("");

    await userEvent.clear(screen.getByTestId("contact-name-input"));
    await userEvent.type(screen.getByTestId("contact-name-input"), "Samantha");
    await userEvent.click(screen.getByTestId("contact-save"));

    expect(ops.updateCustomerContact).toHaveBeenCalledWith(BUSINESS_ID, CONTACT_ID, {
      name: "Samantha",
      email: "sam@customer.test"
    });
  });

  it("surfaces a refused correction instead of appearing to succeed", async () => {
    vi.mocked(ops.getCustomerContact).mockResolvedValue(contact());
    vi.mocked(ops.updateCustomerContact).mockRejectedValue(
      new Error('"0300…67" has no country code.')
    );
    renderCard();

    await userEvent.click(await screen.findByTestId("contact-edit"));
    await userEvent.type(screen.getByTestId("contact-phone-input"), "03001234567");
    await userEvent.click(screen.getByTestId("contact-save"));

    expect(await screen.findByTestId("contact-error")).toHaveTextContent("no country code");
  });
});
