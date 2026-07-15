import { readNuggetNumber } from "./api/nugget.api.js";
import { mergePeopleIntoNuggetAgentPayload } from "./member-resolve.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

export type NuggetLookupIntent = {
  /** Display nugget number from `N###` (maps to API `number`, not internal `id`). */
  nuggetNumber: number;
};

export type TaskChannelTargetIntent = {
  nuggetNumber: number;
  rawPrefix: "n" | "t";
};

export function parseNuggetLookupIntent(rawBody: string): NuggetLookupIntent | null {
  const body = rawBody.trim();
  if (!body) {
    return null;
  }
  const idMatch = /\bN(\d+)\b/i.exec(body);
  if (!idMatch) {
    return null;
  }
  const nuggetNumber = Number(idMatch[1]);
  if (!Number.isFinite(nuggetNumber)) {
    return null;
  }

  if (/^N\d+\??$/i.test(body)) {
    return { nuggetNumber };
  }
  if (/\bnugget\s+N?\d+\b/i.test(body)) {
    return { nuggetNumber };
  }
  if (/\b(get|show|lookup|find|search|status|detail|info)\b/i.test(body)) {
    return { nuggetNumber };
  }
  return null;
}

export function parseTaskChannelTargetIntent(rawInput: string): TaskChannelTargetIntent | null {
  const trimmed = rawInput.trim();
  const match = /^([nt])(\d+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const nuggetNumber = Number(match[2]);
  if (!Number.isFinite(nuggetNumber)) {
    return null;
  }
  return {
    nuggetNumber,
    rawPrefix: match[1]!.toLowerCase() as "n" | "t",
  };
}

export type ChannelTaskCreateIntent = {
  kind: "task" | "nugget";
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
};

export type RecurringScheduleIntent = {
  everyMinutes: number;
};

function resolvePriorityFromText(text: string): ChannelTaskCreateIntent["priority"] {
  const lowered = text.toLowerCase();
  if (/\b(urgent|asap|critical|p0)\b/.test(lowered)) return "urgent";
  if (/\b(high|important|p1)\b/.test(lowered)) return "high";
  if (/\b(medium|normal|p2)\b/.test(lowered)) return "medium";
  return "low";
}

export function parseChannelTaskCreateIntent(rawBody: string): ChannelTaskCreateIntent | null {
  const body = rawBody.trim();
  if (!body) {
    return null;
  }
  const lower = body.toLowerCase();
  const isCreateVerb = /\b(create|open|add|spawn|start)\b/.test(lower);
  const hasTaskWord = /\b(task|nugget)\b/.test(lower);
  if (!isCreateVerb || !hasTaskWord) {
    return null;
  }

  const kind: "task" | "nugget" = /\bnugget\b/.test(lower) ? "nugget" : "task";
  // Trim obvious command prefixes to leave a natural title candidate.
  const candidate = body
    .replace(/^\s*(please\s+)?(create|open|add|spawn|start)\s+(a\s+|an\s+)?(new\s+)?/i, "")
    .replace(/^(task|nugget)\s*/i, "")
    .trim();
  const title = candidate || `${kind === "task" ? "Task" : "Nugget"} from channel request`;
  const description = body;
  return {
    kind,
    title,
    description,
    priority: resolvePriorityFromText(body),
  };
}

export function parseRecurringScheduleIntent(rawBody: string): RecurringScheduleIntent | null {
  const lowered = rawBody.toLowerCase();
  // every 5 min / every 5 mins / every 5 minutes
  const minuteMatch = /\bevery\s+(\d+)\s*(m|min|mins|minute|minutes)\b/.exec(lowered);
  if (minuteMatch) {
    const everyMinutes = Number(minuteMatch[1]);
    if (Number.isFinite(everyMinutes) && everyMinutes > 0) {
      return { everyMinutes: Math.min(60, everyMinutes) };
    }
  }
  // every hour / hourly
  if (/\bevery\s+hour\b|\bhourly\b/.test(lowered)) {
    return { everyMinutes: 60 };
  }
  return null;
}

/** Fields from Dolphin nuggetviews that are useful for an agent summary (avoids huge payloads). */
const NUGGET_FIELDS_FOR_AGENT = [
  "number",
  "id",
  "title",
  "description",
  "status",
  "stage",
  "leadPhaseTitle",
  "priority",
  "priorityValue",
  "dueDate",
  "kind",
  "entityType",
  "tempo",
  "projectTitle",
  "projectStatus",
  "projectNumber",
  "projectManagerFirstName",
  "projectManagerLastName",
  "projectManagerTitle",
  "projectManagerReferenceId",
  "clientTitle",
  "folderTitle",
  "createdAt",
  "autoModifiedAt",
  "lastMovingTime",
  "responseTimestamp",
  "assignmentLevel",
  "estimated",
  "sprintName",
  "sprintNumber",
  "releaseTitle",
  "releaseNumber",
  "publicRoomId",
  "privateRoomId",
  "memberReferenceId",
  "assigneeReferenceId",
  "ownerReferenceId",
  "memberFirstName",
  "memberLastName",
  "assigneeFirstName",
  "assigneeLastName",
] as const;

export function pickNuggetFieldsForAgent(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of NUGGET_FIELDS_FOR_AGENT) {
    if (key in record) {
      out[key] = record[key];
    }
  }
  return out;
}

/**
 * Picked Dolphin fields + `people` map (referenceId → display name) for the organization.
 */
export async function buildNuggetAgentDataPayload(
  apiOpts: OmadeusApiOptions,
  fullRecord: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (!fullRecord) {
    return null;
  }
  const base = pickNuggetFieldsForAgent(fullRecord);
  return mergePeopleIntoNuggetAgentPayload(apiOpts, fullRecord, base);
}

/**
 * Augments the user message so the agent receives Dolphin nugget/task data and can reply with a summary.
 * On miss or API error, the agent still gets instructions to respond helpfully.
 */
export async function appendNuggetLookupContextForAgent(
  rawBody: string,
  nuggetNumber: number,
  record: Record<string, unknown> | null,
  apiOpts: OmadeusApiOptions,
  fetchError?: string,
): Promise<string> {
  const header = `[Omadeus nugget/task N${nuggetNumber}]`;

  if (fetchError) {
    return (
      `${rawBody}\n\n${header} Lookup failed: ${fetchError}\n` +
      `Briefly explain the error to the user and suggest they try again or check permissions.`
    );
  }

  if (!record) {
    return (
      `${rawBody}\n\n${header} No row matched display number ${nuggetNumber} (field \`number\`) in search results.\n` +
      `Tell the user succinctly that this nugget/task was not found.`
    );
  }

  const payload = (await buildNuggetAgentDataPayload(apiOpts, record)) ?? pickNuggetFieldsForAgent(record);
  return (
    `${rawBody}\n\n${header} Data from Omadeus (summarize for someone tracking this work — status, ownership, timeline, project; plain language. **For assignees and anyone in \`people\` / \`*FirstName\` fields, use those names; never read raw *ReferenceId numbers to the user as a person.**):\n` +
    `${JSON.stringify(payload, null, 2)}`
  );
}

/**
 * Signals that a message in a Task/Nugget room actually wants this thread's live Omadeus
 * data (status, ownership, timeline, sprint/phase, why-delayed, summary, …).
 *
 * This gate is intentionally opt-in: plain chatter ("Hello?", "thanks", "can you help me
 * write an email") should NOT pull the heavy nugget payload, because that payload carries an
 * imperative "answer the user with this" instruction that derails replies to unrelated messages.
 */
const TASK_ROOM_CONTEXT_PATTERNS: RegExp[] = [
  // Explicit reference to the current item ("this nugget", "the task", "this thread", …).
  /\b(this|the|these|that)\s+(nugget|task|thread|item|one|bug|issue|ticket|work|sprint|phase|stage|project|release)\b/i,
  // Omadeus domain vocabulary anywhere in the message.
  /\b(nugget|sprint|phase|stage|assignee|assigned|assignment|owner|ownership|tempo|overdue|at[-\s]?risk|delayed|blocked|due\s*date|deadline|priority|estimate[sd]?|maestro|triage|workflow|backlog)\b/i,
  // Status / progress / summary intents.
  /\b(status|summary|summari[sz]e|progress|standup|recap)\b/i,
  // "who is working / assigned / responsible / the owner / the lead …"
  /\bwho(?:'s|\s+is|\s+are)?\b[\s\S]*\b(working|assigned|responsible|owner|lead|on\s+this|on\s+it)\b/i,
  // "why is this delayed / late / stuck / blocked / at risk / behind / overdue"
  /\bwhy\b[\s\S]*\b(delayed|late|stuck|blocked|at[-\s]?risk|behind|overdue|stalled)\b/i,
  // "when is this due / the deadline"
  /\bwhen\b[\s\S]*\b(due|deadline|ship|complete[d]?|finish)\b/i,
];

/**
 * Whether an inbound message in a Task/Nugget Jaguar room should pull that room's live Dolphin
 * data. Returns false for empty bodies, acknowledgements, and general chatter unrelated to the
 * work item, so those are answered without the (imperative) nugget payload.
 */
export function messageNeedsTaskRoomNuggetContext(rawBody: string): boolean {
  const body = rawBody.trim();
  if (!body) {
    return false;
  }
  return TASK_ROOM_CONTEXT_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Enriches a Task or Nugget **Jaguar room** with Dolphin data matched by this chat's `roomId`, so the
 * agent can answer "status" without a bare `N###` in the message.
 */
export async function appendNuggetContextForTaskOrNuggetRoom(
  rawBody: string,
  roomId: number,
  roomName: string | null,
  record: Record<string, unknown> | null,
  apiOpts: OmadeusApiOptions,
  fetchError?: string,
): Promise<string> {
  const roomLabel = roomName?.trim() ? `room ${roomId} ("${roomName.trim()}")` : `room ${roomId}`;

  if (fetchError) {
    return (
      `${rawBody}\n\n[Omadeus, this task/nugget ${roomLabel}] Lookup failed: ${fetchError}.\n` +
      `Answer from this thread. Do not tell the user to "use the Omadeus platform" or similar — give a direct reply or a concrete next step.`
    );
  }

  if (!record) {
    return (
      `${rawBody}\n\n[Omadeus, this task/nugget ${roomLabel}] No Dolphin row matched this room id in search yet.\n` +
      `Answer from the conversation; be honest if you cannot see live fields. Do not hand-wave to "the platform".`
    );
  }

  const n = readNuggetNumber(record);
  const nLabel = n !== undefined ? `N${n}` : "nugget";
  const payload = (await buildNuggetAgentDataPayload(apiOpts, record)) ?? pickNuggetFieldsForAgent(record);
  return (
    `${rawBody}\n\n[Omadeus ${nLabel} for this chat room] The following is live task/nugget data — **answer the user with this** (stage, status, title, who, due date; plain language. **For assignee/owner, use \`people\` and name fields; never recite *ReferenceId numbers (e.g. 210) as a person's name.**). \`task/...\` in the UI is not an OpenClaw session key.\n` +
    `${JSON.stringify(payload, null, 2)}`
  );
}
