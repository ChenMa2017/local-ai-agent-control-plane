"use strict";

function renderBootstrapTranscript(turns) {
  return turns.slice(-12).map((turn) => {
    const label = turn.role === "assistant" ? "AI reply" : "User request";
    return `### ${label}\n${turn.text}`;
  }).join("\n\n");
}

function bootstrapConversationPromptText(root, conversation) {
  const transcript = renderBootstrapTranscript(conversation.turns);
  return [
    "You are helping the user discuss and refine a Codex Watchdog project bootstrap inside the VSCode control panel.",
    "",
    `Project root: ${root}`,
    "",
    "Read these files before answering:",
    "- README.codex-watchdog.md",
    "- agent/TASK_REQUEST.md",
    "- agent/CODEX_TAKEOVER.md",
    "- agent/PLAN.md",
    "- agent/TODO.md",
    "- agent/STATE.md",
    "- agent/SAFETY.md",
    "- agent/DAILY_HANDOFF.md",
    "",
    "Your job in this turn is discussion, not full file instantiation.",
    "- First answer the user's latest question directly and conversationally.",
    "- Reply in the same language the user is currently using, unless they ask you to switch.",
    "- Then briefly explain how your current understanding of the watchdog setup changed.",
    "- Ask only the most important follow-up questions, if any.",
    "- Do not narrate internal progress as if it were the final answer.",
    "- Do not claim the project files were already updated unless the user explicitly ran Instantiate Project.",
    "",
    "Return JSON matching the provided schema.",
    "`assistant_reply` should read like a real answer to the user, not like a status log.",
    "`suggested_next_step` should explain whether the user should keep discussing, preview the candidate setup, or instantiate the project.",
    "",
    "Bootstrap conversation transcript:",
    transcript || "(no previous messages)"
  ].join("\n");
}

function bootstrapInstantiationPromptText(root, conversation) {
  const transcript = renderBootstrapTranscript(conversation.turns);
  return [
    "You are daily Codex working inside the Codex Watchdog VSCode bootstrap conversation.",
    "",
    `Project root: ${root}`,
    "",
    "Read these files from the project before deciding the setup:",
    "- README.codex-watchdog.md",
    "- agent/TASK_REQUEST.md",
    "- agent/CODEX_TAKEOVER.md",
    "- agent/PLAN.md",
    "- agent/TODO.md",
    "- agent/STATE.md",
    "- agent/SAFETY.md",
    "- agent/DAILY_HANDOFF.md",
    "",
    "Goal:",
    "- turn the user's setup conversation into concrete watchdog bootstrap files;",
    "- keep the first objective bounded and safe;",
    "- do not start the guard;",
    "- do not assume training, GPU work, external sends, or destructive actions unless the user explicitly asks and the files make that safe;",
    "- prefer read-only bootstrap goals when the project is still being defined.",
    "",
    "Return JSON matching the provided schema.",
    "The markdown fields must be complete file contents, not summaries and not fenced code blocks.",
    "`assistant_reply` should use the same language the user is currently using.",
    "`assistant_reply` should be a concise UI-facing answer that explains the candidate setup and what still needs review.",
    "`ready_for_start_guard` should be true only if the files look concrete enough that a later manual Start Guard would make sense.",
    "",
    "Bootstrap conversation transcript:",
    transcript || "(no previous messages)"
  ].join("\n");
}

module.exports = {
  renderBootstrapTranscript,
  bootstrapConversationPromptText,
  bootstrapInstantiationPromptText
};
