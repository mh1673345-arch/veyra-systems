import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { CallDetail, CallSummary, MembershipRole, Permission, VoiceOverview } from "@veyra/shared";
import * as ops from "../src/dashboard/opsClient";
import { AuthProvider } from "../src/dashboard/AuthContext";
import { VoiceSettings } from "../src/dashboard/voice/VoiceSettings";
import { CallDetailPage, CallsPage } from "../src/dashboard/voice/CallsPage";

vi.mock("../src/dashboard/opsClient", async () => {
  const actual = await vi.importActual<typeof ops>("../src/dashboard/opsClient");
  return {
    ...actual,
    getSession: vi.fn(),
    getVoiceOverview: vi.fn(),
    updateVoiceSettings: vi.fn(),
    listCalls: vi.fn(),
    getCall: vi.fn(),
    simulateCall: vi.fn(),
    simulateCallerSpeech: vi.fn(),
    simulateHangup: vi.fn()
  };
});

const BUSINESS_ID = "biz-1";

const OWNER_PERMISSIONS: Permission[] = [
  "dashboard:read",
  "operations:write",
  "settings:read",
  "settings:write",
  "subscription:read"
];
const VIEWER_PERMISSIONS: Permission[] = ["dashboard:read", "settings:read"];

function mockSession(role: MembershipRole, permissions: Permission[]) {
  vi.mocked(ops.getSession).mockResolvedValue({
    user: { id: "user-1", email: "owner@veyra.test", name: "Test Owner" },
    memberships: [{ businessId: BUSINESS_ID, businessName: "Bright Smile Studio", role, permissions }]
  });
}

function overview(patch: Partial<VoiceOverview> = {}): VoiceOverview {
  return {
    businessId: BUSINESS_ID,
    entitled: true,
    requiredPlan: null,
    plan: "MAX",
    settings: {
      businessId: BUSINESS_ID,
      enabled: true,
      provider: null,
      businessPhoneNumber: "+15551234567",
      callerId: null,
      language: "en-US",
      voiceProfile: "neutral",
      greeting: null,
      afterHoursBehavior: "continue",
      handoffNumber: "+15559876543",
      voicemailGreeting: null,
      maxCallSeconds: 600,
      recordingPolicy: "disabled",
      transcriptPolicy: "store"
    },
    provider: { name: "fake", configured: true, healthy: true, detail: "Development voice provider — no real calls are placed.", simulated: true },
    speech: {
      stt: { name: "fake", configured: false, healthy: true, detail: "Development speech recognition — no audio is transcribed.", simulated: true },
      tts: { name: "fake", configured: false, healthy: true, detail: "Development speech synthesis — no audio is produced.", simulated: true }
    },
    live: true,
    blockedReason: null,
    usage: { minutesThisPeriod: 12, limit: 1000, calls: 4 },
    canManage: true,
    ...patch
  };
}

const call: CallSummary = {
  id: "call-1",
  businessId: BUSINESS_ID,
  conversationId: "conv-1",
  direction: "inbound",
  status: "completed",
  callerNumber: "+15…4321",
  startedAt: "2026-09-26T10:00:00.000Z",
  endedAt: "2026-09-26T10:03:00.000Z",
  durationSeconds: 182,
  handoffOccurred: false,
  outcome: "booking",
  bookingId: "booking-1",
  escalationId: null
};

function detail(patch: Partial<CallDetail> = {}): CallDetail {
  return {
    ...call,
    businessNumber: "+15…4567",
    hangupReason: "caller_hangup",
    provider: "fake",
    turns: [
      { at: "2026-09-26T10:00:01.000Z", speaker: "veyra", text: "Thanks for calling.", intent: null, action: null, latency: null, interrupted: false },
      {
        at: "2026-09-26T10:00:09.000Z",
        speaker: "caller",
        text: "How much is whitening?",
        intent: null,
        action: null,
        latency: null,
        interrupted: false
      },
      {
        at: "2026-09-26T10:00:10.000Z",
        speaker: "veyra",
        text: "Teeth whitening is $250.",
        intent: "pricing",
        action: "none",
        latency: { responderMs: 40, actionMs: 5, ttsMs: 30, totalMs: 90 },
        interrupted: false
      }
    ],
    transcriptStored: true,
    recordingEnabled: false,
    latencySummary: { turns: 1, medianTotalMs: 90, p95TotalMs: 90 },
    ...patch
  };
}

function renderAt(path: string, element: React.ReactElement, routePath: string) {
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

const renderVoiceSettings = () =>
  renderAt(`/dashboard/${BUSINESS_ID}/settings`, <VoiceSettings businessId={BUSINESS_ID} />, "/dashboard/:businessId/settings");

beforeEach(() => {
  vi.clearAllMocks();
  mockSession("OWNER", OWNER_PERMISSIONS);
  vi.mocked(ops.getVoiceOverview).mockResolvedValue(overview());
  vi.mocked(ops.listCalls).mockResolvedValue([call]);
  vi.mocked(ops.getCall).mockResolvedValue(detail());
});

describe("voice settings", () => {
  it("shows voice as a Max feature to a plan that doesn't include it, and no phone number", async () => {
    vi.mocked(ops.getVoiceOverview).mockResolvedValue(
      overview({
        entitled: false,
        requiredPlan: "MAX",
        plan: "PRO",
        settings: null,
        live: false,
        blockedReason: "Voice is part of Max. This plan doesn't include it."
      })
    );
    renderVoiceSettings();

    const locked = await screen.findByTestId("voice-locked");
    expect(locked).toHaveTextContent(/part of Max/i);
    // No invented phone number anywhere on a locked plan.
    expect(screen.queryByTestId("voice-number")).not.toBeInTheDocument();
    expect(locked.textContent).not.toMatch(/\+\d{6,}/);
    expect(screen.getByTestId("voice-rollout-note")).toHaveTextContent(/Voice setup \/ rollout required/i);
  });

  it("says why voice is not live rather than implying the phone is ringing", async () => {
    vi.mocked(ops.getVoiceOverview).mockResolvedValue(
      overview({
        live: false,
        blockedReason: "No voice provider is configured on this server yet.",
        provider: { name: null, configured: false, healthy: false, detail: "No voice provider is configured on this server.", simulated: false }
      })
    );
    renderVoiceSettings();

    expect(await screen.findByTestId("voice-status")).toHaveTextContent("Voice is not live");
    expect(screen.getByTestId("voice-blocked-reason")).toHaveTextContent(/No voice provider is configured/i);
  });

  it("shows live status, provider, usage and that the provider is simulated", async () => {
    renderVoiceSettings();

    expect(await screen.findByTestId("voice-status")).toHaveTextContent("Voice is live");
    expect(screen.getByTestId("voice-usage")).toHaveTextContent("12 of 1000");
    expect(screen.getByTestId("voice-simulated")).toHaveTextContent(/no real calls/i);
  });

  it("saves configuration through the server", async () => {
    vi.mocked(ops.updateVoiceSettings).mockResolvedValue(overview());
    renderVoiceSettings();

    const greeting = await screen.findByTestId("voice-greeting");
    await userEvent.clear(greeting);
    await userEvent.type(greeting, "Thanks for calling Bright Smile.");
    await userEvent.click(screen.getByTestId("voice-save"));

    expect(ops.updateVoiceSettings).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.objectContaining({ greeting: "Thanks for calling Bright Smile." })
    );
  });

  it("does not offer recording, and says so", async () => {
    renderVoiceSettings();
    await screen.findByTestId("voice-status");
    expect(screen.getByTestId("voice-settings")).toHaveTextContent(/Call recording is/i);
    expect(screen.queryByText(/enable recording/i)).not.toBeInTheDocument();
  });

  it("is read-only for a member who cannot change settings", async () => {
    mockSession("VIEWER", VIEWER_PERMISSIONS);
    vi.mocked(ops.getVoiceOverview).mockResolvedValue(overview({ canManage: false }));
    renderVoiceSettings();

    expect(await screen.findByTestId("voice-status")).toBeInTheDocument();
    expect(screen.queryByTestId("voice-save")).not.toBeInTheDocument();
    expect(screen.getByTestId("voice-settings")).toHaveTextContent(/Only an owner or admin can change/i);
  });
});

describe("calls", () => {
  const renderCalls = () => renderAt(`/dashboard/${BUSINESS_ID}/calls`, <CallsPage />, "/dashboard/:businessId/calls");

  it("lists calls with a masked number, duration and outcome", async () => {
    renderCalls();

    const table = await screen.findByTestId("calls-table");
    expect(table).toHaveTextContent("+15…4321");
    expect(table).toHaveTextContent("3m 02s");
    expect(table).toHaveTextContent("Booking");
    // Never a full phone number in the list.
    expect(table.textContent).not.toMatch(/\+1555\d{6}/);
  });

  it("offers the simulator only on the development provider", async () => {
    renderCalls();
    expect(await screen.findByTestId("call-simulator")).toBeInTheDocument();

    vi.mocked(ops.getVoiceOverview).mockResolvedValue(
      overview({ provider: { name: "twilio", configured: true, healthy: true, detail: "Twilio account reachable.", simulated: false } })
    );
    renderCalls();
    expect(await screen.findAllByTestId("calls-table")).not.toHaveLength(0);
    expect(screen.queryAllByTestId("call-simulator")).toHaveLength(1); // only the first render's
  });

  it("runs a simulated call through the same pipeline", async () => {
    vi.mocked(ops.simulateCall).mockResolvedValue({
      externalCallId: "call_fake_1",
      callSessionId: "cs-1",
      spoken: ["Thanks for calling Bright Smile Studio."]
    });
    vi.mocked(ops.simulateCallerSpeech).mockResolvedValue({
      externalCallId: "call_fake_1",
      spoken: ["Teeth whitening is $250."]
    });
    renderCalls();

    await userEvent.click(await screen.findByTestId("simulate-start"));
    expect(await screen.findByTestId("simulator-transcript")).toHaveTextContent("Thanks for calling Bright Smile Studio.");

    await userEvent.type(screen.getByTestId("simulate-input"), "how much is whitening");
    await userEvent.click(screen.getByTestId("simulate-say"));

    expect(ops.simulateCallerSpeech).toHaveBeenCalledWith(BUSINESS_ID, "call_fake_1", "how much is whitening");
    expect(await screen.findByTestId("simulator-transcript")).toHaveTextContent("Teeth whitening is $250.");
  });
});

describe("call detail", () => {
  const renderDetail = () =>
    renderAt(`/dashboard/${BUSINESS_ID}/calls/call-1`, <CallDetailPage />, "/dashboard/:businessId/calls/:callId");

  it("shows the transcript, what the call produced and how fast Veyra answered", async () => {
    renderDetail();

    expect(await screen.findByTestId("call-transcript")).toHaveTextContent("Teeth whitening is $250.");
    expect(screen.getByTestId("call-outcome")).toHaveTextContent("Booking");
    expect(screen.getByTestId("call-booking-link")).toHaveAttribute("href", `/dashboard/${BUSINESS_ID}/bookings/booking-1`);
    expect(screen.getByTestId("call-conversation-link")).toHaveAttribute("href", `/dashboard/${BUSINESS_ID}/conversations/conv-1`);
    expect(screen.getByTestId("call-latency")).toHaveTextContent(/median 90ms/);
  });

  it("offers no audio, because recording is off", async () => {
    renderDetail();
    expect(await screen.findByTestId("call-no-recording")).toHaveTextContent(/recording is off/i);
    expect(screen.queryByRole("button", { name: /play/i })).not.toBeInTheDocument();
  });

  it("says plainly when the business keeps metadata only", async () => {
    vi.mocked(ops.getCall).mockResolvedValue(detail({ transcriptStored: false, turns: [] }));
    renderDetail();

    expect(await screen.findByTestId("call-transcript-withheld")).toHaveTextContent(/metadata only/i);
    expect(screen.queryByTestId("call-transcript")).not.toBeInTheDocument();
  });

  it("exposes no prompts, reasoning or provider internals", async () => {
    const { container } = renderDetail();
    await screen.findByTestId("call-transcript");
    expect(container.textContent).not.toMatch(/prompt|reasoning|chain.of.thought|accountSid|authToken/i);
  });
});
