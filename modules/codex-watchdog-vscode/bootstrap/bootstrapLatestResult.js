"use strict";

function normalizeBootstrapQuestions(items) {
  return Array.isArray(items)
    ? items.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function createBootstrapDiscussionLatestResult(parsed) {
  return {
    ready_for_start_guard: false,
    open_questions: normalizeBootstrapQuestions(parsed && parsed.open_questions),
    suggested_next_step: String(parsed && parsed.suggested_next_step || ""),
    has_draft: false,
    applied_at: ""
  };
}

function createBootstrapDraftLatestResult(parsed, appliedAt = "") {
  return {
    ready_for_start_guard: Boolean(parsed && parsed.ready_for_start_guard),
    open_questions: normalizeBootstrapQuestions(parsed && parsed.open_questions),
    suggested_next_step: String(parsed && parsed.suggested_next_step || ""),
    has_draft: true,
    applied_at: String(appliedAt || "")
  };
}

module.exports = {
  normalizeBootstrapQuestions,
  createBootstrapDiscussionLatestResult,
  createBootstrapDraftLatestResult
};
