import priceProfiles from './ai-price-profiles.json'
import type { AiPriceProfile } from '~/shared/types/ai'

export const DEFAULT_AI_MODEL = 'gpt-6-luna'
export const DEFAULT_AI_PRICE_PROFILE_ID = priceProfiles.defaultProfileId
export const AI_PRICE_PROFILES = priceProfiles.profiles as AiPriceProfile[]

export function findAiPriceProfile(profileId: string): AiPriceProfile | undefined {
  return AI_PRICE_PROFILES.find(profile => profile.profileId === profileId)
}

export function findMatchingAiPriceProfile(profileId: string, modelId: string): AiPriceProfile | undefined {
  const profile = findAiPriceProfile(profileId)
  return profile?.modelId === modelId ? profile : undefined
}
