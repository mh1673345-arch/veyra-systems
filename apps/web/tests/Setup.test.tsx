import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  type BookingSettings,
  type BusinessProfile,
  type MembershipRole,
  ONBOARDING_STEPS,
  type OnboardingState,
  type Permission,
  type ReadinessReport
} from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { AuthProvider } from "../src/dashboard/AuthContext";
import { DashboardLayout } from "../src/dashboard/DashboardLayout";
import { SignupPage } from "../src/dashboard/SignupPage";
import { CreateWorkspacePage } from "../src/dashboard/CreateWorkspacePage";
import { SetupWizard } from "../src/dashboard/setup/SetupWizard";
import { OverviewPage } from "../src/dashboard/OverviewPage";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  const fn = () => vi.fn();
  return {
    ...actual,
    getSession: vi.fn(),
    signUp: vi.fn(),
    createWorkspace: vi.fn(),
    getOverview: vi.fn(),
    getCalendarSettings: vi.fn(),
    listMembers: vi.fn(),
    addMember: vi.fn(),
    setup: {
      onboarding: fn(), recordStep: fn(), profile: fn(), saveProfile: fn(),
      services: fn(), addService: fn(), updateService: fn(), archiveService: fn(), restoreService: fn(),
      faqs: fn(), addFaq: fn(), updateFaq: fn(), setFaqActive: fn(), reorderFaqs: fn(),
      hours: fn(), saveHours: fn(), booking: fn(), saveBooking: fn(), escalation: fn(), saveEscalation: fn(),
      reception: fn(), saveReception: fn(), readiness: fn(), activate: fn(), pause: fn(), knowledge: fn()
    }
  };
});

const BUSINESS_ID = "biz-new";
const OWNER: Permission[] = ["dashboard:read", "operations:write", "settings:read", "settings:write", "members:read", "members:write", "calendar:manage", "subscription:read"];
const OPERATOR: Permission[] = ["dashboard:read", "operations:write", "settings:read"];

function session(role: MembershipRole, permissions: Permission[], memberships = true) {
  vi.mocked(ops.getSession).mockResolvedValue({
    user: { id: "u1", email: "maya@harbour.example", name: "Maya" },
    memberships: memberships ? [{ businessId: BUSINESS_ID, businessName: "Harbour Physio", role, permissions }] : []
  });
}

function onboarding(statuses: Partial<Record<string, "complete" | "skipped" | "pending">> = {}): OnboardingState {
  const steps = ONBOARDING_STEPS.map((step) => ({ ...step, status: statuses[step.key] ?? ("pending" as const) }));
  return { businessId: BUSINESS_ID, steps, nextStep: steps.find((s) => s.status === "pending")?.key ?? null, completedAt: null };
}

const PROFILE: BusinessProfile = {
  businessId: BUSINESS_ID,
  name: "Harbour Physio",
  industry: "clinic",
  timezone: "Europe/London",
  contactPhone: "+44 20 7946 0000",
  contactEmail: "hello@harbour.example",
  website: null,
  address: "",
  description: ""
};

function booking(overrides: Partial<BookingSettings> = {}): BookingSettings {
  return {
    bookingRequestsEnabled: true,
    minNoticeMinutes: 240,
    maxHorizonDays: 60,
    slotIntervalMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    calendarBookingEnabled: false,
    calendarEntitled: false,
    calendarRequiredPlan: "PRO",
    ...overrides
  };
}

function renderRoutes(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/dashboard" element={<DashboardLayout />} />
          <Route path="/dashboard/new" element={<CreateWorkspacePage />} />
          <Route path="/dashboard/:businessId/setup" element={<SetupWizard />} />
          <Route path="/dashboard/:businessId/setup/:step" element={<SetupWizard />} />
          <Route path="/dashboard/:businessId" element={<OverviewPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  session("OWNER", OWNER);
  vi.mocked(ops.setup.onboarding).mockResolvedValue(onboarding());
  vi.mocked(ops.setup.profile).mockResolvedValue(PROFILE);
  vi.mocked(ops.setup.services).mockResolvedValue({ services: [] });
  vi.mocked(ops.setup.faqs).mockResolvedValue({ faqs: [] });
  vi.mocked(ops.setup.hours).mockResolvedValue({
    timezone: "Europe/London",
    days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, periods: [], bookable: true }))
  });
  vi.mocked(ops.setup.booking).mockResolvedValue(booking());
  vi.mocked(ops.setup.recordStep).mockResolvedValue(onboarding({ business_details: "complete" }));
  vi.mocked(ops.setup.reception).mockResolvedValue({
    status: "draft",
    statusChangedAt: null,
    assistantName: null,
    greeting: "Thanks for contacting Harbour Physio. How can I help you today?",
    tone: "professional",
    closingStyle: "none"
  });
  vi.mocked(ops.setup.knowledge).mockResolvedValue({
    business: {
      name: "Harbour Physio",
      industry: "clinic",
      description: "",
      address: "",
      phone: "+44 20 7946 0000",
      email: "hello@harbour.example",
      website: null,
      timezone: "Europe/London"
    },
    presentation: { assistantName: null, greeting: "Hi", tone: "professional", closingStyle: "none" },
    hoursSummary: "",
    services: [],
    faqs: [],
    booking: { requestsEnabled: true, liveCalendar: false, minNoticeMinutes: 240, maxHorizonDays: 60 },
    escalation: { enabled: true, phone: "+44 20 7946 0000", email: "hello@harbour.example" },
    integrations: { calendar: "not_in_plan" },
    planRestrictions: ["Live calendar booking is available on Pro."],
    status: "draft"
  });
});

describe("getting started", () => {
  it("creates an account and moves on to creating a workspace", { timeout: 20_000 }, async () => {
    session("OWNER", OWNER, false);
    vi.mocked(ops.getSession).mockRejectedValueOnce(new ops.ApiError(401, "Authentication required"));
    vi.mocked(ops.signUp).mockResolvedValue({ user: { id: "u1", email: "maya@harbour.example", name: "Maya" } });
    renderRoutes("/signup");

    await userEvent.type(await screen.findByLabelText("Your name"), "Maya");
    await userEvent.type(screen.getByLabelText("Email"), "maya@harbour.example");
    await userEvent.type(screen.getByLabelText("Password"), "harbour-quay-lantern-7391");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(ops.signUp).toHaveBeenCalledWith("Maya", "maya@harbour.example", "harbour-quay-lantern-7391");
    expect(await screen.findByTestId("create-workspace-form")).toBeInTheDocument();
  });

  it("offers a new user with no business a way to set one up", async () => {
    session("OWNER", OWNER, false);
    renderRoutes("/dashboard");
    expect(await screen.findByTestId("create-workspace-link")).toHaveTextContent("Set up your business");
  });

  it("creates a workspace with the details given and opens setup", { timeout: 20_000 }, async () => {
    vi.mocked(ops.createWorkspace).mockResolvedValue({ businessId: BUSINESS_ID, name: "Harbour Physio", receptionStatus: "draft" });
    renderRoutes("/dashboard/new");

    await userEvent.type(await screen.findByLabelText("Business name"), "Harbour Physio");
    await userEvent.selectOptions(screen.getByLabelText("Industry"), "clinic");
    await userEvent.clear(screen.getByLabelText("Contact email"));
    await userEvent.type(screen.getByLabelText("Contact email"), "hello@harbour.example");
    await userEvent.type(screen.getByLabelText("Phone"), "+44 20 7946 0000");
    await userEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(ops.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Harbour Physio", industry: "clinic", email: "hello@harbour.example", phone: "+44 20 7946 0000" })
    );
    expect(await screen.findByTestId("setup-progress")).toBeInTheDocument();
  });

  it("shows the server's validation message", { timeout: 20_000 }, async () => {
    vi.mocked(ops.createWorkspace).mockRejectedValue(new ops.ApiError(400, "Enter a valid phone number."));
    renderRoutes("/dashboard/new");
    await userEvent.type(await screen.findByLabelText("Business name"), "X Clinic");
    await userEvent.type(screen.getByLabelText("Phone"), "abc");
    await userEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid phone number.");
  });
});

describe("setup wizard", () => {
  it("shows progress and resumes at the next unfinished step", async () => {
    vi.mocked(ops.setup.onboarding).mockResolvedValue(onboarding({ business_details: "complete", services: "skipped" }));
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup`);

    expect(await screen.findByTestId("setup-step-title")).toHaveTextContent("FAQs & knowledge");
    const progress = screen.getByTestId("setup-progress");
    expect(within(progress).getByText("Business details").closest("li")).toHaveClass("ops-step-complete");
    expect(within(progress).getByText("Services").closest("li")).toHaveClass("ops-step-skipped");
  });

  it("saves the step's data, then asks the server to mark it complete", async () => {
    vi.mocked(ops.setup.saveProfile).mockResolvedValue({ ...PROFILE, description: "Sports injuries." });
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/business_details`);

    const description = await screen.findByLabelText("Short description");
    await userEvent.type(description, "Sports injuries.");
    await userEvent.click(screen.getByRole("button", { name: "Save & continue" }));

    await waitFor(() => expect(ops.setup.recordStep).toHaveBeenCalledWith(BUSINESS_ID, "business_details", "complete"));
    expect(ops.setup.saveProfile).toHaveBeenCalledWith(BUSINESS_ID, expect.objectContaining({ description: "Sports injuries." }));
    expect(await screen.findByTestId("setup-step-title")).toHaveTextContent("Services");
  });

  it("shows the server's refusal instead of advancing", async () => {
    vi.mocked(ops.setup.recordStep).mockRejectedValue(new ops.ApiError(422, "Add at least one service, or skip this step."));
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/services`);

    await userEvent.click(await screen.findByRole("button", { name: "Save & continue" }));
    expect(await screen.findByTestId("setup-error")).toHaveTextContent("Add at least one service");
    expect(screen.getByTestId("setup-step-title")).toHaveTextContent("Services");
  });

  it("lets optional steps be skipped, but not required ones", async () => {
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/services`);
    await userEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(ops.setup.recordStep).toHaveBeenCalledWith(BUSINESS_ID, "services", "skip");

    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/review`);
    await screen.findAllByTestId("setup-step-title");
    expect(screen.queryAllByRole("button", { name: "Skip for now" })).toHaveLength(1);
  });

  it("starts empty, and suggests services and questions without inventing prices or answers", async () => {
    vi.mocked(ops.setup.addService).mockResolvedValue({ services: [] });
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/services`);

    expect(await screen.findByTestId("services-empty")).toHaveTextContent("No services yet");
    await userEvent.click(screen.getByRole("button", { name: "Initial consultation" }));
    expect(screen.getByLabelText("Service name")).toHaveValue("Initial consultation");
    expect(screen.getByLabelText("Service price")).toHaveValue("");
  });

  it("prefills only the question from a suggested FAQ — the business writes the answer", async () => {
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/knowledge`);
    expect(await screen.findByTestId("faqs-empty")).toHaveTextContent("No FAQs yet");

    await userEvent.click(screen.getByRole("button", { name: "Do I need a referral?" }));
    expect(screen.getByLabelText("FAQ question")).toHaveValue("Do I need a referral?");
    expect(screen.getByLabelText("FAQ answer")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add question" })).toBeDisabled();
  });

  it("edits a split-day schedule and saves it", async () => {
    vi.mocked(ops.setup.saveHours).mockImplementation(async (_id, days) => ({ timezone: "Europe/London", days }));
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/hours`);

    await userEvent.click(await screen.findByLabelText("Monday open"));
    await userEvent.click(screen.getByRole("button", { name: "+ period" }));
    await userEvent.click(screen.getByRole("button", { name: "Save & continue" }));

    await waitFor(() => expect(ops.setup.saveHours).toHaveBeenCalled());
    const monday = vi.mocked(ops.setup.saveHours).mock.calls[0][1].find((day) => day.dayOfWeek === 1)!;
    expect(monday.periods).toEqual([
      { opens: "09:00", closes: "17:00" },
      { opens: "14:00", closes: "17:00" }
    ]);
  });

  it("shows Starter the request-only booking setup with live calendar locked", async () => {
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/booking`);
    const calendar = await screen.findByTestId("booking-calendar");
    expect(calendar).toHaveTextContent("Live calendar booking");
    expect(calendar).toHaveTextContent("available on Pro");
    expect(within(calendar).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows Pro the live calendar control", async () => {
    vi.mocked(ops.setup.booking).mockResolvedValue(booking({ calendarEntitled: true }));
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/booking`);
    const calendar = await screen.findByTestId("booking-calendar");
    expect(within(calendar).getByRole("checkbox")).toBeInTheDocument();
  });

  it("refuses to go live while something blocks, and goes live when ready", async () => {
    const blocked: ReadinessReport = {
      businessId: BUSINESS_ID,
      canActivate: false,
      status: "draft",
      checks: [{ key: "contact_method", level: "blocking", message: "Add a phone number or email." }]
    };
    vi.mocked(ops.setup.readiness).mockResolvedValueOnce(blocked);
    const { unmount } = renderRoutes(`/dashboard/${BUSINESS_ID}/setup/go_live`);
    expect(await screen.findByRole("button", { name: "Go live" })).toBeDisabled();
    expect(screen.getByTestId("golive-blocked")).toBeInTheDocument();
    unmount();

    const ready: ReadinessReport = {
      ...blocked,
      canActivate: true,
      checks: [{ key: "services", level: "warning", message: "No services yet." }]
    };
    vi.mocked(ops.setup.readiness).mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, status: "active" });
    vi.mocked(ops.setup.activate).mockResolvedValue({
      status: "active",
      statusChangedAt: null,
      assistantName: null,
      greeting: "Hi",
      tone: "professional",
      closingStyle: "none"
    });
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/go_live`);
    await userEvent.click(await screen.findByRole("button", { name: "Go live" }));
    expect(ops.setup.activate).toHaveBeenCalledWith(BUSINESS_ID);
    expect(await screen.findByTestId("reception-status")).toHaveTextContent("Live");
    expect(screen.getByRole("button", { name: "Pause Reception" })).toBeInTheDocument();
  });

  it("is read-only for an operator", async () => {
    session("OPERATOR", OPERATOR);
    renderRoutes(`/dashboard/${BUSINESS_ID}/setup/business_details`);

    expect(await screen.findByTestId("setup-readonly")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save & continue" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Business name")).toBeDisabled();
  });
});

describe("overview", () => {
  it("reminds the owner that Reception isn't live yet", async () => {
    vi.mocked(ops.getOverview).mockReturnValue(new Promise(() => {}));
    vi.mocked(ops.setup.reception).mockResolvedValue({
      status: "draft",
      statusChangedAt: null,
      assistantName: null,
      greeting: "Hi",
      tone: "professional",
      closingStyle: "none"
    });
    renderRoutes(`/dashboard/${BUSINESS_ID}`);
    expect(await screen.findByTestId("reception-banner")).toHaveTextContent("isn't live yet");
  });
});
