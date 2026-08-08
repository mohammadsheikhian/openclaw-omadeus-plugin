import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  configureOpenClawBot: vi.fn(),
  listOrganizationMembers: vi.fn(),
  listOrganizations: vi.fn(),
}));

vi.mock("./auth.js", () => ({ authenticate: mocks.authenticate }));
vi.mock("./api/auth.api.js", () => ({
  configureOpenClawBot: mocks.configureOpenClawBot,
  listOrganizationMembers: mocks.listOrganizationMembers,
  listOrganizations: mocks.listOrganizations,
}));

import { omadeusSetupWizard } from "./onboarding.js";

describe("omadeusSetupWizard", () => {
  it("uses password authentication without environment or API-key prompts", async () => {
    mocks.listOrganizations.mockResolvedValue([
      { id: 123, title: "Acme", membersCount: 2 },
    ]);
    mocks.authenticate.mockResolvedValue({
      dolphinToken: "session-token",
      payload: {
        email: "user@example.com",
        referenceId: 77,
      },
    });
    mocks.listOrganizationMembers.mockResolvedValue([
      { id: 4, referenceId: 456, email: "openclaw@xeba.tech" },
    ]);
    mocks.configureOpenClawBot.mockResolvedValue(undefined);

    const select = vi.fn();
    const text = vi
      .fn()
      .mockResolvedValueOnce("user@example.com")
      .mockResolvedValueOnce("password");
    const prompter = {
      select,
      text,
      note: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn(),
    };

    const result = await (omadeusSetupWizard.finalize as (input: unknown) => Promise<any>)({
      cfg: {},
      prompter,
    });

    expect(select).not.toHaveBeenCalled();
    expect(text.mock.calls.map(([input]) => input.message)).toEqual([
      "Omadeus username (email)",
      "Omadeus password",
    ]);
    expect(mocks.authenticate).toHaveBeenCalledWith({
      casUrl: "https://xas.xeba.tech",
      omadeusUrl: "https://maestro.xeba.tech",
      email: "user@example.com",
      password: "password",
      organizationId: 123,
    });
    expect(result.cfg.channels.omadeus).toMatchObject({
      enabled: true,
      casUrl: "https://xas.xeba.tech",
      omadeusUrl: "https://maestro.xeba.tech",
      organizationId: 123,
      sessionToken: "session-token",
      openClawMemberId: 456,
      inbound: {
        version: 1,
        direct: { enabled: true, requireMention: "never" },
      },
    });
    expect(result.cfg.channels.omadeus).not.toHaveProperty("apiKey");
    expect(result.cfg.channels.omadeus).not.toHaveProperty("environment");
  });

  it("uses configured URL overrides", async () => {
    mocks.listOrganizations.mockResolvedValue([{ id: 123, title: "Acme", membersCount: 2 }]);
    mocks.authenticate.mockResolvedValue({
      dolphinToken: "session-token",
      payload: { email: "user@example.com", referenceId: 77 },
    });
    mocks.listOrganizationMembers.mockResolvedValue([
      { id: 4, referenceId: 456, email: "openclaw@xeba.tech" },
    ]);
    const prompter = {
      select: vi.fn(),
      text: vi.fn().mockResolvedValueOnce("user@example.com").mockResolvedValueOnce("password"),
      note: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn(),
    };

    await (omadeusSetupWizard.finalize as (input: unknown) => Promise<any>)({
      cfg: {
        channels: {
          omadeus: {
            casUrl: "https://cas.example.test",
            omadeusUrl: "https://omadeus.example.test",
          },
        },
      },
      prompter,
    });

    expect(mocks.authenticate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        casUrl: "https://cas.example.test",
        omadeusUrl: "https://omadeus.example.test",
      }),
    );
  });
});
