import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { BookingConfirmationDto, OpsBooking } from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { BookingDetailPage } from "../src/dashboard/BookingsPage";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  return { ...actual, getSession: vi.fn(), getBooking: vi.fn(), updateBookingStatus: vi.fn() };
});

vi.mock("../src/dashboard/AuthContext", async () => {
  const actual = await vi.importActual<typeof import("../src/dashboard/AuthContext")>(
    "../src/dashboard/AuthContext"
  );
  return { ...actual, useAuth: () => ({ can: () => true }) };
});

const BUSINESS_ID = "biz-1";
const BOOKING_ID = "booking-1";

function booking(confirmation: BookingConfirmationDto | null): OpsBooking {
  return {
    id: BOOKING_ID,
    conversationId: "conv-1",
    callerName: "Sam Customer",
    requestedTime: "Tuesday 3pm",
    serviceName: "Teeth whitening",
    notes: null,
    status: "confirmed",
    mode: "calendar",
    startTime: "2026-10-06T19:00:00.000Z",
    endTime: "2026-10-06T19:30:00.000Z",
    timezone: "America/New_York",
    calendarProvider: "google",
    externalCalendarId: "primary",
    externalEventId: "evt-1",
    externalEventStatus: "created",
    allowedTransitions: [],
    submittedAt: null,
    reviewedAt: null,
    resolvedAt: null,
    createdAt: "2026-10-05T09:00:00.000Z",
    confirmation
  };
}

function confirmation(patch: Partial<BookingConfirmationDto> = {}): BookingConfirmationDto {
  return {
    status: "accepted",
    channel: "sms",
    recipient: "+14••••71",
    reason: null,
    lastAttemptAt: "2026-10-05T09:01:00.000Z",
    deliveredAt: null,
    attempts: 1,
    retrying: false,
    ...patch
  };
}

function renderDetail(dto: OpsBooking) {
  vi.mocked(ops.getBooking).mockResolvedValue({ booking: dto, businessName: "Bright Smile", history: [] });
  return render(
    <MemoryRouter initialEntries={[`/dashboard/${BUSINESS_ID}/bookings/${BOOKING_ID}`]}>
      <Routes>
        <Route path="/dashboard/:businessId/bookings/:bookingId" element={<BookingDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("booking confirmation visibility", () => {
  it("does not call an accepted message delivered", async () => {
    renderDetail(booking(confirmation()));
    const cell = await screen.findByTestId("booking-confirmation");

    expect(cell).toHaveTextContent("Accepted by provider");
    expect(cell).not.toHaveTextContent("Delivered");
    expect(cell).toHaveTextContent("sms");
    // Masked, never the full number.
    expect(cell.textContent).not.toMatch(/\d{7,}/);
  });

  it("shows delivery only once a receipt has confirmed it", async () => {
    renderDetail(
      booking(confirmation({ status: "delivered", deliveredAt: "2026-10-05T09:02:00.000Z" }))
    );
    const cell = await screen.findByTestId("booking-confirmation");
    expect(cell).toHaveTextContent("Delivered");
  });

  it("explains a blocked confirmation instead of hiding it", async () => {
    renderDetail(
      booking(
        confirmation({
          status: "blocked",
          channel: null,
          recipient: null,
          reason: "The recipient has opted out of messages on this channel."
        })
      )
    );
    const cell = await screen.findByTestId("booking-confirmation");
    expect(cell).toHaveTextContent("Blocked");
    expect(cell).toHaveTextContent("opted out");
  });

  it("says plainly when there was nobody to tell", async () => {
    renderDetail(booking(confirmation({ status: "no_destination", channel: null, recipient: null })));
    expect(await screen.findByTestId("booking-confirmation")).toHaveTextContent(
      "No way to reach this customer"
    );
  });

  it("shows the retry state rather than looking like a final failure", async () => {
    renderDetail(booking(confirmation({ status: "queued", retrying: true, attempts: 2 })));
    const cell = await screen.findByTestId("booking-confirmation");
    expect(cell).toHaveTextContent("retrying (attempt 2)");
  });

  it("says nothing was sent when no transition considered it", async () => {
    renderDetail(booking(null));
    expect(await screen.findByTestId("booking-confirmation")).toHaveTextContent("Nothing sent");
  });
});
