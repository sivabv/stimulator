type SeedDataJson = {
  masterOptionData?: Record<string, unknown>;
  masterStockData?: Record<string, unknown>;
};

let cachedPromise: Promise<SeedDataJson> | null = null;

export const getSessionCachedDataJson = async (): Promise<SeedDataJson> => {
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async () => {
    const imported = await import("../assets/data.json");
    return (imported.default ?? imported) as SeedDataJson;
  })();

  return cachedPromise;
};