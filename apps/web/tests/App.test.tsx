import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Business } from "@veyra/shared";
import { App } from "../src/App";
import * as api from "../src/api/client";

vi.mock("../src/api/client", () => ({
  getDemoBusiness: vi.fn(),
  getBusiness: vi.fn(),
  listBusinesses: vi.fn(),
  createBusiness: vi.fn(),
  startConversation: vi.fn(),
  sendMessage: vi.fn(),
  bookAppointment: vi.fn()
}));

const demoBusiness: Business = {
  id: "biz-1",
  name: "Veyra Demo Business",
  description: "",
  greeting: "Hi!",
  hours: "9-5",
  location: "",
  contactPhone: null,
  contactEmail: null,
  bookingRules: "",
  escalationRules: "",
  capabilities: {
    booking_requests: true,
    calendar_booking: false,
    human_escalation: true,
    whatsapp: false,
    sms: false,
    email_notifications: false
  },
  services: [],
  faqs: [],
  createdAt: "2026-01-01T00:00:00Z"
};

describe("App", () => {
  it("bootstraps a business and lets the user start a call", async () => {
    // The server decides which business the demo uses; the page never picks.
    vi.mocked(api.getDemoBusiness).mockResolvedValue({
      businessId: demoBusiness.id,
      name: demoBusiness.name,
      source: "configured",
      pinned: true
    });
    vi.mocked(api.getBusiness).mockResolvedValue(demoBusiness);
    vi.mocked(api.startConversation).mockResolvedValue({
      conversation: { id: "conv-1", businessId: "biz-1", callerName: null, status: "open", createdAt: "2026-01-01T00:00:00Z" },
      greeting: {
        id: "msg-1",
        conversationId: "conv-1",
        sender: "receptionist",
        text: "Thanks for calling Veyra Demo Business!",
        intent: null,
        action: null,
        confidence: null,
        requiresClarification: false,
        createdAt: "2026-01-01T00:00:00Z"
      }
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/start call/i)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByText(/start call/i));

    await waitFor(() =>
      expect(screen.getByText("Thanks for calling Veyra Demo Business!")).toBeInTheDocument()
    );
  });
});

describe("demo business selection", () => {
  it("asks the server which business to demo, and never picks one itself", async () => {
    vi.mocked(api.getDemoBusiness).mockResolvedValue({
      businessId: "biz-pinned",
      name: "Pinned Demo Clinic",
      source: "configured",
      pinned: true
    });
    vi.mocked(api.getBusiness).mockResolvedValue({ ...demoBusiness, id: "biz-pinned", name: "Pinned Demo Clinic" });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/Pinned Demo Clinic/)).toBeInTheDocument());
    expect(api.getBusiness).toHaveBeenCalledWith("biz-pinned");
    // The old behaviour — list every business and take the newest — is gone.
    expect(api.listBusinesses).not.toHaveBeenCalled();
    expect(api.createBusiness).not.toHaveBeenCalled();
  });

  it("says so plainly when no demo business is configured, instead of improvising one", async () => {
    vi.mocked(api.getDemoBusiness).mockResolvedValue({ businessId: null, name: null, source: "none", pinned: false });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/No demo business is configured/i)).toBeInTheDocument());
    expect(api.createBusiness).not.toHaveBeenCalled();
  });
});
