import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  ENTITLEMENT_DEFINITIONS,
  type MembershipRole,
  type OpsBilling,
  type OpsCalendarSettings,
  type OpsSubscription,
  PLAN_CATALOG,
  PLAN_ORDER,
  type Permission,
  type PlanCode,
  lowestPlanWith
} from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { AuthProvider } from "../src/dashboard/AuthContext";
import { SettingsPage } from "../src/dashboard/SettingsPage";
import { CalendarSettings } from "../src/dashboard/CalendarSettings";
import { MembersPage } from "../src/dashboard/MembersPage";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  return {
    ...actual,
    getSession: vi.fn(),
    getCapabilities: vi.fn(),
    getCalendarSettings: vi.fn(),
    getSubscription: vi.fn(),
    listMembers: vi.fn(),
    addMember: vi.fn(),
    startCheckout: vi.fn(),
    requestPlanChange: vi.fn(),
    cancelPlan: vi.fn(),
    resumePlan: vi.fn(),
    openBillingPortal: vi.fn(),
    redirectTo: vi.fn()
  };
});

const BUSINESS_ID = "biz-1";

const OWNER_PERMISSIONS: Permission[] = [
  "dashboard:read",
  "operations:write",
  "settings:read",
  "members:read",
  "members:write",
  "members:manage_owners",
  "calendar:manage",
  "subscription:read",
  "billing:manage"
];
const OPERATOR_PERMISSIONS: Permission[] = ["dashboard:read", "operations:write", "settings:read"];

function mockSession(role: MembershipRole, permissions: Permission[]) {
  vi.mocked(ops.getSession).mockResolvedValue({
    user: { id: "user-1", email: "owner@veyra.test", name: "Test Owner" },
    memberships: [{ businessId: BUSINESS_ID, businessName: "Bright Smile Studio", role, permissions }]
  });
}

/** No billing provider configured — the state before this phase. */
function billing(overrides: Partial<OpsBilling> = {}): OpsBilling {
  return {
    available: false,
    provider: null,
    simulated: false,
    prices: [],
    billingInterval: null,
    hasPaidSubscription: false,
    cancelAtPeriodEnd: false,
    scheduledPlan: null,
    scheduledChangeAt: null,
    canManage: true,
    actions: { checkout: [], changePlan: [], portal: false, cancel: false, resume: false },
    pendingCheckout: null,
    overLimit: [],
    trialDays: null,
    ...overrides
  };
}

/** A configured (development) provider, as the API reports it to an owner. */
function liveBilling(overrides: Partial<OpsBilling> = {}): OpsBilling {
  return billing({
    available: true,
    provider: "fake",
    simulated: true,
    prices: [
      { plan: "PRO", currency: "usd", interval: "month", amountMinor: 4900, displayAmount: "$49.00", final: false },
      { plan: "MAX", currency: "usd", interval: "month", amountMinor: 14900, displayAmount: "$149.00", final: false }
    ],
    actions: { checkout: ["PRO", "MAX"], changePlan: [], portal: false, cancel: false, resume: false },
    ...overrides
  });
}

/** Built from the real catalog, the way the API builds it. */
function subscription(plan: PlanCode, overrides: Partial<OpsSubscription> = {}): OpsSubscription {
  const included = new Set(PLAN_CATALOG[plan].entitlements);
  return {
    businessId: BUSINESS_ID,
    businessName: "Bright Smile Studio",
    plan: { ...PLAN_CATALOG[plan], entitlements: [...PLAN_CATALOG[plan].entitlements] },
    status: "active",
    degraded: false,
    billingAttention: false,
    startsAt: "2026-09-01T00:00:00.000Z",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: null,
    trialEndsAt: null,
    cancelledAt: null,
    entitlements: ENTITLEMENT_DEFINITIONS.map((definition) => ({
      ...definition,
      included: included.has(definition.key),
      requiredPlan: lowestPlanWith(definition.key)
    })),
    limits: [
      { key: "team_members", label: "Team members", limit: PLAN_CATALOG[plan].limits.team_members, used: 2, enforcement: "enforced" },
      { key: "monthly_conversations", label: "Conversations per month", limit: PLAN_CATALOG[plan].limits.monthly_conversations, used: 41, enforcement: "tracked" },
      { key: "calendar_connections", label: "Calendar connections", limit: PLAN_CATALOG[plan].limits.calendar_connections, used: 0, enforcement: "tracked" },
      { key: "business_locations", label: "Locations", limit: PLAN_CATALOG[plan].limits.business_locations, used: null, enforcement: "planned" },
      { key: "monthly_voice_minutes", label: "Voice minutes per month", limit: PLAN_CATALOG[plan].limits.monthly_voice_minutes, used: null, enforcement: "planned" }
    ],
    plans: PLAN_ORDER.map((code) => ({ ...PLAN_CATALOG[code], entitlements: [...PLAN_CATALOG[code].entitlements] })),
    billingAvailable: false,
    billing: billing(),
    ...overrides
  };
}

/** The same subscription, with billing configured. */
function paid(plan: PlanCode, billingOverrides: Partial<OpsBilling> = {}, overrides: Partial<OpsSubscription> = {}): OpsSubscription {
  return subscription(plan, {
    billingAvailable: true,
    billing: liveBilling(billingOverrides),
    ...overrides
  });
}

function lockedCalendar(overrides: Partial<OpsCalendarSettings> = {}): OpsCalendarSettings {
  return {
    businessId: BUSINESS_ID,
    businessName: "Bright Smile Studio",
    entitled: false,
    requiredPlan: "PRO",
    calendarBookingEnabled: false,
    live: false,
    timezone: "America/New_York",
    connection: null,
    connectableProviders: [],
    canManage: true,
    bookingRules: {
      minNoticeMinutes: 120,
      maxHorizonDays: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      slotIntervalMinutes: 30,
      hours: []
    },
    services: [],
    ...overrides
  };
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mockSession("OWNER", OWNER_PERMISSIONS);
  vi.mocked(ops.getCapabilities).mockResolvedValue({
    businessId: BUSINESS_ID,
    businessName: "Bright Smile Studio",
    capabilities: {
      booking_requests: true,
      calendar_booking: false,
      human_escalation: true,
      whatsapp: false,
      sms: false,
      email_notifications: false
    }
  });
  vi.mocked(ops.getCalendarSettings).mockResolvedValue(lockedCalendar());
  vi.mocked(ops.getSubscription).mockResolvedValue(subscription("STARTER"));
});

function renderSettings() {
  return renderAt(`/dashboard/${BUSINESS_ID}/settings`, "/dashboard/:businessId/settings", <SettingsPage />);
}

describe("Plan & usage", () => {
  it("shows the current plan, status and usage", async () => {
    renderSettings();

    expect(await screen.findByTestId("subscription-plan")).toHaveTextContent("Starter — Answer");
    expect(screen.getByTestId("subscription-status")).toHaveTextContent("Active");
    const usage = screen.getByTestId("subscription-usage");
    expect(usage).toHaveTextContent("2 / 3");
    // No counter exists for locations: shown as unknown, not as zero.
    expect(within(usage).getAllByText(/not tracked yet/)).toHaveLength(2);
  });

  it("lists included features and locked ones with the plan that includes them", async () => {
    renderSettings();

    const included = await screen.findByTestId("subscription-included");
    expect(included).toHaveTextContent("Booking requests");
    expect(included).not.toHaveTextContent("Automatic booking");

    const locked = screen.getByTestId("subscription-locked");
    expect(locked).toHaveTextContent(/Automatic booking.*Available on Pro/);
    // Included in a plan but not built yet: said so, rather than sold as working.
    expect(locked).toHaveTextContent(/Voice reception.*Included with Max — Coming soon/);
    expect(locked).toHaveTextContent(/WhatsApp.*Not on a plan yet/);
  });

  it("shows unlimited limits as unlimited", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(subscription("MAX"));
    renderSettings();

    expect(await screen.findByTestId("subscription-usage")).toHaveTextContent("2 / Unlimited");
    // Max has nothing to upgrade to.
    expect(screen.queryByTestId("subscription-upgrade")).not.toBeInTheDocument();
  });

  it("does not fake a checkout when no billing provider is configured", async () => {
    renderSettings();

    await userEvent.click(await screen.findByTestId("subscription-upgrade"));
    expect(screen.getByTestId("billing-notice")).toHaveTextContent(/online billing isn't set up on this server yet/i);
    expect(screen.queryByTestId("billing-checkout-PRO")).not.toBeInTheDocument();
    expect(ops.startCheckout).not.toHaveBeenCalled();
  });

  it("compares Starter — Answer, Pro — Act and Max — Speak from the same catalog, without prices", async () => {
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Compare plans" }));
    const table = screen.getByTestId("plan-comparison");
    for (const text of ["Starter", "Answer", "Pro", "Act", "Max", "Speak", "Current plan"]) {
      expect(table).toHaveTextContent(text);
    }
    // No prices anywhere: none have been decided.
    expect(table.textContent).not.toMatch(/[$€£]/);

    const automaticBooking = within(table).getByText("Automatic booking").closest("tr")!;
    expect(within(automaticBooking).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "Automatic booking",
      "—",
      "✓",
      "✓"
    ]);
  });

  it("flags a degraded subscription without alarming callers-facing language", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(
      subscription("PRO", { status: "cancelled", degraded: true, billingAttention: true })
    );
    renderSettings();

    expect(await screen.findByTestId("subscription-status")).toHaveTextContent("Cancelled");
    expect(screen.getByTestId("subscription-degraded")).toHaveTextContent(/keeps answering callers/i);
  });

  it("is not shown to members without subscription access", async () => {
    mockSession("OPERATOR", OPERATOR_PERMISSIONS);
    renderSettings();

    // The page renders (capabilities load), but the plan area does not.
    expect(await screen.findByTestId("calendar-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("subscription-settings")).not.toBeInTheDocument();
    expect(ops.getSubscription).not.toHaveBeenCalled();
  });
});

describe("locked calendar feature", () => {
  it("shows Google Calendar as a locked Pro feature instead of connection actions", async () => {
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    const locked = await screen.findByTestId("calendar-locked");
    expect(locked).toHaveTextContent("Google Calendar");
    expect(locked).toHaveTextContent("Live availability and automatic booking");
    expect(locked).toHaveTextContent("Available on Pro");
    expect(screen.queryByRole("button", { name: /connect google calendar/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("calendar-upgrade"));
    expect(screen.getByTestId("calendar-upgrade-notice")).toHaveTextContent(/Plan & billing/i);
  });

  it("tells a downgraded business its stored connection is kept", async () => {
    vi.mocked(ops.getCalendarSettings).mockResolvedValue(
      lockedCalendar({
        calendarBookingEnabled: true,
        connection: {
          provider: "fake",
          status: "connected",
          statusDetail: null,
          selectedCalendarId: "primary",
          selectedCalendarName: "Demo calendar",
          calendarTimezone: "UTC",
          connectedAt: "2026-09-18T10:00:00.000Z"
        }
      })
    );
    render(<CalendarSettings businessId={BUSINESS_ID} />);

    expect(await screen.findByTestId("calendar-locked")).toHaveTextContent(/existing connection is kept/i);
    // Removing stored credentials is always possible.
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });
});

describe("team-member limit", () => {
  it("explains a plan limit returned by the server", async () => {
    vi.mocked(ops.listMembers).mockResolvedValue([]);
    vi.mocked(ops.addMember).mockRejectedValue(
      new ops.ApiError(403, "Your plan includes 3 team members.", {
        code: "PLAN_LIMIT_REACHED",
        requiredPlan: "PRO"
      })
    );
    renderAt(`/dashboard/${BUSINESS_ID}/members`, "/dashboard/:businessId/members", <MembersPage />);

    await userEvent.type(await screen.findByLabelText("Member email"), "new@veyra.test");
    await userEvent.click(screen.getByRole("button", { name: "Add member" }));

    expect(await screen.findByText(/Your plan includes 3 team members\. Pro allows more/)).toBeInTheDocument();
  });
});

describe("billing", () => {
  it("offers the plans the server says can be bought, priced, and marked provisional", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(paid("STARTER"));
    renderSettings();

    expect(await screen.findByTestId("billing-checkout-PRO")).toHaveTextContent("Upgrade to Pro — $49.00/month");
    expect(screen.getByTestId("billing-checkout-MAX")).toHaveTextContent("Upgrade to Max — $149.00/month");
    expect(screen.getByTestId("billing-prices-provisional")).toHaveTextContent(/examples and not final/i);
    expect(screen.getByTestId("billing-simulated")).toHaveTextContent(/no real payments/i);
    // Nothing the server didn't offer.
    expect(screen.queryByTestId("billing-cancel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("billing-portal")).not.toBeInTheDocument();
  });

  it("sends only the plan to the server and hands over to the provider's checkout", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(paid("STARTER"));
    vi.mocked(ops.startCheckout).mockResolvedValue({ url: "https://provider.test/checkout/cs_1" });
    renderSettings();

    await userEvent.click(await screen.findByTestId("billing-checkout-PRO"));

    expect(ops.startCheckout).toHaveBeenCalledWith(BUSINESS_ID, "PRO");
    expect(ops.redirectTo).toHaveBeenCalledWith("https://provider.test/checkout/cs_1");
    // The Console never claims the plan changed.
    expect(screen.getByTestId("subscription-plan")).toHaveTextContent("Starter — Answer");
  });

  it("waits for the webhook after checkout instead of claiming the plan is live", async () => {
    const confirmed = paid("PRO", {
      hasPaidSubscription: true,
      actions: { checkout: [], changePlan: ["STARTER", "MAX"], portal: true, cancel: true, resume: false }
    });
    // The second read is held open, so the "confirming" state is observable —
    // exactly the window in which the webhook has not arrived yet.
    let webhookProcessed: (value: OpsSubscription) => void = () => undefined;
    vi.mocked(ops.getSubscription)
      .mockResolvedValueOnce(paid("STARTER", { pendingCheckout: { targetPlan: "PRO", createdAt: "2026-09-19T10:00:00.000Z" } }))
      .mockImplementationOnce(() => new Promise<OpsSubscription>((resolve) => {
        webhookProcessed = resolve;
      }))
      .mockResolvedValue(confirmed);
    renderAt(
      `/dashboard/${BUSINESS_ID}/settings?billing=success`,
      "/dashboard/:businessId/settings",
      <SettingsPage />
    );

    // Returning from checkout proves only that the browser came back.
    expect(await screen.findByTestId("billing-notice")).toHaveTextContent(
      "Payment received. We're confirming your subscription."
    );
    expect(screen.getByTestId("subscription-plan")).toHaveTextContent("Starter — Answer");

    // Once the webhook has been processed, the refreshed plan appears.
    webhookProcessed(confirmed);
    expect(await screen.findByText(/Subscription confirmed\. You're on Pro — Act\./)).toBeInTheDocument();
    expect(await screen.findByTestId("subscription-plan")).toHaveTextContent("Pro — Act");
  });

  it("says plainly that a cancelled checkout charged nothing", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(paid("STARTER"));
    renderAt(
      `/dashboard/${BUSINESS_ID}/settings?billing=cancelled`,
      "/dashboard/:businessId/settings",
      <SettingsPage />
    );

    expect(await screen.findByTestId("billing-notice")).toHaveTextContent(
      "Checkout cancelled. Nothing was charged and your plan hasn't changed."
    );
    expect(ops.startCheckout).not.toHaveBeenCalled();
  });

  it("confirms a cancellation, explains what is kept, and reports it as pending", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(
      paid("PRO", {
        hasPaidSubscription: true,
        actions: { checkout: [], changePlan: ["STARTER", "MAX"], portal: true, cancel: true, resume: false }
      })
    );
    vi.mocked(ops.cancelPlan).mockResolvedValue({
      state: "pending",
      message: "Requested. Your paid plan stays active until the end of the current billing period."
    });
    renderSettings();

    await userEvent.click(await screen.findByTestId("billing-cancel"));
    expect(screen.getByTestId("billing-confirm")).toHaveTextContent(/every setting, booking and team member is kept/i);
    expect(ops.cancelPlan).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("billing-confirm-yes"));
    expect(ops.cancelPlan).toHaveBeenCalledWith(BUSINESS_ID);
    expect(await screen.findByTestId("billing-notice")).toHaveTextContent(/stays active until the end/i);
  });

  it("shows a scheduled cancellation, the resume action, and no plan-change buttons", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(
      paid("PRO", {
        hasPaidSubscription: true,
        cancelAtPeriodEnd: true,
        scheduledPlan: "STARTER",
        scheduledChangeAt: "2026-10-19T00:00:00.000Z",
        actions: { checkout: [], changePlan: [], portal: true, cancel: false, resume: true }
      })
    );
    renderSettings();

    const banner = await screen.findByTestId("billing-cancel-scheduled");
    expect(banner).toHaveTextContent(/Pro ends on/);
    expect(banner).toHaveTextContent(/After that you'll be on Starter/);
    expect(banner).toHaveTextContent(/services, bookings and team are kept/);
    expect(screen.getByTestId("billing-resume")).toHaveTextContent("Keep Pro");
    expect(screen.queryByTestId("billing-cancel")).not.toBeInTheDocument();
  });

  it("warns about payment trouble without suggesting callers are affected", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(
      paid("PRO", { hasPaidSubscription: true, actions: { checkout: [], changePlan: [], portal: true, cancel: true, resume: false } }, {
        status: "past_due",
        billingAttention: true
      })
    );
    renderSettings();

    const banner = await screen.findByTestId("subscription-attention");
    expect(banner).toHaveTextContent(/didn't go through/i);
    expect(banner).toHaveTextContent(/Everything keeps working for now/i);
    expect(screen.getByTestId("billing-portal")).toBeInTheDocument();
  });

  it("warns about usage over the new plan's limit without anyone being removed", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(
      paid("STARTER", { overLimit: [{ key: "team_members", label: "Team members", used: 5, allowed: 3 }] })
    );
    renderSettings();

    expect(await screen.findByTestId("billing-over-limit")).toHaveTextContent(
      /Team members: 5 of 3 on this plan\. Nobody has been removed/
    );
  });

  it("gives an admin the billing picture but no billing buttons", async () => {
    const ADMIN_PERMISSIONS: Permission[] = OWNER_PERMISSIONS.filter(
      (permission) => permission !== "members:manage_owners" && permission !== "billing:manage"
    );
    mockSession("ADMIN", ADMIN_PERMISSIONS);
    vi.mocked(ops.getSubscription).mockResolvedValue(
      paid("PRO", { canManage: false, hasPaidSubscription: true, actions: { checkout: [], changePlan: [], portal: false, cancel: false, resume: false } })
    );
    renderSettings();

    expect(await screen.findByTestId("subscription-plan")).toHaveTextContent("Pro — Act");
    expect(screen.queryByTestId("billing-checkout-MAX")).not.toBeInTheDocument();
    expect(screen.queryByTestId("billing-cancel")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("subscription-upgrade"));
    expect(screen.getByTestId("billing-notice")).toHaveTextContent("Only the business owner can buy or change the plan.");
  });

  it("shows prices in the comparison only when the server has them", async () => {
    vi.mocked(ops.getSubscription).mockResolvedValue(paid("STARTER"));
    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Compare plans" }));
    expect(screen.getByTestId("plan-price-PRO")).toHaveTextContent("$49.00/month");
    expect(screen.getByTestId("plan-price-STARTER")).toHaveTextContent("No price set");
  });
});
