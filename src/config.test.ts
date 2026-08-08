import { afterEach, describe, expect, it } from "vitest";
import { resolveOmadeusAccount } from "./config.js";

const ORIGINAL_ENV = {
  email: process.env.OMADEUS_EMAIL,
  password: process.env.OMADEUS_PASSWORD,
  organizationId: process.env.OMADEUS_ORGANIZATION_ID,
};

describe("resolveOmadeusAccount", () => {
  afterEach(() => {
    if (ORIGINAL_ENV.email === undefined) {
      delete process.env.OMADEUS_EMAIL;
    } else {
      process.env.OMADEUS_EMAIL = ORIGINAL_ENV.email;
    }
    if (ORIGINAL_ENV.password === undefined) {
      delete process.env.OMADEUS_PASSWORD;
    } else {
      process.env.OMADEUS_PASSWORD = ORIGINAL_ENV.password;
    }
    if (ORIGINAL_ENV.organizationId === undefined) {
      delete process.env.OMADEUS_ORGANIZATION_ID;
    } else {
      process.env.OMADEUS_ORGANIZATION_ID = ORIGINAL_ENV.organizationId;
    }
  });

  it("uses env credentials when config only contains runtime metadata", () => {
    process.env.OMADEUS_EMAIL = "user@example.com";
    process.env.OMADEUS_PASSWORD = "secret";
    process.env.OMADEUS_ORGANIZATION_ID = "123";

    const account = resolveOmadeusAccount({
      cfg: {
        channels: {
          omadeus: {
            enabled: true,
          },
        },
      },
    });

    expect(account.credentialSource).toBe("env");
    expect(account.email).toBe("user@example.com");
    expect(account.password).toBe("secret");
    expect(account.organizationId).toBe(123);
    expect(account.casUrl).toBe("https://xas.xeba.tech");
    expect(account.omadeusUrl).toBe("https://maestro.xeba.tech");
  });

  it("prefers config credentials over env credentials", () => {
    process.env.OMADEUS_EMAIL = "env@example.com";
    process.env.OMADEUS_PASSWORD = "env-secret";
    process.env.OMADEUS_ORGANIZATION_ID = "321";

    const account = resolveOmadeusAccount({
      cfg: {
        channels: {
          omadeus: {
            enabled: true,
            email: "config@example.com",
            password: "config-secret",
            organizationId: 456,
          },
        },
      },
    });

    expect(account.credentialSource).toBe("config");
    expect(account.email).toBe("config@example.com");
    expect(account.password).toBe("config-secret");
    expect(account.organizationId).toBe(456);
  });

  it("uses production URLs when explicit URLs are omitted", () => {
    const account = resolveOmadeusAccount({
      cfg: {
        channels: {
          omadeus: {
            enabled: true,
          },
        },
      },
    });

    expect(account.casUrl).toBe("https://xas.xeba.tech");
    expect(account.omadeusUrl).toBe("https://maestro.xeba.tech");
  });

  it("uses explicit URL overrides", () => {
    const account = resolveOmadeusAccount({
      cfg: {
        channels: {
          omadeus: {
            enabled: true,
            casUrl: "https://cas.example.test",
            omadeusUrl: "https://omadeus.example.test",
          },
        },
      },
    });

    expect(account.casUrl).toBe("https://cas.example.test");
    expect(account.omadeusUrl).toBe("https://omadeus.example.test");
  });

  it("uses a stored session token without environment metadata", () => {
    const account = resolveOmadeusAccount({
      cfg: {
        channels: {
          omadeus: {
            enabled: true,
            sessionToken: "cached-token",
          },
        },
      },
    });

    expect(account.sessionToken).toBe("cached-token");
    expect(account.credentialSource).toBe("session");
  });

  it("keeps hosted API-key runtime configuration password-free", () => {
    const account = resolveOmadeusAccount({
      cfg: {
        channels: {
          omadeus: {
            enabled: true,
            organizationId: 123,
            apiKey: "hosted-key",
            openClawMemberId: 456,
          },
        },
      },
    });

    expect(account.credentialSource).toBe("apikey");
    expect(account.apiKey).toBe("hosted-key");
    expect(account.email).toBe("");
    expect(account.password).toBe("");
    expect(account.casUrl).toBe("https://xas.xeba.tech");
    expect(account.omadeusUrl).toBe("https://maestro.xeba.tech");
  });
});
