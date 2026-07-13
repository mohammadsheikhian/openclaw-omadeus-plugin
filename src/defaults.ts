export type OmadeusEnvironment = "production" | "staging" | "dev" | "milestone";

export const OMADEUS_DEFAULT_ENVIRONMENT: OmadeusEnvironment = "dev";

export type OmadeusEnvironmentConfig = {
  label: string;
  casUrl: string;
  maestroUrl: string;
};

export const OMADEUS_ENVIRONMENTS: Record<OmadeusEnvironment, OmadeusEnvironmentConfig> = {
  production: {
    label: "Production",
    casUrl: "https://xas.xeba.tech",
    maestroUrl: "https://maestro.xeba.tech",
  },
  staging: {
    label: "Staging",
    casUrl: "https://staging-xas.xeba.tech",
    maestroUrl: "https://staging.xeba.tech",
  },
  dev: {
    label: "Dev",
    casUrl: "https://dev1-cas.rouztech.com",
    maestroUrl: "https://dev1-maestro.rouztech.com",
  },
  milestone: {
    label: "Milestone",
    casUrl: "https://milestone-cas.xeba.ir",
    maestroUrl: "https://milestone.xeba.ir",
  },
};

const OMADEUS_ENVIRONMENT_SET = new Set<string>(Object.keys(OMADEUS_ENVIRONMENTS));

export function resolveOmadeusEnvironment(value: unknown): OmadeusEnvironment {
  if (typeof value === "string" && OMADEUS_ENVIRONMENT_SET.has(value)) {
    return value as OmadeusEnvironment;
  }
  return OMADEUS_DEFAULT_ENVIRONMENT;
}

export function getOmadeusEnvironmentUrls(env: OmadeusEnvironment): {
  casUrl: string;
  maestroUrl: string;
} {
  const config = OMADEUS_ENVIRONMENTS[env];
  return { casUrl: config.casUrl, maestroUrl: config.maestroUrl };
}
