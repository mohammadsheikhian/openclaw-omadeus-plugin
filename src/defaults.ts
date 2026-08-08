export const OMADEUS_DEFAULT_CAS_URL = "https://xas.xeba.tech";
export const OMADEUS_DEFAULT_URL = "https://maestro.xeba.tech";

export function resolveOmadeusUrls(config: {
  casUrl?: string;
  omadeusUrl?: string;
}): { casUrl: string; omadeusUrl: string } {
  return {
    casUrl: config.casUrl?.trim() || OMADEUS_DEFAULT_CAS_URL,
    omadeusUrl: config.omadeusUrl?.trim() || OMADEUS_DEFAULT_URL,
  };
}
