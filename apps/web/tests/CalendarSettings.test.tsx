import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpsCalendarSettings } from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { CalendarSettings } from "../src/dashboard/CalendarSettings";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  return {
    ...actual,
    getCalendarSettings: vi.fn(),
    listCalendarOptions: vi.fn(),
    startCalendarConnection: vi.fn(),
    selectCalendar: vi.fn(),
    disconnectCalendar: vi.fn()
  };
});

const BUSINESS_ID = "biz-1";

/** What the API reports for a business — never tokens. */
function settings(overrides: Partial<OpsCalendarSettings> = {}): OpsCalendarSettings {
  return {
    businessId: BUSINESS_ID,
    businessName: "SmileCare Dental",
    entitled: true,
    requiredPlan: "PRO",
    calendarBookingEnabled: true,
    live: true,
    timezone: "America/New_York",
    connection: {
      provider: "google",
      status: "connected",
      statusDetail: null,
      selectedCalendarId: "cal-1",
      selectedCalendarName: "Front desk",
      calendarTimezone: "America/New_York",
      connectedAt: "2026-09-18T10:00:00.000Z"
    },
    connectableProviders: ["google"],
    canManage: false,
    bookingRules: {
      minNoticeMinutes: 120,
      maxHorizonDays: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      slotIntervalMinutes: 30,
      hours: [{ dayOfWeek: 1, opensMinute: 480, closesMinute: 1080, bookable: true }]
    },
    services: [
      { id: "s1", name: "Teeth whitening", durationMinutes: 60 },
      { id: "s2", name: "Dental implants", durationMinutes: null }
    ],
    ...overrides
  };
}

const connected = () => settings().connection!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ops.getCalendarSettings).mockResolvedValue(settings());
});

describe("Calendar settings", () => {
  it("shows the capability, connection, provider, calendar and business timezone", async () => {
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    expect(await screen.findByTestId("calendar-capability")).toHaveTextContent("Enabled");
    expect(screen.getByTestId("calendar-connection-status")).toHaveTextContent("Connected");
    expect(screen.getByTestId("calendar-provider")).toHaveTextContent("google");
    expect(screen.getByTestId("calendar-selected")).toHaveTextContent("Front desk");
    expect(screen.getByTestId("calendar-timezone")).toHaveTextContent("America/New_York");
    expect(screen.getByTestId("calendar-live")).toHaveTextContent(/books real appointments/i);
    expect(screen.getByTestId("calendar-rules")).toHaveTextContent("Monday 8:00 AM–6:00 PM");
    // A service without a duration is shown as not bookable, not given a made-up one.
    expect(screen.getByText(/Not set — cannot be booked live/)).toBeInTheDocument();
  });

  it("explains request-only mode when the calendar is not live", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(
      settings({ live: false, connection: null, calendarBookingEnabled: false })
    );
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    expect(await screen.findByTestId("calendar-connection-status")).toHaveTextContent("Not connected");
    expect(screen.getByTestId("calendar-capability")).toHaveTextContent("Disabled");
    expect(screen.getByTestId("calendar-live")).toHaveTextContent(/booking requests only/i);
    expect(screen.getByTestId("calendar-request-only-note")).toBeInTheDocument();
  });

  it("flags a connection that needs re-authentication", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(
      settings({ live: false, connection: { ...connected(), status: "needs_reauth", statusDetail: "Token revoked" } })
    );
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    expect(await screen.findByTestId("calendar-connection-status")).toHaveTextContent("Needs re-authentication");
    expect(screen.getByText(/Token revoked/)).toBeInTheDocument();
  });

  it("hides connection actions from members who may not manage the calendar", async () => {
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    expect(await screen.findByTestId("calendar-readonly-note")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-actions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  });

  it("offers reconnect, change and disconnect to an owner or admin", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(settings({ canManage: true }));
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change selected calendar/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("offers Connect Google Calendar when nothing is connected", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(
      settings({ canManage: true, connection: null, live: false })
    );
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    expect(await screen.findByRole("button", { name: "Connect Google Calendar" })).toBeInTheDocument();
  });

  it("lets a manager switch to a writable calendar but not a read-only one", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(settings({ canManage: true }));
    vi.mocked(ops.listCalendarOptions).mockResolvedValue({
      calendars: [
        { id: "cal-2", name: "Room 2", timezone: null, primary: false, writable: true },
        { id: "cal-ro", name: "Holidays", timezone: null, primary: false, writable: false }
      ]
    });
    vi.mocked(ops.selectCalendar).mockResolvedValue(
      settings({
        canManage: true,
        connection: { ...connected(), selectedCalendarId: "cal-2", selectedCalendarName: "Room 2" }
      })
    );
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    await userEvent.click(await screen.findByRole("button", { name: /change selected calendar/i }));
    expect(await screen.findByRole("button", { name: "Read-only" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Use this calendar" }));
    await waitFor(() => expect(screen.getByTestId("calendar-selected")).toHaveTextContent("Room 2"));
    expect(ops.selectCalendar).toHaveBeenCalledWith(BUSINESS_ID, "cal-2");
  });

  it("shows the server's refusal instead of pretending it worked", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(settings({ canManage: true }));
    vi.mocked(ops.disconnectCalendar).mockRejectedValue(
      new ops.ApiError(403, "You do not have permission to do that")
    );
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByTestId("calendar-error")).toHaveTextContent(/permission/i);
    // Still shows the connection the server still has.
    expect(screen.getByTestId("calendar-selected")).toHaveTextContent("Front desk");
  });

  it("disconnects and reflects the new state", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(settings({ canManage: true }));
    vi.mocked(ops.disconnectCalendar).mockResolvedValue(
      settings({ canManage: true, connection: null, live: false })
    );
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(screen.getByTestId("calendar-connection-status")).toHaveTextContent("Not connected")
    );
  });

  it("never renders anything that looks like a token", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(settings({ canManage: true }));
    const { container } = render(<CalendarSettings businessId={BUSINESS_ID} />);

    await screen.findByTestId("calendar-capability");
    expect(container.textContent ?? "").not.toMatch(/token|ya29\.|refresh_token/i);
  });
});
