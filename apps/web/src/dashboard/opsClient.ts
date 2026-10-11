import type {
  AuthSessionResponse,
  AuthUser,
  BusinessCapabilities,
  BusinessMember,
  MembershipRole,
  OpsBooking,
  OpsBookingDetail,
  OpsConversationDetail,
  OpsConversationSummary,
  OpsEscalation,
  OpsEscalationDetail,
  OpsCalendarListResponse,
  OpsSubscription,
  PlanCode,
  BookingSettings,
  BusinessProfile,
  ConfigFaq,
  ConfigService,
  CreateWorkspaceRequest,
  EscalationSettings,
  FaqInput,
  KnowledgePreview,
  OnboardingState,
  OnboardingStep,
  ReadinessReport,
  ReceptionSettings,
  ServiceInput,
  WorkingDay,
  WorkingHours,
  OpsCalendarSettings,
  OpsNotificationList,
  OpsOverview,
  OpsWorkItem,
  NotificationPreferences,
  UpdateNotificationPreferencesRequest,
  BillingChangeResult,
  BillingRedirect,
  ConversationFeedbackDto,
  ConversationOutcome,
  ConversationOutcomeState,
  FeedbackRating,
  KnowledgeGapRow,
  PilotExportKind,
  PilotIntentCount,
  PilotIssueCategory,
  PilotIssueDto,
  PilotIssueStatus,
  PilotOverview,
  PilotRange,
  PilotRangeKey,
  PilotReport,
  PilotSafetyControls,
  PilotSeriesPoint,
  PilotState,
  PilotStatus,
  PilotTargets,
  PilotTimelineEntry,
  CallDetail,
  CallSummary,
  ConfirmationDestination,
  CustomerContactDto,
  MessagingOverview,
  VoiceOverview,
  VoiceSettingsDto
} from "@veyra/shared";

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;
  /** Stable machine-readable code, e.g. ENTITLEMENT_REQUIRED or PLAN_LIMIT_REACHED. */
  code: string | null;
  /** Lowest plan that would allow the refused action, when the server says. */
  requiredPlan: PlanCode | null;
  constructor(
    status: number,
    message: string,
    details: { code?: string | null; requiredPlan?: PlanCode | null } = {}
  ) {
    super(message);
    this.status = status;
    this.code = details.code ?? null;
    this.requiredPlan = details.requiredPlan ?? null;
  }
}

const CSRF_COOKIE = "veyra_csrf";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The CSRF token lives in a JS-readable cookie precisely so it can be echoed
 * back in a header — a cross-site page can read neither.
 */
function readCsrfToken(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * All dashboard calls ride on the httpOnly session cookie — there is no token
 * in localStorage and no shared operator key. `credentials: "include"` is what
 * sends the cookie cross-origin in development, and unsafe methods
 * automatically carry the CSRF header.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const csrfToken = SAFE_METHODS.has(method) ? null : readCsrfToken();

  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
      ...init?.headers
    }
  });

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, {
      code: typeof body.code === "string" ? body.code : null,
      requiredPlan: typeof body.requiredPlan === "string" ? (body.requiredPlan as PlanCode) : null
    });
  }

  return res.json() as Promise<T>;
}

/* ------------------------------- auth -------------------------------- */

export function login(email: string, password: string): Promise<{ user: AuthUser }> {
  return request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function logout(): Promise<void> {
  return request("/auth/logout", { method: "POST" });
}

export function getSession(): Promise<AuthSessionResponse> {
  return request("/auth/me");
}

/* -------------------------------- ops -------------------------------- */

export function getOverview(businessId: string): Promise<OpsOverview> {
  return request(`/ops/businesses/${businessId}/overview`);
}

export function getCapabilities(
  businessId: string
): Promise<{ businessId: string; businessName: string; capabilities: BusinessCapabilities }> {
  return request(`/ops/businesses/${businessId}/capabilities`);
}

/* ---------------------------- subscription ---------------------------- */

export function getSubscription(businessId: string): Promise<OpsSubscription> {
  return request(`/ops/businesses/${businessId}/subscription`);
}

/* ------------------------------ billing ------------------------------ */
// None of these changes a plan. They start a provider checkout or ask the
// provider for a change; the plan changes only when the provider's webhook
// confirms it, so the Console refreshes and waits.

/** Only the plan is sent — never a price. The server picks the price. */
export function startCheckout(businessId: string, targetPlan: PlanCode): Promise<BillingRedirect> {
  return request(`/ops/businesses/${businessId}/billing/checkout`, {
    method: "POST",
    body: JSON.stringify({ targetPlan })
  });
}

export function requestPlanChange(businessId: string, targetPlan: PlanCode): Promise<BillingChangeResult> {
  return request(`/ops/businesses/${businessId}/billing/change-plan`, {
    method: "POST",
    body: JSON.stringify({ targetPlan })
  });
}

export function cancelPlan(businessId: string): Promise<BillingChangeResult> {
  return request(`/ops/businesses/${businessId}/billing/cancel`, { method: "POST", body: "{}" });
}

export function resumePlan(businessId: string): Promise<BillingChangeResult> {
  return request(`/ops/businesses/${businessId}/billing/resume`, { method: "POST", body: "{}" });
}

export function openBillingPortal(businessId: string): Promise<BillingRedirect> {
  return request(`/ops/businesses/${businessId}/billing/portal`, { method: "POST", body: "{}" });
}

/** Leaves the Console for a provider-hosted page. A function so tests can stub it. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}

/* ------------------------------ calendar ------------------------------ */

export function getCalendarSettings(businessId: string): Promise<OpsCalendarSettings> {
  return request(`/ops/businesses/${businessId}/calendar`);
}

export function listCalendarOptions(businessId: string): Promise<OpsCalendarListResponse> {
  return request(`/ops/businesses/${businessId}/calendar/calendars`);
}

/** Returns the consent URL the operator's browser must be sent to. */
export function startCalendarConnection(
  businessId: string
): Promise<{ authorizationUrl: string; provider: string }> {
  return request(`/ops/businesses/${businessId}/calendar/connect`, { method: "POST" });
}

export function selectCalendar(businessId: string, calendarId: string): Promise<OpsCalendarSettings> {
  return request(`/ops/businesses/${businessId}/calendar/select`, {
    method: "POST",
    body: JSON.stringify({ calendarId })
  });
}

export function disconnectCalendar(businessId: string): Promise<OpsCalendarSettings> {
  return request(`/ops/businesses/${businessId}/calendar/disconnect`, { method: "POST" });
}

export function listConversations(businessId: string): Promise<OpsConversationSummary[]> {
  return request(`/ops/businesses/${businessId}/conversations`);
}

export function getConversation(businessId: string, id: string): Promise<OpsConversationDetail> {
  return request(`/ops/businesses/${businessId}/conversations/${id}`);
}

export function listBookings(businessId: string): Promise<OpsBooking[]> {
  return request(`/ops/businesses/${businessId}/bookings`);
}

export function getBooking(businessId: string, id: string): Promise<OpsBookingDetail> {
  return request(`/ops/businesses/${businessId}/bookings/${id}`);
}

export function updateBookingStatus(
  businessId: string,
  id: string,
  status: string
): Promise<OpsBooking> {
  return request(`/ops/businesses/${businessId}/bookings/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
}

export function listEscalations(businessId: string): Promise<OpsEscalation[]> {
  return request(`/ops/businesses/${businessId}/escalations`);
}

export function getEscalation(businessId: string, id: string): Promise<OpsEscalationDetail> {
  return request(`/ops/businesses/${businessId}/escalations/${id}`);
}

export function updateEscalationStatus(
  businessId: string,
  id: string,
  status: string
): Promise<OpsEscalation> {
  return request(`/ops/businesses/${businessId}/escalations/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
}

/* ------------------------------ members ------------------------------- */

export function listMembers(businessId: string): Promise<BusinessMember[]> {
  return request(`/ops/businesses/${businessId}/members`);
}

export function addMember(
  businessId: string,
  email: string,
  role: MembershipRole
): Promise<BusinessMember> {
  return request(`/ops/businesses/${businessId}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role })
  });
}

export function updateMemberRole(
  businessId: string,
  membershipId: string,
  role: MembershipRole
): Promise<BusinessMember> {
  return request(`/ops/businesses/${businessId}/members/${membershipId}`, {
    method: "PATCH",
    body: JSON.stringify({ role })
  });
}

export function removeMember(businessId: string, membershipId: string): Promise<void> {
  return request(`/ops/businesses/${businessId}/members/${membershipId}`, { method: "DELETE" });
}

/* ------------------------------ account ------------------------------- */

export interface SessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

export function listSessions(): Promise<SessionSummary[]> {
  return request("/auth/sessions");
}

export function revokeOtherSessions(): Promise<{ revoked: number }> {
  return request("/auth/sessions/revoke-others", { method: "POST" });
}

export function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean }> {
  return request("/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword })
  });
}

/* --------------------- notifications & work queue --------------------- */

export function listNotifications(businessId: string): Promise<OpsNotificationList> {
  return request(`/ops/businesses/${businessId}/notifications`);
}

export function markNotificationRead(businessId: string, id: string): Promise<void> {
  return request(`/ops/businesses/${businessId}/notifications/${id}/read`, { method: "POST" });
}

export function markAllNotificationsRead(businessId: string): Promise<{ read: number }> {
  return request(`/ops/businesses/${businessId}/notifications/read-all`, { method: "POST" });
}

export function listWorkQueue(businessId: string): Promise<OpsWorkItem[]> {
  return request(`/ops/businesses/${businessId}/work-queue`);
}

export function getNotificationPreferences(businessId: string): Promise<NotificationPreferences> {
  return request(`/ops/businesses/${businessId}/notification-preferences`);
}

export function updateNotificationPreferences(
  businessId: string,
  preferences: UpdateNotificationPreferencesRequest
): Promise<NotificationPreferences> {
  return request(`/ops/businesses/${businessId}/notification-preferences`, {
    method: "PATCH",
    body: JSON.stringify(preferences)
  });
}

/* ------------------------- self-service onboarding ------------------------ */

export function signUp(name: string, email: string, password: string): Promise<{ user: AuthUser }> {
  return request("/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password }) });
}

export function createWorkspace(
  input: CreateWorkspaceRequest
): Promise<{ businessId: string; name: string; receptionStatus: string }> {
  return request("/workspaces", { method: "POST", body: JSON.stringify(input) });
}

const scoped = (businessId: string, path: string) => `/ops/businesses/${businessId}${path}`;
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body)
});

export const setup = {
  onboarding: (businessId: string): Promise<OnboardingState> => request(scoped(businessId, "/onboarding")),
  recordStep: (businessId: string, step: OnboardingStep, action: "complete" | "skip"): Promise<OnboardingState> =>
    request(scoped(businessId, `/onboarding/steps/${step}`), send("POST", { action })),

  profile: (businessId: string): Promise<BusinessProfile> => request(scoped(businessId, "/profile")),
  saveProfile: (businessId: string, input: Partial<Omit<BusinessProfile, "businessId">>): Promise<BusinessProfile> =>
    request(scoped(businessId, "/profile"), send("PATCH", input)),

  services: (businessId: string): Promise<{ services: ConfigService[] }> => request(scoped(businessId, "/services")),
  addService: (businessId: string, input: ServiceInput): Promise<{ services: ConfigService[] }> =>
    request(scoped(businessId, "/services"), send("POST", input)),
  updateService: (businessId: string, id: string, input: Partial<ServiceInput>): Promise<{ services: ConfigService[] }> =>
    request(scoped(businessId, `/services/${id}`), send("PATCH", input)),
  archiveService: (businessId: string, id: string): Promise<{ services: ConfigService[] }> =>
    request(scoped(businessId, `/services/${id}/archive`), send("POST")),
  restoreService: (businessId: string, id: string): Promise<{ services: ConfigService[] }> =>
    request(scoped(businessId, `/services/${id}/restore`), send("POST")),

  faqs: (businessId: string): Promise<{ faqs: ConfigFaq[] }> => request(scoped(businessId, "/faqs")),
  addFaq: (businessId: string, input: FaqInput): Promise<{ faqs: ConfigFaq[] }> =>
    request(scoped(businessId, "/faqs"), send("POST", input)),
  updateFaq: (businessId: string, id: string, input: Partial<FaqInput>): Promise<{ faqs: ConfigFaq[] }> =>
    request(scoped(businessId, `/faqs/${id}`), send("PATCH", input)),
  setFaqActive: (businessId: string, id: string, active: boolean): Promise<{ faqs: ConfigFaq[] }> =>
    request(scoped(businessId, `/faqs/${id}/${active ? "enable" : "disable"}`), send("POST")),
  reorderFaqs: (businessId: string, ids: string[]): Promise<{ faqs: ConfigFaq[] }> =>
    request(scoped(businessId, "/faqs/reorder"), send("POST", { ids })),

  hours: (businessId: string): Promise<WorkingHours> => request(scoped(businessId, "/hours")),
  saveHours: (businessId: string, days: WorkingDay[]): Promise<WorkingHours> =>
    request(scoped(businessId, "/hours"), send("PUT", { days })),

  booking: (businessId: string): Promise<BookingSettings> => request(scoped(businessId, "/booking-settings")),
  saveBooking: (businessId: string, input: Partial<BookingSettings>): Promise<BookingSettings> =>
    request(scoped(businessId, "/booking-settings"), send("PATCH", input)),

  escalation: (businessId: string): Promise<EscalationSettings> => request(scoped(businessId, "/escalation-settings")),
  saveEscalation: (businessId: string, input: Partial<EscalationSettings>): Promise<EscalationSettings> =>
    request(scoped(businessId, "/escalation-settings"), send("PATCH", input)),

  reception: (businessId: string): Promise<ReceptionSettings> => request(scoped(businessId, "/reception-settings")),
  saveReception: (
    businessId: string,
    input: Partial<Pick<ReceptionSettings, "assistantName" | "greeting" | "tone" | "closingStyle">>
  ): Promise<ReceptionSettings> => request(scoped(businessId, "/reception-settings"), send("PATCH", input)),

  readiness: (businessId: string): Promise<ReadinessReport> => request(scoped(businessId, "/readiness")),
  activate: (businessId: string): Promise<ReceptionSettings> =>
    request(scoped(businessId, "/reception/activate"), send("POST")),
  pause: (businessId: string): Promise<ReceptionSettings> => request(scoped(businessId, "/reception/pause"), send("POST")),

  knowledge: (businessId: string): Promise<KnowledgePreview> => request(scoped(businessId, "/knowledge"))
};

/* -------------------------------- pilot -------------------------------- */
// Pilot analytics and review. Every call is business-scoped; the server
// decides what this member may see or change, and the UI only reflects it.

export interface PilotRangeQuery {
  range?: PilotRangeKey;
  from?: string;
  to?: string;
}

function rangeQuery(query: PilotRangeQuery = {}): string {
  const params = new URLSearchParams();
  if (query.range) params.set("range", query.range);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function getPilotOverview(businessId: string, query?: PilotRangeQuery): Promise<PilotOverview> {
  return request(`/ops/businesses/${businessId}/pilot${rangeQuery(query)}`);
}

export function getPilotSeries(
  businessId: string,
  query?: PilotRangeQuery
): Promise<{ range: PilotRange; series: PilotSeriesPoint[]; topIntents: PilotIntentCount[]; outcomes: { outcome: ConversationOutcome; label: string; count: number }[] }> {
  return request(`/ops/businesses/${businessId}/pilot/series${rangeQuery(query)}`);
}

export function getKnowledgeGaps(
  businessId: string,
  query?: PilotRangeQuery
): Promise<{ range: PilotRange; gaps: KnowledgeGapRow[] }> {
  return request(`/ops/businesses/${businessId}/pilot/knowledge-gaps${rangeQuery(query)}`);
}

export function getPilotTimeline(
  businessId: string,
  query?: PilotRangeQuery
): Promise<{ range: PilotRange; entries: PilotTimelineEntry[] }> {
  return request(`/ops/businesses/${businessId}/pilot/timeline${rangeQuery(query)}`);
}

export function getPilotReport(businessId: string, query?: PilotRangeQuery): Promise<PilotReport> {
  return request(`/ops/businesses/${businessId}/pilot/report${rangeQuery(query)}`);
}

/** A CSV download is a plain browser navigation, so the cookie goes with it. */
export function pilotExportUrl(businessId: string, kind: PilotExportKind, query?: PilotRangeQuery): string {
  return `${baseUrl}/api/ops/businesses/${businessId}/pilot/export/${kind}${rangeQuery(query)}`;
}

export function setPilotStatus(
  businessId: string,
  status: PilotStatus,
  extra: { label?: string; notes?: string } = {}
): Promise<PilotState> {
  return request(`/ops/businesses/${businessId}/pilot/status`, {
    method: "POST",
    body: JSON.stringify({ status, ...extra })
  });
}

export function setPilotTargets(businessId: string, targets: Partial<PilotTargets>): Promise<PilotTargets> {
  return request(`/ops/businesses/${businessId}/pilot/targets`, { method: "PUT", body: JSON.stringify(targets) });
}

export function setPilotSafety(
  businessId: string,
  controls: Partial<PilotSafetyControls>
): Promise<PilotSafetyControls> {
  return request(`/ops/businesses/${businessId}/pilot/safety`, { method: "PUT", body: JSON.stringify(controls) });
}

export function listPilotIssues(businessId: string, status?: string): Promise<PilotIssueDto[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(`/ops/businesses/${businessId}/pilot/issues${query}`);
}

export function reportPilotIssue(
  businessId: string,
  body: { category: PilotIssueCategory; conversationId?: string | null; messageId?: string | null; note?: string }
): Promise<PilotIssueDto> {
  return request(`/ops/businesses/${businessId}/pilot/issues`, { method: "POST", body: JSON.stringify(body) });
}

export function updatePilotIssue(
  businessId: string,
  issueId: string,
  body: { status: PilotIssueStatus; resolutionNote?: string }
): Promise<PilotIssueDto> {
  return request(`/ops/businesses/${businessId}/pilot/issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

export function listConversationFeedback(businessId: string, conversationId: string): Promise<ConversationFeedbackDto[]> {
  return request(`/ops/businesses/${businessId}/conversations/${conversationId}/feedback`);
}

export function rateConversation(
  businessId: string,
  conversationId: string,
  body: { rating: FeedbackRating; messageId?: string | null; note?: string }
): Promise<ConversationFeedbackDto> {
  return request(`/ops/businesses/${businessId}/conversations/${conversationId}/feedback`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function getConversationOutcome(businessId: string, conversationId: string): Promise<ConversationOutcomeState> {
  return request(`/ops/businesses/${businessId}/conversations/${conversationId}/outcome`);
}

export function setConversationOutcome(
  businessId: string,
  conversationId: string,
  body: { outcome: ConversationOutcome | null; note?: string }
): Promise<void> {
  return request(`/ops/businesses/${businessId}/conversations/${conversationId}/outcome`, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

/* -------------------------------- voice -------------------------------- */
// Voice is the Max channel. The server decides whether it is live; the Console
// only renders what it is told, and never implies a phone line exists.

export function getVoiceOverview(businessId: string): Promise<VoiceOverview> {
  return request(`/ops/businesses/${businessId}/voice`);
}

export function updateVoiceSettings(
  businessId: string,
  patch: Partial<VoiceSettingsDto>
): Promise<VoiceOverview> {
  return request(`/ops/businesses/${businessId}/voice`, { method: "PUT", body: JSON.stringify(patch) });
}

export function listCalls(businessId: string): Promise<CallSummary[]> {
  return request(`/ops/businesses/${businessId}/calls`);
}

export function getCall(businessId: string, callId: string): Promise<CallDetail> {
  return request(`/ops/businesses/${businessId}/calls/${callId}`);
}

/* The development call simulator: same pipeline, no telephony. */

export function simulateCall(businessId: string, from?: string): Promise<{ externalCallId: string; callSessionId: string | null; spoken: string[] }> {
  return request(`/ops/businesses/${businessId}/voice/simulate/call`, {
    method: "POST",
    body: JSON.stringify(from ? { from } : {})
  });
}

export function simulateCallerSpeech(
  businessId: string,
  externalCallId: string,
  text: string
): Promise<{ externalCallId: string; spoken: string[] }> {
  return request(`/ops/businesses/${businessId}/voice/simulate/say`, {
    method: "POST",
    body: JSON.stringify({ externalCallId, text })
  });
}

export function simulateHangup(businessId: string, externalCallId: string): Promise<CallDetail> {
  return request(`/ops/businesses/${businessId}/voice/simulate/hangup`, {
    method: "POST",
    body: JSON.stringify({ externalCallId })
  });
}

export function getMessagingOverview(businessId: string): Promise<MessagingOverview> {
  return request(`/ops/businesses/${businessId}/messaging`);
}

export function updateMessagingSettings(
  businessId: string,
  patch: Record<string, unknown>
): Promise<MessagingOverview> {
  return request(`/ops/businesses/${businessId}/messaging`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

export function getCustomerContact(businessId: string, contactId: string): Promise<CustomerContactDto> {
  return request(`/ops/businesses/${businessId}/contacts/${contactId}`);
}

export function updateCustomerContact(
  businessId: string,
  contactId: string,
  patch: { name?: string | null; phone?: string | null; email?: string | null }
): Promise<CustomerContactDto> {
  return request(`/ops/businesses/${businessId}/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

export function getConfirmationDestinations(
  businessId: string,
  conversationId: string
): Promise<{ available: ConfirmationDestination[]; blocked: { channel: string; reason: string }[] }> {
  return request(`/ops/businesses/${businessId}/conversations/${conversationId}/destinations`);
}
