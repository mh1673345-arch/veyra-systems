import { useEffect, useState } from "react";
import type { Business, Conversation, Message } from "@veyra/shared";
import { getBusiness, getDemoBusiness, startConversation } from "./api/client";
import { ChatWindow } from "./components/ChatWindow";

type Status = "loading" | "ready" | "in-call" | "error";

export function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [business, setBusiness] = useState<Business | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [callerName, setCallerName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    async function bootstrap() {
      try {
        // The server picks the demo business: the one pinned by
        // VEYRA_DEMO_BUSINESS_ID, else the oldest presentable one. This page
        // used to take whichever business was created most recently, which
        // meant any throwaway workspace silently became the public demo.
        const demo = await getDemoBusiness();
        if (!demo.businessId) {
          setErrorMessage(
            "No demo business is configured on this server yet. Set VEYRA_DEMO_BUSINESS_ID, or create a business with Reception live and at least one service."
          );
          setStatus("error");
          return;
        }
        setBusiness(await getBusiness(demo.businessId));
        setStatus("ready");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to load business");
        setStatus("error");
      }
    }

    bootstrap();
  }, []);

  async function handleStartCall() {
    if (!business) return;
    try {
      const { conversation: newConversation, greeting } = await startConversation(
        business.id,
        callerName.trim() || undefined
      );
      setConversation(newConversation);
      setInitialMessages([greeting]);
      setStatus("in-call");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to start call");
      setStatus("error");
    }
  }

  return (
    <main className="app-shell">
      <header>
        <h1>Veyra Reception</h1>
        <p>AI receptionist prototype — simulate an inbound caller talking to {business?.name ?? "your business"}.</p>
      </header>

      {status === "loading" && <p>Loading…</p>}

      {status === "error" && <p className="error-text">{errorMessage}</p>}

      {status === "ready" && business && (
        <section className="start-call">
          <label htmlFor="caller-name">Caller name (optional)</label>
          <input
            id="caller-name"
            type="text"
            value={callerName}
            onChange={(e) => setCallerName(e.target.value)}
            placeholder="Jane Doe"
          />
          <button type="button" onClick={handleStartCall}>
            Start call
          </button>
        </section>
      )}

      {status === "in-call" && conversation && (
        <ChatWindow conversation={conversation} initialMessages={initialMessages} />
      )}
    </main>
  );
}
