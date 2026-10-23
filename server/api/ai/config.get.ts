import { AI_PRICE_PROFILES, DEFAULT_AI_MODEL, DEFAULT_AI_PRICE_PROFILE_ID } from '~/shared/config/ai-pricing'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return {
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    defaultModel: DEFAULT_AI_MODEL,
    defaultPriceProfileId: DEFAULT_AI_PRICE_PROFILE_ID,
    priceProfiles: AI_PRICE_PROFILES,
  }
})
