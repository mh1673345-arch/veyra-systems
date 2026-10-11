import { Router } from "express";
import { z } from "zod";
import type {
  AssistantAction,
  AssistantIntent,
  Conversation,
  CreateMessageResponse,
  Message
} from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { unavailableMessage } from "../services/ai/presentation.js";
import { handleReceptionTurn } from "../services/reception/turn.js";

export const conversationsRouter = Router();

const createConversationSchema = z.object({
  businessId: z.string().min(1),
  callerName: z.string().min(1).optional()
});

const createMessageSchema = z.object({
  text: z.string().min(1)
});

function toConversationDto(conversation: {
  id: string;
  businessId: string;
  callerName: string | null;
  status: string;
  createdAt: Date;
}): Conversation {
  return {
    id: conversation.id,
    businessId: conversation.businessId,
    callerName: conversation.callerName,
    status: conversation.status === "closed" ? "closed" : "open",
    createdAt: conversation.createdAt.toISOString()
  };
}

function toMessageDto(message: {
  id: string;
  conversationId: string;
  sender: string;
  text: string;
  intent: string | null;
  action: string | null;
  confidence: number | null;
  requiresClarification: boolean;
  createdAt: Date;
}): Message {
  return {
    id: message.id,
    conversationId: message.conversationId,
    sender: message.sender === "receptionist" ? "receptionist" : "caller",
    text: message.text,
    intent: (message.intent as AssistantIntent | null) ?? null,
    action: (message.action as AssistantAction | null) ?? null,
    confidence: message.confidence,
    requiresClarification: message.requiresClarification,
    createdAt: message.createdAt.toISOString()
  };
}

conversationsRouter.post("/conversations", async (req, res, next) => {
  try {
    const parsed = createConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const business = await prisma.business.findUnique({ where: { id: parsed.data.businessId } });
    if (!business) {
      throw new HttpError(404, "Business not found");
    }

    const conversation = await prisma.conversation.create({
      data: {
        businessId: parsed.data.businessId,
        callerName: parsed.data.callerName ?? null
      }
    });

    // A paused or not-yet-live Reception greets with a safe pointer to the
    // business instead of inviting a conversation it won't handle.
    const greeting = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "receptionist",
        text: business.receptionStatus === "active" ? business.greeting : unavailableMessage(business)
      }
    });

    res.status(201).json({
      conversation: toConversationDto(conversation),
      greeting: toMessageDto(greeting)
    });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.get("/conversations/:id", async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      include: { messages: { orderBy: { createdAt: "asc" } } }
    });
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }

    res.json({
      conversation: toConversationDto(conversation),
      messages: conversation.messages.map(toMessageDto)
    });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.post("/conversations/:id/messages", async (req, res, next) => {
  try {
    const parsed = createMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    // The whole turn — history, responder, action boundary, persistence,
    // knowledge gaps — lives in one place shared with every other channel, so
    // a phone caller and a typing caller cannot get different answers.
    const turn = await handleReceptionTurn({
      conversationId: req.params.id,
      callerText: parsed.data.text
    });

    const body: CreateMessageResponse = {
      callerMessage: toMessageDto(turn.callerMessage),
      receptionistMessage: toMessageDto(turn.receptionistMessage),
      actionResult: turn.actionResult
    };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});
