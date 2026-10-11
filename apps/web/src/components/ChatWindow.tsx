import { useState } from "react";
import type { Conversation, Message } from "@veyra/shared";
import { bookAppointment, sendMessage } from "../api/client";
import { MessageBubble } from "./MessageBubble";

interface ChatWindowProps {
  conversation: Conversation;
  initialMessages: Message[];
}

export function ChatWindow({ conversation, initialMessages }: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appointmentTime, setAppointmentTime] = useState("");
  const [appointmentStatus, setAppointmentStatus] = useState<string | null>(null);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);
    try {
      const { callerMessage, receptionistMessage } = await sendMessage(conversation.id, text);
      setMessages((prev) => [...prev, callerMessage, receptionistMessage]);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  async function handleBookAppointment(event: React.FormEvent) {
    event.preventDefault();
    if (!appointmentTime) return;

    try {
      const appointment = await bookAppointment(conversation.id, appointmentTime);
      setAppointmentStatus(
        `Appointment request ${appointment.status} for ${appointment.requestedTime}. ` +
          "The clinic will review it and confirm the time with you; this is not a confirmed booking yet."
      );
      setAppointmentTime("");
    } catch (err) {
      setAppointmentStatus(err instanceof Error ? err.message : "Failed to submit appointment request");
    }
  }

  // The booking widget only appears once the receptionist has actually detected
  // a booking request, rather than sitting on screen for every conversation.
  const bookingRequested = messages.some((m) => m.action === "show_booking_form");

  return (
    <div className="chat-window">
      <div className="message-list">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>

      {error && <p className="error-text">{error}</p>}

      <form className="message-form" onSubmit={handleSend}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type what the caller would say..."
          disabled={sending}
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          Send
        </button>
      </form>

      {bookingRequested && (
        <form className="appointment-form" onSubmit={handleBookAppointment}>
          <label htmlFor="appointment-time">Request an appointment</label>
          <input
            id="appointment-time"
            type="datetime-local"
            value={appointmentTime}
            onChange={(e) => setAppointmentTime(e.target.value)}
          />
          <button type="submit" disabled={!appointmentTime}>
            Submit request
          </button>
        </form>
      )}
      {appointmentStatus && <p className="appointment-status">{appointmentStatus}</p>}
    </div>
  );
}
