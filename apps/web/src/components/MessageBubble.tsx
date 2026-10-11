import type { Message } from "@veyra/shared";

function intentLabel(message: Message): string | null {
  if (message.action === "escalate_to_human") return "Flagged for staff follow-up";
  if (message.action === "show_booking_form") return "Appointment requested";
  return null;
}

export function MessageBubble({ message }: { message: Message }) {
  const isReceptionist = message.sender === "receptionist";
  const tag = isReceptionist ? intentLabel(message) : null;

  return (
    <div className={`message-row ${isReceptionist ? "receptionist" : "caller"}`}>
      <div className="message-bubble">
        <span className="message-sender">{isReceptionist ? "Veyra" : "You"}</span>
        <p>{message.text}</p>
        {tag && <span className="message-tag">{tag}</span>}
      </div>
    </div>
  );
}
