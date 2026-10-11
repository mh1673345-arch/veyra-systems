import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Message } from "@veyra/shared";
import { MessageBubble } from "../src/components/MessageBubble";

const baseMessage: Message = {
  id: "msg-1",
  conversationId: "conv-1",
  sender: "receptionist",
  text: "Thanks for calling!",
  intent: null,
  action: null,
  confidence: null,
  requiresClarification: false,
  createdAt: new Date().toISOString()
};

describe("MessageBubble", () => {
  it("labels receptionist messages as Veyra", () => {
    render(<MessageBubble message={baseMessage} />);
    expect(screen.getByText("Veyra")).toBeInTheDocument();
    expect(screen.getByText("Thanks for calling!")).toBeInTheDocument();
  });

  it("labels caller messages as You", () => {
    render(<MessageBubble message={{ ...baseMessage, sender: "caller", text: "Hi there" }} />);
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("shows an appointment-requested tag when the action asks for the booking form", () => {
    render(
      <MessageBubble
        message={{ ...baseMessage, intent: "booking", action: "show_booking_form" }}
      />
    );
    expect(screen.getByText("Appointment requested")).toBeInTheDocument();
  });

  it("shows a staff follow-up tag when the action is a human handoff", () => {
    render(
      <MessageBubble
        message={{ ...baseMessage, intent: "escalation", action: "escalate_to_human" }}
      />
    );
    expect(screen.getByText("Flagged for staff follow-up")).toBeInTheDocument();
  });

  it("shows no tag for an informational answer", () => {
    render(<MessageBubble message={{ ...baseMessage, intent: "pricing", action: "none" }} />);
    expect(screen.queryByText("Appointment requested")).not.toBeInTheDocument();
    expect(screen.queryByText("Flagged for staff follow-up")).not.toBeInTheDocument();
  });
});
