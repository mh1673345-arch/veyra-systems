import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  MembershipRole,
  OpsBooking,
  OpsBookingDetail,
  OpsEscalation,
  Permission
} from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { AuthProvider } from "../src/dashboard/AuthContext";
import { BookingDetailPage, BookingsPage } from "../src/dashboard/BookingsPage";
import { EscalationsPage } from "../src/dashboard/EscalationsPage";
import { ConversationDetailPage } from "../src/dashboard/ConversationsPage";
import { SettingsPage } from "../src/dashboard/SettingsPage";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  return {
    ...actual,
    getSession: vi.fn(),
    listBookings: vi.fn(),
    getBooking: vi.fn(),
    updateBookingStatus: vi.fn(),
    listEscalations: vi.fn(),
    getConversation: vi.fn(),
    getCapabilities: vi.fn(),
    getCalendarSettings: vi.fn()
  };
});

const BUSINESS_ID = "biz-1";

/** Signs the test in as a given role, the way the real provider would. */
function mockSession(role: MembershipRole, permissions: Permission[]) {
  vi.mocked(ops.getSession).mockResolvedValue({
    user: { id: "user-1", email: "op@veyra.test", name: "Test Operator" },
    memberships: [
      { businessId: BUSINESS_ID, businessName: "SmileCare Dental", role, permissions }
    ]
  });
}

const OPERATOR_PERMISSIONS: Permission[] = [
  "dashboard:read",
  "operations:write",
  "settings:read"
];
const VIEWER_PERMISSIONS: Permission[] = ["dashboard:read", "settings:read"];

function renderAt(path: string, routePath: string, element: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path={routePath} element={element} />
          <Route path="*" element={<div />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

const booking: OpsBooking = {
  id: "bk-1",
  confirmation: null,
  conversationId: "conv-1",
  callerName: "Sam Tester",
  requestedTime: "2026-10-01T10:00",
  serviceName: "Routine cleaning",
  notes: null,
  status: "submitted",
  mode: "request",
  startTime: null,
  endTime: null,
  timezone: null,
  calendarProvider: null,
  externalCalendarId: null,
  externalEventId: null,
  externalEventStatus: null,
  allowedTransitions: ["reviewing", "confirmed", "declined", "cancelled"],
  submittedAt: "2026-09-14T09:00:00.000Z",
  reviewedAt: null,
  resolvedAt: null,
  createdAt: "2026-09-14T09:00:00.000Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSession("OPERATOR", OPERATOR_PERMISSIONS);
  // The settings page now also shows calendar settings; these tests don't
  // exercise it, so it simply stays loading.
  vi.mocked(ops.getCalendarSettings).mockReturnValue(new Promise(() => {}));
});

describe("Bookings inbox", () => {
  it("lists booking requests with caller, service and status", async () => {
    vi.mocked(ops.listBookings).mockResolvedValue([booking]);

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings`,
      "/dashboard/:businessId/bookings",
      <BookingsPage />
    );

    await waitFor(() => expect(screen.getByText("Sam Tester")).toBeInTheDocument());
    expect(screen.getByText("Routine cleaning")).toBeInTheDocument();
    expect(screen.getByText("submitted")).toBeInTheDocument();
  });

  it("shows an empty state rather than sample rows", async () => {
    vi.mocked(ops.listBookings).mockResolvedValue([]);

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings`,
      "/dashboard/:businessId/bookings",
      <BookingsPage />
    );

    await waitFor(() => expect(screen.getByText("No booking requests yet.")).toBeInTheDocument());
    expect(screen.queryByText("Sam Tester")).not.toBeInTheDocument();
  });

  it("shows a loading state before data arrives", () => {
    vi.mocked(ops.listBookings).mockReturnValue(new Promise(() => {}));

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings`,
      "/dashboard/:businessId/bookings",
      <BookingsPage />
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows an error state with a retry when the API fails", async () => {
    vi.mocked(ops.listBookings).mockRejectedValue(new Error("Service unavailable"));

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings`,
      "/dashboard/:businessId/bookings",
      <BookingsPage />
    );

    await waitFor(() => expect(screen.getByText("Service unavailable")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("Booking detail", () => {
  const detail: OpsBookingDetail = {
    booking,
    businessName: "SmileCare Dental",
    history: []
  };

  it("offers only the transitions the server says are allowed", async () => {
    vi.mocked(ops.getBooking).mockResolvedValue({
      ...detail,
      booking: { ...booking, status: "confirmed", allowedTransitions: ["cancelled"] }
    });

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings/bk-1`,
      "/dashboard/:businessId/bookings/:bookingId",
      <BookingDetailPage />
    );

    await waitFor(() => expect(screen.getByText("Cancel request")).toBeInTheDocument());
    expect(screen.queryByText("Review request")).not.toBeInTheDocument();
    expect(screen.queryByText("Confirm request")).not.toBeInTheDocument();
  });

  it("sends the transition and reloads on success", async () => {
    vi.mocked(ops.getBooking).mockResolvedValue(detail);
    vi.mocked(ops.updateBookingStatus).mockResolvedValue({ ...booking, status: "reviewing" });

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings/bk-1`,
      "/dashboard/:businessId/bookings/:bookingId",
      <BookingDetailPage />
    );

    await waitFor(() => expect(screen.getByText("Review request")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Review request"));

    expect(ops.updateBookingStatus).toHaveBeenCalledWith(BUSINESS_ID, "bk-1", "reviewing");
  });

  it("surfaces a server-rejected transition instead of pretending it worked", async () => {
    vi.mocked(ops.getBooking).mockResolvedValue(detail);
    vi.mocked(ops.updateBookingStatus).mockRejectedValue(
      new Error('Cannot move a booking request from "confirmed" to "reviewing".')
    );

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings/bk-1`,
      "/dashboard/:businessId/bookings/:bookingId",
      <BookingDetailPage />
    );

    await waitFor(() => expect(screen.getByText("Review request")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Review request"));

    await waitFor(() =>
      expect(screen.getByText(/Cannot move a booking request/)).toBeInTheDocument()
    );
  });

  it("links back to the originating conversation", async () => {
    vi.mocked(ops.getBooking).mockResolvedValue(detail);

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings/bk-1`,
      "/dashboard/:businessId/bookings/:bookingId",
      <BookingDetailPage />
    );

    await waitFor(() =>
      expect(screen.getByText("Open originating conversation")).toHaveAttribute(
        "href",
        `/dashboard/${BUSINESS_ID}/conversations/conv-1`
      )
    );
  });

  it("shows a viewer read-only access instead of transition controls", async () => {
    mockSession("VIEWER", VIEWER_PERMISSIONS);
    vi.mocked(ops.getBooking).mockResolvedValue(detail);

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings/bk-1`,
      "/dashboard/:businessId/bookings/:bookingId",
      <BookingDetailPage />
    );

    await waitFor(() =>
      expect(screen.getByText(/read-only access to this request/)).toBeInTheDocument()
    );
    expect(screen.queryByText("Review request")).not.toBeInTheDocument();
    expect(screen.queryByText("Confirm request")).not.toBeInTheDocument();
  });

  it("attributes each audit entry to the user who made the change", async () => {
    vi.mocked(ops.getBooking).mockResolvedValue({
      ...detail,
      booking: { ...booking, status: "confirmed", allowedTransitions: ["cancelled"] },
      history: [
        {
          id: "ev-1",
          entityType: "booking",
          entityId: "bk-1",
          fromStatus: "reviewing",
          toStatus: "confirmed",
          actorType: "operator",
          actorUserId: "user-9",
          actorName: "Hassan",
          createdAt: "2026-09-14T10:00:00.000Z"
        }
      ]
    });

    renderAt(
      `/dashboard/${BUSINESS_ID}/bookings/bk-1`,
      "/dashboard/:businessId/bookings/:bookingId",
      <BookingDetailPage />
    );

    await waitFor(() =>
      expect(screen.getByText(/Hassan changed reviewing → confirmed/)).toBeInTheDocument()
    );
  });
});

describe("Escalation inbox", () => {
  const escalation: OpsEscalation = {
    id: "esc-1",
    conversationId: "conv-1",
    callerName: "Sam Tester",
    reason: "I want to speak to a person",
    status: "requested",
    allowedTransitions: ["assigned", "closed"],
    assignedAt: null,
    resolvedAt: null,
    createdAt: "2026-09-14T09:05:00.000Z"
  };

  it("lists escalations with reason and status", async () => {
    vi.mocked(ops.listEscalations).mockResolvedValue([escalation]);

    renderAt(
      `/dashboard/${BUSINESS_ID}/escalations`,
      "/dashboard/:businessId/escalations",
      <EscalationsPage />
    );

    await waitFor(() =>
      expect(screen.getByText("I want to speak to a person")).toBeInTheDocument()
    );
    expect(screen.getByText("requested")).toBeInTheDocument();
  });

  it("shows an empty state when there are no escalations", async () => {
    vi.mocked(ops.listEscalations).mockResolvedValue([]);

    renderAt(
      `/dashboard/${BUSINESS_ID}/escalations`,
      "/dashboard/:businessId/escalations",
      <EscalationsPage />
    );

    await waitFor(() => expect(screen.getByText("No escalations yet.")).toBeInTheDocument());
  });
});

describe("Conversation detail", () => {
  it("renders the transcript and links to related records", async () => {
    vi.mocked(ops.getConversation).mockResolvedValue({
      conversation: {
        id: "conv-1",
        callerName: "Sam Tester",
        channel: "web" as const,
        customerContactId: null,
        status: "open",
        createdAt: "2026-09-14T09:00:00.000Z",
        messageCount: 2,
        lastCallerMessage: "I want to book a cleaning",
        lastMessageAt: "2026-09-14T09:01:00.000Z",
        lastIntent: "booking",
        bookingCount: 1,
        escalationCount: 0
      },
      messages: [
        {
          id: "m1",
          sender: "caller",
          text: "I want to book a cleaning",
          intent: null,
          action: null,
          createdAt: "2026-09-14T09:00:30.000Z"
        },
        {
          id: "m2",
          sender: "receptionist",
          text: "Please use the booking request below.",
          intent: "booking",
          action: "show_booking_form",
          createdAt: "2026-09-14T09:01:00.000Z"
        }
      ],
      bookings: [booking],
      escalations: []
    });

    renderAt(
      `/dashboard/${BUSINESS_ID}/conversations/conv-1`,
      "/dashboard/:businessId/conversations/:conversationId",
      <ConversationDetailPage />
    );

    await waitFor(() =>
      expect(screen.getByText("Please use the booking request below.")).toBeInTheDocument()
    );
    expect(screen.getByText("Sam Tester")).toBeInTheDocument();
    expect(screen.getByText("I want to book a cleaning")).toBeInTheDocument();
    expect(screen.getByText(/Booking request — 2026-10-01/)).toHaveAttribute(
      "href",
      `/dashboard/${BUSINESS_ID}/bookings/bk-1`
    );
  });
});

describe("Business settings", () => {
  it("distinguishes enabled from disabled capabilities and offers no controls", async () => {
    vi.mocked(ops.getCapabilities).mockResolvedValue({
      businessId: BUSINESS_ID,
      businessName: "SmileCare Dental",
      capabilities: {
        booking_requests: true,
        calendar_booking: false,
        human_escalation: true,
        whatsapp: false,
        sms: false,
        email_notifications: false
      }
    });

    renderAt(
      `/dashboard/${BUSINESS_ID}/settings`,
      "/dashboard/:businessId/settings",
      <SettingsPage />
    );

    await waitFor(() =>
      expect(screen.getByTestId("capability-booking_requests")).toHaveTextContent("Enabled")
    );
    expect(screen.getByTestId("capability-calendar_booking")).toHaveTextContent("Disabled");
    expect(screen.getByTestId("capability-human_escalation")).toHaveTextContent("Enabled");
    expect(screen.getByTestId("capability-whatsapp")).toHaveTextContent("Disabled");

    // Read-only: no toggles or switches to change capabilities from the UI.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
