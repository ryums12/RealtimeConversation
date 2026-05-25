import express from "express";
import { randomUUID } from "crypto";
import { queryDatabase, withDatabaseTransaction } from "./db.js";

const router = express.Router();

function getErrorMessage(error, fallback = "Request failed.") {
  return error?.message || fallback;
}

function createEmptyAnalysis() {
  return {
    summary: "No conversation messages were available to analyze.",
    strengths: [],
    weaknesses: ["No saved conversation messages were found."],
    improvementSuggestions: ["Complete a conversation before requesting analysis."],
    score: null,
    metrics: {
      userMessages: 0,
      assistantMessages: 0,
      totalMessages: 0,
    },
  };
}

function createConversationAnalysis(messages) {
  if (!messages.length) {
    return createEmptyAnalysis();
  }

  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const userWordCount = userMessages.reduce((total, message) => total + message.content.split(/\s+/).filter(Boolean).length, 0);
  const assistantWordCount = assistantMessages.reduce((total, message) => total + message.content.split(/\s+/).filter(Boolean).length, 0);
  const balancedTurns = userMessages.length > 0 && assistantMessages.length > 0;
  const averageAssistantWords = assistantMessages.length ? assistantWordCount / assistantMessages.length : 0;
  const averageUserWords = userMessages.length ? userWordCount / userMessages.length : 0;

  const strengths = [];
  const weaknesses = [];
  const improvementSuggestions = [];

  if (balancedTurns) {
    strengths.push("The conversation includes both user input and assistant responses.");
  } else {
    weaknesses.push("The saved conversation does not include both sides of the exchange.");
  }

  if (assistantMessages.length >= userMessages.length && assistantMessages.length > 0) {
    strengths.push("The assistant responded consistently to saved user turns.");
  } else {
    weaknesses.push("Some user turns may not have a saved assistant response.");
    improvementSuggestions.push("Let each assistant response finish before ending the conversation.");
  }

  if (averageAssistantWords > 80) {
    weaknesses.push("Assistant responses may be lengthy for a real-time voice interaction.");
    improvementSuggestions.push("Use shorter assistant turns and ask one follow-up question at a time.");
  } else if (assistantMessages.length > 0) {
    strengths.push("Assistant response length appears suitable for a spoken conversation.");
  }

  if (averageUserWords < 4 && userMessages.length > 1) {
    improvementSuggestions.push("Encourage the user with more specific follow-up questions when responses are short.");
  }

  if (!improvementSuggestions.length) {
    improvementSuggestions.push("Keep preserving final transcripts so future analysis can compare turn quality over time.");
  }

  const firstUserMessage = userMessages[0]?.content || messages[0]?.content || "";
  const lastAssistantMessage = [...assistantMessages].reverse()[0]?.content || "";
  const summaryParts = [
    `The saved conversation contains ${messages.length} message${messages.length === 1 ? "" : "s"}.`,
    firstUserMessage ? `It began with: "${firstUserMessage.slice(0, 180)}${firstUserMessage.length > 180 ? "..." : ""}"` : "",
    lastAssistantMessage ? `The latest assistant response was: "${lastAssistantMessage.slice(0, 180)}${lastAssistantMessage.length > 180 ? "..." : ""}"` : "",
  ].filter(Boolean);

  return {
    summary: summaryParts.join(" "),
    strengths,
    weaknesses,
    improvementSuggestions,
    score: Math.max(1, Math.min(10, 5 + strengths.length * 1.25 - weaknesses.length)),
    metrics: {
      userMessages: userMessages.length,
      assistantMessages: assistantMessages.length,
      totalMessages: messages.length,
      userWordCount,
      assistantWordCount,
      averageUserWords: Number(averageUserWords.toFixed(1)),
      averageAssistantWords: Number(averageAssistantWords.toFixed(1)),
    },
  };
}

async function fetchConversation(conversationId) {
  const result = await queryDatabase(
    "select id, status, scenario, started_at, ended_at from conversations where id = $1",
    [conversationId]
  );

  return result.rows[0] || null;
}

router.post("/", async (req, res) => {
  const conversationId = randomUUID();
  const { scenario, metadata = {} } = req.body || {};

  try {
    await queryDatabase(
      `insert into conversations (id, status, scenario, metadata, started_at, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now(), now())`,
      [
        conversationId,
        "active",
        typeof scenario === "string" ? scenario : "",
        JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
      ]
    );

    res.status(201).json({ conversationId, status: "active" });
  } catch (error) {
    console.error("Conversation create failed:", error);
    res.status(error.statusCode || 500).json({ error: getErrorMessage(error, "Could not create conversation.") });
  }
});

router.post("/:conversationId/messages", async (req, res) => {
  const { conversationId } = req.params;
  const { role, content, metadata = {} } = req.body || {};
  const normalizedRole = role === "assistant" ? "assistant" : role === "user" ? "user" : "";
  const trimmedContent = typeof content === "string" ? content.trim() : "";

  if (!normalizedRole || !trimmedContent) {
    res.status(400).json({ error: "Message role and content are required." });
    return;
  }

  try {
    const conversation = await fetchConversation(conversationId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation was not found." });
      return;
    }

    await queryDatabase(
      `insert into conversation_messages (conversation_id, role, content, metadata, created_at)
       values ($1, $2, $3, $4, now())`,
      [
        conversationId,
        normalizedRole,
        trimmedContent,
        JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
      ]
    );

    res.status(201).json({ ok: true });
  } catch (error) {
    console.error("Conversation message save failed:", error);
    res.status(error.statusCode || 500).json({ error: getErrorMessage(error, "Could not save conversation message.") });
  }
});

router.patch("/:conversationId/end", async (req, res) => {
  const { conversationId } = req.params;

  try {
    const result = await queryDatabase(
      `update conversations
       set status = $2, ended_at = coalesce(ended_at, now()), updated_at = now()
       where id = $1
       returning id, status, ended_at`,
      [conversationId, "ended"]
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: "Conversation was not found." });
      return;
    }

    res.json({ conversationId: result.rows[0].id, status: result.rows[0].status, endedAt: result.rows[0].ended_at });
  } catch (error) {
    console.error("Conversation end failed:", error);
    res.status(error.statusCode || 500).json({ error: getErrorMessage(error, "Could not end conversation.") });
  }
});

router.post("/:conversationId/analyze", async (req, res) => {
  const { conversationId } = req.params;

  try {
    const conversation = await fetchConversation(conversationId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation was not found." });
      return;
    }

    if (conversation.status !== "ended") {
      res.status(409).json({ error: "Conversation must be ended before analysis." });
      return;
    }

    const messagesResult = await queryDatabase(
      `select role, content, metadata, created_at
       from conversation_messages
       where conversation_id = $1
       order by created_at asc`,
      [conversationId]
    );
    const messages = messagesResult.rows.map((message) => ({
      role: message.role,
      content: message.content || "",
      metadata: message.metadata || {},
      createdAt: message.created_at,
    }));
    const analysis = createConversationAnalysis(messages);

    await queryDatabase("delete from conversation_analysis where conversation_id = $1", [conversationId]);
    await queryDatabase(
      `insert into conversation_analysis (conversation_id, result, created_at, updated_at)
       values ($1, $2, now(), now())`,
      [conversationId, JSON.stringify(analysis)]
    );

    res.json({ conversationId, analysis });
  } catch (error) {
    console.error("Conversation analysis failed:", error);
    res.status(error.statusCode || 500).json({ error: getErrorMessage(error, "Could not analyze conversation.") });
  }
});

router.delete("/:conversationId", async (req, res) => {
  const { conversationId } = req.params;

  try {
    const result = await withDatabaseTransaction(async (client) => {
      await client.query("delete from conversation_analysis where conversation_id = $1", [conversationId]);
      await client.query("delete from conversation_messages where conversation_id = $1", [conversationId]);
      return client.query("delete from conversations where id = $1 returning id", [conversationId]);
    });

    if (!result.rows[0]) {
      res.status(404).json({ error: "Conversation was not found." });
      return;
    }

    res.json({ ok: true, conversationId });
  } catch (error) {
    console.error("Conversation delete failed:", error);
    res.status(error.statusCode || 500).json({ error: getErrorMessage(error, "Could not delete conversation.") });
  }
});

export { router as conversationsRouter };
