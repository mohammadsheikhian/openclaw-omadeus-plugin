import { getOpenClawDirect } from "./api/direct.api.js";
import { OmadeusHttpError, type OmadeusApiOptions } from "./utils/http.util.js";

type Log = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
};

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Transient means "the server or the network was briefly unavailable". A pod
 * can start before its gateway is reachable, so those are worth retrying.
 * Anything else — 401 (bad credentials), 404 (no such DM) — is a deployment
 * fault that retrying will never fix.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof OmadeusHttpError) return err.status >= 500;
  return err instanceof Error && err.name !== "OmadeusHttpError";
}

/**
 * Resolve the one room this channel serves: the operator's DM with the OpenClaw
 * bot. Called once at startup; the id is then fixed for the lifetime of the
 * connection and is the only thing inbound admission checks.
 *
 * The DM always exists by the time an instance is provisioned, so a 404 here is
 * not a "not created yet" state to wait out — it means this gateway is pointed
 * at the wrong Omadeus, or the credentials belong to someone else. It is raised
 * rather than retried so the account reports the failure instead of looping.
 */
export async function pinOpenClawRoom(params: {
  apiOpts: OmadeusApiOptions;
  /** The OpenClaw bot's member reference id, from config. */
  openClawMemberId: number;
  log: Log;
  attempts?: number;
  retryDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
}): Promise<number> {
  const {
    apiOpts,
    openClawMemberId,
    log,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delay = sleep,
  } = params;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const direct = await getOpenClawDirect(apiOpts);

      // Catches a wrong `openClawMemberId` at startup. Without this the value
      // is only ever used to recognise our own echoes, so a bad one would make
      // the channel answer its own replies in a loop — visible to the operator,
      // but with nothing in the log pointing at the cause.
      const hasOpenClaw = direct.members.some((m) => m.referenceId === openClawMemberId);
      if (!hasOpenClaw) {
        throw new Error(
          `Omadeus: openClawMemberId ${openClawMemberId} is not a member of the OpenClaw direct ` +
            `(room ${direct.id}, members ${direct.members.map((m) => m.referenceId).join(", ")}). ` +
            "Check channels.omadeus.openClawMemberId.",
        );
      }

      log.info(`[omadeus] serving room ${direct.id}`);
      return direct.id;
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === attempts) break;
      log.warn(
        `[omadeus] could not resolve the OpenClaw room (attempt ${attempt}/${attempts}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await delay(retryDelayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
