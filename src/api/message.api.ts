import type { OmadeusMessage } from "../types.js";
import { jaguarFetch, generateTemporaryId, type OmadeusApiOptions } from "../utils/http.util.js";

async function readJsonOrEmpty(res: Response): Promise<unknown> {
  if (res.status === 204) {
    return undefined;
  }
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export async function sendRoomMessage(
  opts: OmadeusApiOptions,
  params: { roomId: number | string; body: string; temporaryId?: string },
): Promise<{ ok: boolean; message?: OmadeusMessage; error?: string }> {
  try {
    const res = await jaguarFetch(opts, `/rooms/${params.roomId}/messages`, {
      method: "SEND",
      body: JSON.stringify({
        body: params.body,
        temporaryId: params.temporaryId ?? generateTemporaryId(),
        links: "[]",
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as OmadeusMessage;
    return { ok: true, message: data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 300) };
  }
}

export async function listRoomMessages(
  opts: OmadeusApiOptions,
  params: { roomId: number | string; skip?: number; take?: number; sort?: string },
): Promise<OmadeusMessage[]> {
  const search = new URLSearchParams();
  if (params.sort) search.set("sort", params.sort);
  if (typeof params.skip === "number") search.set("skip", String(params.skip));
  if (typeof params.take === "number") search.set("take", String(params.take));
  const qs = search.toString();

  const res = await jaguarFetch(opts, `/rooms/${params.roomId}/messageviews${qs ? `?${qs}` : ""}`, {
    method: "LIST",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus list room messages failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage[];
}

export async function seeMessage(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<OmadeusMessage> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}`, {
    method: "SEE",
    // The server requires a Content-Length header; an empty JSON body supplies one.
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus see message failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage;
}

export async function getMessageById(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<OmadeusMessage> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}`, {
    method: "GET",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus get message failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage;
}

export type OmadeusMessageLink = { title: string; url: string };

export async function replyToMessage(
  opts: OmadeusApiOptions,
  params: {
    messageId: number | string;
    body: string;
    temporaryId?: string;
    links?: OmadeusMessageLink[];
  },
): Promise<OmadeusMessage> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}`, {
    method: "REPLY",
    body: JSON.stringify({
      body: params.body,
      temporaryId: params.temporaryId ?? generateTemporaryId(),
      links: JSON.stringify(params.links ?? []),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus reply message failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage;
}

export async function editMessage(
  opts: OmadeusApiOptions,
  params: {
    messageId: number | string;
    body: string;
    temporaryId?: string;
    links?: OmadeusMessageLink[];
  },
): Promise<OmadeusMessage> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}`, {
    method: "EDIT",
    body: JSON.stringify({
      body: params.body,
      ...(params.temporaryId ? { temporaryId: params.temporaryId } : {}),
      ...(params.links ? { links: JSON.stringify(params.links) } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus edit message failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage;
}

export async function deleteMessage(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<OmadeusMessage> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus delete message failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage;
}

export async function pinMessage(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<OmadeusMessage> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}`, {
    method: "PIN",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus pin message failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage;
}

export async function unpinMessage(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<OmadeusMessage> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}`, {
    method: "UNPIN",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus unpin message failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as OmadeusMessage;
}

export async function listMessageViewers(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<unknown[]> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}/seen/members`, {
    method: "LIST",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus list message viewers failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as unknown[];
}

export async function addMessageReaction(
  opts: OmadeusApiOptions,
  params: { messageId: number | string; emoji: string },
): Promise<unknown> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}/reactions`, {
    method: "ADD",
    body: JSON.stringify({ emoji: params.emoji }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus add reaction failed (${res.status}): ${text.slice(0, 200)}`);
  }
  // Success is often 204 No Content with no body.
  return readJsonOrEmpty(res);
}

export async function listMessageReactions(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<unknown[]> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}/reactions`, {
    method: "LIST",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus list reactions failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as unknown[];
}

export async function removeMessageReactions(
  opts: OmadeusApiOptions,
  params: { messageId: number | string },
): Promise<unknown> {
  const res = await jaguarFetch(opts, `/messages/${params.messageId}/reactions`, {
    method: "REMOVE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus remove reactions failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return readJsonOrEmpty(res);
}
