import type {
  Appointment,
  Business,
  Conversation,
  CreateMessageResponse,
  DemoBusinessInfo,
  Message
} from "@veyra/shared";

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const apiKey = import.meta.env.VITE_API_KEY ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      ...init?.headers
    }
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed with status ${res.status}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Which business the public demo talks to. The server decides — the demo must
 * not pick for itself, or any newly created workspace becomes the demo.
 */
export function getDemoBusiness(): Promise<DemoBusinessInfo> {
  return request<DemoBusinessInfo>("/demo/business");
}

export function getBusiness(id: string): Promise<Business> {
  return request<Business>(`/businesses/${id}`);
}

export function listBusinesses(): Promise<Business[]> {
  return request<Business[]>("/businesses");
}

export function createBusiness(name: string): Promise<Business> {
  return request<Business>("/businesses", {
    method: "POST",
    body: JSON.stringify({ name })
  });
}

export function startConversation(
  businessId: string,
  callerName?: string
): Promise<{ conversation: Conversation; greeting: Message }> {
  return request("/conversations", {
    method: "POST",
    body: JSON.stringify({ businessId, callerName })
  });
}

export function sendMessage(
  conversationId: string,
  text: string
): Promise<CreateMessageResponse> {
  return request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text })
  });
}

export function bookAppointment(
  conversationId: string,
  requestedTime: string,
  notes?: string
): Promise<Appointment> {
  return request(`/conversations/${conversationId}/appointments`, {
    method: "POST",
    body: JSON.stringify({ requestedTime, notes })
  });
}
