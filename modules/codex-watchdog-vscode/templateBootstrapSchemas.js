"use strict";

const bootstrapSchemaTemplates = {
  bootstrapConversationTurnSchema: () => JSON.stringify({
    type: "object",
    required: [
      "assistant_reply",
      "open_questions",
      "suggested_next_step"
    ],
    properties: {
      assistant_reply: { type: "string" },
      open_questions: {
        type: "array",
        items: { type: "string" }
      },
      suggested_next_step: { type: "string" }
    },
    additionalProperties: false
  }, null, 2) + "\n",

  bootstrapInstantiationSchema: () => JSON.stringify({
    type: "object",
    required: [
      "assistant_reply",
      "plan_md",
      "todo_md",
      "state_md",
      "safety_md",
      "daily_handoff_md",
      "ready_for_start_guard",
      "open_questions",
      "suggested_next_step"
    ],
    properties: {
      assistant_reply: { type: "string" },
      plan_md: { type: "string" },
      todo_md: { type: "string" },
      state_md: { type: "string" },
      safety_md: { type: "string" },
      daily_handoff_md: { type: "string" },
      ready_for_start_guard: { type: "boolean" },
      open_questions: {
        type: "array",
        items: { type: "string" }
      },
      suggested_next_step: { type: "string" }
    },
    additionalProperties: false
  }, null, 2) + "\n"
};

module.exports = {
  bootstrapSchemaTemplates
};
