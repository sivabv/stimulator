type SeedDataJson = {
  masterOptionData?: Record<string, unknown>;
  masterStockData?: Record<string, unknown>;
};

type SpyOptionCacheNode = Record<string, Record<string, Record<string, Record<string, unknown>>>>;

const flattenSpyOptionCache = (cache: unknown): Record<string, unknown> => {
  const flattened: Record<string, unknown> = {};
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return flattened;
  }

  const root = cache as Record<string, SpyOptionCacheNode>;

  for (const [symbol, symbolData] of Object.entries(root)) {
    if (!symbolData || typeof symbolData !== "object") continue;

    for (const [expiryDate, expiryData] of Object.entries(symbolData)) {
      if (!expiryData || typeof expiryData !== "object") continue;

      for (const [strikePrice, strikeData] of Object.entries(expiryData)) {
        if (!strikeData || typeof strikeData !== "object") continue;

        for (const [date, dateData] of Object.entries(strikeData)) {
          if (!dateData || typeof dateData !== "object") continue;

          for (const [optionType, payload] of Object.entries(dateData)) {
            if (!payload || typeof payload !== "object") continue;
            const flatKey = `${symbol}|${expiryDate}|${strikePrice}|${optionType}|${date}`;
            flattened[flatKey] = {
              symbol,
              expiryDate,
              strikePrice: Number(strikePrice),
              optionType,
              date,
              ...(payload as Record<string, unknown>),
            };
          }
        }
      }
    }
  }

  return flattened;
};

let cachedPromise: Promise<SeedDataJson> | null = null;

export const getSessionCachedDataJson = async (): Promise<SeedDataJson> => {
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async () => {
    const imported = await import("../assets/data.json");
    const legacyData = (imported.default ?? imported) as SeedDataJson;

    try {
      const spyCacheImport = await import("../assets/spy-option-cache.json");
      const spyCacheData = (spyCacheImport.default ?? spyCacheImport) as Record<string, unknown>;
      const flatSpyOptionData = flattenSpyOptionCache(spyCacheData?.SPY ?? spyCacheData);

      return {
        ...legacyData,
        masterOptionData: {
          ...(legacyData.masterOptionData ?? {}),
          ...flatSpyOptionData,
        },
      };
    } catch {
      return legacyData;
    }
  })();

  return cachedPromise;
};