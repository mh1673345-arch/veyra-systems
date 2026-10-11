import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { MembershipRole, Permission, PilotIssueDto, PilotOverview, PilotReport } from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { AuthProvider } from "../src/dashboard/AuthContext";
import { PilotPage } from "../src/dashboard/pilot/PilotPage";
import { PilotIssuesPage } from "../src/dashboard/pilot/PilotIssuesPage";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  return {
    ...actual,
    getSession: vi.fn(),
    getPilotOverview: vi.fn(),
    getPilotSeries: vi.fn(),
    getKnowledgeGaps: vi.fn(),
    getPilotTimeline: vi.fn(),
    getPilotReport: vi.fn(),
    setPilotStatus: vi.fn(),
    setPilotSafety: vi.fn(),
    setPilotTargets: vi.fn(),
    listPilotIssues: vi.fn(),
    updatePilotIssue: vi.fn()
  };
});

const BUSINESS_ID = "biz-1";

const OWNER_PERMISSIONS: Permission[] = [
  "dashboard:read",
  "operations:write",
  "settings:read",
  "subscription:read",
  "pilot:read",
  "pilot:manage",
  "pilot:report",
  "pilot:triage"
];
const VIEWER_PERMISSIONS: Permission[] = ["dashboard:read", "settings:read", "pilot:read"];

function mockSession(role: MembershipRole, permissions: Permission[]) {
  vi.mocked(ops.getSession).mockResolvedValue({
    user: { id: "user-1", email: "owner@veyra.test", name: "Test Owner" },
    memberships: [{ businessId: BUSINESS_ID, businessName: "Bright Smile Studio", role, permissions }]
  });
}

const range = {
  key: "last_7_days" as const,
  from: "2026-09-18T00:00:00.000Z",
  to: "2026-09-25T00:00:00.000Z",
  timezone: "America/New_York",
  label: "Last 7 days"
};

function overview(patch: Partial<PilotOverview> = {}): PilotOverview {
  return {
    businessId: BUSINESS_ID,
    businessName: "Bright Smile Studio",
    timezone: "America/New_York",
    pilot: { status: "preparing", startedAt: null, endedAt: null, label: null, notes: null },
    targets: {
      targetConversations: null,
      targetBookingRequests: null,
      targetConfirmedBookings: null,
      maxHumanInterventionRate: null,
      maxUnresolvedIssues: null
    },
    safety: {
      allowAutoBooking: true,
      allowAutoReschedule: true,
      allowAutoCancellation: true,
      allowEscalation: true,
      allowNotifications: true
    },
    safetyLockedByPlan: [],
    plan: "PRO",
    subscriptionStatus: "active",
    receptionStatus: "active",
    readiness: {
      businessId: BUSINESS_ID,
      canActivate: true,
      requiresLiveBooking: false,
      level: "ready",
      checks: [{ key: "reception_live", level: "ready", message: "Reception is live and answering callers." }]
    },
    health: [{ key: "responder", label: "Reception responder", level: "ok", detail: "Answering normally." }],
    alerts: [],
    metrics: {
      range,
      activity: [{ key: "conversations", label: "Conversations", value: 12, definition: "Conversations started in the period." }],
      outcomes: [{ key: "escalations", label: "Handoffs to a person", value: 0, definition: "Escalations created in the period." }],
      derived: [
        {
          key: "booking_conversion",
          label: "Booking conversion",
          value: null,
          definition: "Booking requests ÷ conversations where the caller said something.",
          unavailableReason: "Needs at least 20 in the period before a rate means anything."
        }
      ]
    },
    openIssues: 2,
    canManage: true,
    canReport: true,
    canTriage: true,
    ...patch
  };
}

const openIssue: PilotIssueDto = {
  id: "issue-7",
  businessId: BUSINESS_ID,
  conversationId: "conv-9",
  messageId: null,
  category: "missing_business_information",
  note: "Caller asked about parking and Veyra had nothing on file.",
  status: "open",
  resolutionNote: null,
  reportedBy: "Sam Operator",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-09-24T09:00:00.000Z",
  updatedAt: "2026-09-24T09:00:00.000Z"
};

function report(patch: Partial<PilotReport> = {}): PilotReport {
  return {
    businessId: BUSINESS_ID,
    businessName: "Bright Smile Studio",
    generatedAt: "2026-09-25T12:00:00.000Z",
    range,
    metrics: { range, activity: [], outcomes: [], derived: [] },
    series: [],
    topIntents: [],
    knowledgeGaps: [],
    issuesByCategory: [
      { category: "missing_business_information", label: "Business information missing", open: 6, total: 6 },
      { category: "incorrect_answer", label: "Veyra answered incorrectly", open: 0, total: 2 }
    ],
    unresolvedIssues: [openIssue],
    outcomes: [],
    recommendations: [
      { message: "Add an FAQ describing parking options.", evidence: "Parking came up in 8 separate conversations with nothing on file." }
    ],
    ...patch
  };
}

function renderPilot(path = `/dashboard/${BUSINESS_ID}/pilot`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/dashboard/:businessId/pilot" element={<PilotPage />} />
          <Route path="/dashboard/:businessId/pilot/issues" element={<PilotIssuesPage />} />
          <Route path="*" element={<div />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession("OWNER", OWNER_PERMISSIONS);
  vi.mocked(ops.getPilotOverview).mockResolvedValue(overview());
  vi.mocked(ops.getPilotSeries).mockResolvedValue({
    range,
    series: [{ date: "2026-09-24", conversations: 3, bookings: 1, escalations: 0 }],
    topIntents: [{ intent: "pricing", label: "Pricing", count: 5 }],
    outcomes: [{ outcome: "answered", label: "Answered", count: 4 }]
  });
  vi.mocked(ops.getKnowledgeGaps).mockResolvedValue({ range, gaps: [] });
  vi.mocked(ops.getPilotTimeline).mockResolvedValue({ range, entries: [] });
  vi.mocked(ops.getPilotReport).mockResolvedValue(report());
  vi.mocked(ops.listPilotIssues).mockResolvedValue([]);
});

describe("pilot dashboard", () => {
  it("shows measured counts and says what the numbers are not", async () => {
    renderPilot();

    expect(await screen.findByTestId("metric-conversations")).toHaveTextContent("12");
    expect(screen.getByTestId("pilot-measurement-note")).toHaveTextContent(
      /not revenue, time saved or customer satisfaction/i
    );
  });

  it("renders an unmeasurable rate as 'Not available', never as zero", async () => {
    renderPilot();

    const conversion = await screen.findByTestId("metric-booking_conversion");
    expect(conversion).toHaveTextContent("Not available");
    expect(conversion).not.toHaveTextContent(/\b0\b/);
    // The definition and the reason travel with it.
    expect(conversion).toHaveTextContent("Booking requests ÷ conversations");
    expect(conversion).toHaveTextContent(/at least 20/);
  });

  it("shows an empty state rather than an empty chart shape", async () => {
    vi.mocked(ops.getPilotSeries).mockResolvedValue({
      range,
      series: [{ date: "2026-09-24", conversations: 0, bookings: 0, escalations: 0 }],
      topIntents: [],
      outcomes: []
    });
    renderPilot();

    expect(await screen.findByTestId("pilot-chart-empty")).toHaveTextContent(/No activity in this period/i);
    expect(screen.queryByTestId("pilot-activity-chart")).not.toBeInTheDocument();
  });

  it("charts real daily counts when there are some", async () => {
    renderPilot();
    expect(await screen.findByTestId("pilot-activity-chart")).toBeInTheDocument();
    expect(screen.getByTestId("pilot-intents")).toHaveTextContent("Pricing");
  });

  it("offers only the pilot transitions the state allows", async () => {
    renderPilot();

    // From "preparing": activate or clear — never straight to completed.
    expect(await screen.findByTestId("pilot-set-active")).toBeInTheDocument();
    expect(screen.getByTestId("pilot-set-none")).toBeInTheDocument();
    expect(screen.queryByTestId("pilot-set-completed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pilot-set-paused")).not.toBeInTheDocument();
  });

  it("activates the pilot through the server", async () => {
    vi.mocked(ops.setPilotStatus).mockResolvedValue({
      status: "active",
      startedAt: "2026-09-25T10:00:00.000Z",
      endedAt: null,
      label: null,
      notes: null
    });
    renderPilot();

    await userEvent.click(await screen.findByTestId("pilot-set-active"));
    expect(ops.setPilotStatus).toHaveBeenCalledWith(BUSINESS_ID, "active");
    expect(await screen.findByTestId("pilot-notice")).toHaveTextContent(/moved to active/i);
  });

  it("marks a safety control the plan doesn't include, and still cannot grant it", async () => {
    vi.mocked(ops.getPilotOverview).mockResolvedValue(
      overview({
        plan: "STARTER",
        safety: {
          allowAutoBooking: true,
          allowAutoReschedule: true,
          allowAutoCancellation: true,
          allowEscalation: true,
          allowNotifications: true
        },
        safetyLockedByPlan: ["allowAutoBooking", "allowAutoReschedule"]
      })
    );
    renderPilot();

    expect(await screen.findByTestId("safety-allowAutoBooking")).toHaveTextContent(/not in this plan anyway/i);
  });

  it("is read-only for a viewer", async () => {
    mockSession("VIEWER", VIEWER_PERMISSIONS);
    vi.mocked(ops.getPilotOverview).mockResolvedValue(overview({ canManage: false, canReport: false, canTriage: false }));
    renderPilot();

    expect(await screen.findByTestId("pilot-metrics")).toBeInTheDocument();
    expect(screen.queryByTestId("pilot-set-active")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pilot-save-targets")).not.toBeInTheDocument();
    expect(screen.queryByTestId("safety-toggle-allowAutoBooking")).not.toBeInTheDocument();
    expect(screen.getByTestId("pilot-status-panel")).toHaveTextContent(/Only an owner or admin can change/i);
  });

  it("asks the server for the range the operator picked", async () => {
    renderPilot();
    await screen.findByTestId("pilot-metrics");

    await userEvent.click(screen.getByRole("button", { name: "30 days" }));
    expect(ops.getPilotOverview).toHaveBeenLastCalledWith(BUSINESS_ID, { range: "last_30_days" });
  });

  it("does not query a custom range until both dates are set", async () => {
    renderPilot();
    await screen.findByTestId("pilot-metrics");
    vi.mocked(ops.getPilotOverview).mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.getByTestId("pilot-custom-range")).toHaveTextContent(/Pick both dates/i);
    expect(ops.getPilotOverview).not.toHaveBeenCalled();
  });

  it("surfaces alerts with the threshold that produced them", async () => {
    vi.mocked(ops.getPilotOverview).mockResolvedValue(
      overview({
        alerts: [
          {
            key: "fallback_rate",
            level: "warning",
            message: "45% of replies fell back to the deterministic responder.",
            threshold: "Warns above 30% over at least 20 replies."
          }
        ]
      })
    );
    renderPilot();

    const alerts = await screen.findByTestId("pilot-alerts");
    expect(alerts).toHaveTextContent("45% of replies fell back");
    // No silent thresholds: the rule is shown next to the warning.
    expect(alerts).toHaveTextContent("Warns above 30%");
  });

  it("shows knowledge gaps with what would fix them", async () => {
    vi.mocked(ops.getKnowledgeGaps).mockResolvedValue({
      range,
      gaps: [
        {
          kind: "missing_faq",
          topic: "parking",
          topicLabel: "Parking",
          conversations: 8,
          lastSeenAt: "2026-09-24T10:00:00.000Z",
          suggestion: "Add an FAQ describing parking options."
        }
      ]
    });
    renderPilot();

    const table = await screen.findByTestId("pilot-gaps-table");
    expect(within(table).getByText("Parking")).toBeInTheDocument();
    expect(table).toHaveTextContent("8");
    expect(table).toHaveTextContent("Add an FAQ describing parking options.");
  });
});

describe("pilot issues", () => {
  it("lists issues and lets an operator resolve one", async () => {
    vi.mocked(ops.listPilotIssues).mockResolvedValue([
      {
        id: "issue-1",
        businessId: BUSINESS_ID,
        conversationId: "conv-1",
        messageId: null,
        category: "incorrect_answer",
        note: "Told the caller we're open Sunday.",
        status: "open",
        resolutionNote: null,
        reportedBy: "Sam Operator",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: "2026-09-24T10:00:00.000Z",
        updatedAt: "2026-09-24T10:00:00.000Z"
      }
    ]);
    vi.mocked(ops.updatePilotIssue).mockResolvedValue({
      id: "issue-1",
      businessId: BUSINESS_ID,
      conversationId: "conv-1",
      messageId: null,
      category: "incorrect_answer",
      note: null,
      status: "resolved",
      resolutionNote: null,
      reportedBy: "Sam Operator",
      resolvedBy: "Test Owner",
      resolvedAt: "2026-09-25T10:00:00.000Z",
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-25T10:00:00.000Z"
    });

    renderPilot(`/dashboard/${BUSINESS_ID}/pilot/issues`);

    expect(await screen.findByText("Veyra answered incorrectly")).toBeInTheDocument();
    expect(screen.getByText(/Told the caller we're open Sunday/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("issue-resolved-issue-1"));
    expect(ops.updatePilotIssue).toHaveBeenCalledWith(BUSINESS_ID, "issue-1", {
      status: "resolved",
      resolutionNote: undefined
    });
  });

  it("gives a viewer no triage actions", async () => {
    mockSession("VIEWER", VIEWER_PERMISSIONS);
    vi.mocked(ops.listPilotIssues).mockResolvedValue([
      {
        id: "issue-2",
        businessId: BUSINESS_ID,
        conversationId: null,
        messageId: null,
        category: "bad_tone",
        note: null,
        status: "open",
        resolutionNote: null,
        reportedBy: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: "2026-09-24T10:00:00.000Z",
        updatedAt: "2026-09-24T10:00:00.000Z"
      }
    ]);
    renderPilot(`/dashboard/${BUSINESS_ID}/pilot/issues`);

    expect(await screen.findByText("Tone was wrong")).toBeInTheDocument();
    expect(screen.queryByTestId("issue-resolved-issue-2")).not.toBeInTheDocument();
  });

  it("shows an empty queue plainly", async () => {
    renderPilot(`/dashboard/${BUSINESS_ID}/pilot/issues`);
    expect(await screen.findByTestId("issues-empty")).toHaveTextContent(/Nothing reported/i);
  });
});

describe("pilot report on the Pilot page", () => {
  it("renders each recommendation with the evidence behind it", async () => {
    renderPilot();

    const section = await screen.findByTestId("pilot-report");
    const recommendation = within(section).getByTestId("recommendation-0");
    expect(recommendation).toHaveTextContent("Add an FAQ describing parking options.");
    // A recommendation without its evidence would be indistinguishable from advice.
    expect(within(section).getByTestId("recommendation-evidence-0")).toHaveTextContent(
      "Parking came up in 8 separate conversations with nothing on file."
    );
  });

  it("states which period the report covers", async () => {
    renderPilot();

    const rangeLine = await screen.findByTestId("pilot-report-range");
    expect(rangeLine).toHaveTextContent("Last 7 days");
    expect(rangeLine).toHaveTextContent("America/New_York");
    expect(rangeLine).toHaveTextContent(/same period as the metrics above/i);
  });

  it("summarises issues by category with open and total counts", async () => {
    renderPilot();

    const table = await screen.findByTestId("pilot-issue-categories");
    const row = within(table).getByTestId("issue-category-missing_business_information");
    expect(row).toHaveTextContent("Business information missing");
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "Business information missing",
      "6",
      "6"
    ]);
    // A resolved category still shows what was reported, with nothing open.
    expect(within(table).getByTestId("issue-category-incorrect_answer")).toHaveTextContent("0");
  });

  it("lists unresolved issues with status, time and a short note", async () => {
    renderPilot();

    const list = await screen.findByTestId("pilot-unresolved-issues");
    const item = within(list).getByTestId("unresolved-issue-issue-7");
    expect(item).toHaveTextContent("Business information missing");
    expect(item).toHaveTextContent("open");
    expect(item).toHaveTextContent(/reported/i);
    expect(item).toHaveTextContent("Caller asked about parking and Veyra had nothing on file.");
    // The report deliberately lists every outstanding issue, not just this
    // period's, so the section says so rather than letting it be misread.
    expect(screen.getByTestId("pilot-unresolved-scope")).toHaveTextContent(/not\s+limited to the selected period/i);
  });

  it("links an unresolved issue to the issue itself and to its conversation", async () => {
    renderPilot();

    await screen.findByTestId("pilot-unresolved-issues");
    expect(screen.getByTestId("unresolved-issue-link-issue-7")).toHaveAttribute(
      "href",
      `/dashboard/${BUSINESS_ID}/pilot/issues#issue-issue-7`
    );
    expect(screen.getByTestId("unresolved-conversation-link-issue-7")).toHaveAttribute(
      "href",
      `/dashboard/${BUSINESS_ID}/conversations/conv-9`
    );
  });

  it("omits the conversation link when the issue has no conversation", async () => {
    vi.mocked(ops.getPilotReport).mockResolvedValue(
      report({ unresolvedIssues: [{ ...openIssue, conversationId: null, note: null }] })
    );
    renderPilot();

    await screen.findByTestId("pilot-unresolved-issues");
    expect(screen.getByTestId("unresolved-issue-link-issue-7")).toBeInTheDocument();
    expect(screen.queryByTestId("unresolved-conversation-link-issue-7")).not.toBeInTheDocument();
  });

  it("says plainly when there is nothing to recommend yet", async () => {
    vi.mocked(ops.getPilotReport).mockResolvedValue(report({ recommendations: [] }));
    renderPilot();

    expect(await screen.findByTestId("pilot-recommendations-empty")).toHaveTextContent(
      "No recommendations yet — more pilot activity is needed."
    );
    expect(screen.queryByTestId("pilot-recommendations")).not.toBeInTheDocument();
  });

  it("says plainly when no issues are outstanding", async () => {
    vi.mocked(ops.getPilotReport).mockResolvedValue(report({ unresolvedIssues: [], issuesByCategory: [] }));
    renderPilot();

    expect(await screen.findByTestId("pilot-unresolved-empty")).toHaveTextContent("No unresolved pilot issues.");
    expect(await screen.findByTestId("pilot-issue-categories-empty")).toHaveTextContent(
      /No issues were reported in this period/i
    );
  });

  it("refetches the report for the range the operator picked", async () => {
    renderPilot();
    await screen.findByTestId("pilot-report");
    expect(ops.getPilotReport).toHaveBeenLastCalledWith(BUSINESS_ID, { range: "last_7_days" });

    vi.mocked(ops.getPilotReport).mockResolvedValue(
      report({
        range: { ...range, key: "last_30_days", label: "Last 30 days" },
        recommendations: [{ message: "Work through the open handoffs.", evidence: "3 of 4 handoffs are unresolved." }]
      })
    );
    await userEvent.click(screen.getByRole("button", { name: "30 days" }));

    // The report and the metrics always move together.
    expect(ops.getPilotReport).toHaveBeenLastCalledWith(BUSINESS_ID, { range: "last_30_days" });
    expect(ops.getPilotOverview).toHaveBeenLastCalledWith(BUSINESS_ID, { range: "last_30_days" });
    expect(await screen.findByTestId("pilot-report-range")).toHaveTextContent("Last 30 days");
    expect(await screen.findByTestId("recommendation-0")).toHaveTextContent("Work through the open handoffs.");
  });

  it("is visible to a viewer, who can read it but change nothing", async () => {
    mockSession("VIEWER", VIEWER_PERMISSIONS);
    vi.mocked(ops.getPilotOverview).mockResolvedValue(overview({ canManage: false, canReport: false, canTriage: false }));
    renderPilot();

    expect(await screen.findByTestId("pilot-report")).toBeInTheDocument();
    expect(screen.getByTestId("recommendation-0")).toBeInTheDocument();
    expect(screen.queryByTestId("pilot-set-active")).not.toBeInTheDocument();
  });
});
