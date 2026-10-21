<script setup lang="ts">
import type { GoogleTagDetection } from '~/shared/types/run'
import { copyGoogleNetworkUrl, summarizeGoogleEvidence } from '~/shared/utils/run-display'

const props = defineProps<{ tag: GoogleTagDetection }>()
const summary = computed(() => summarizeGoogleEvidence(props.tag.evidence, props.tag.id))
const copiedUrl = ref('')

async function copyUrl(url: string) {
  try {
    await copyGoogleNetworkUrl(url)
    copiedUrl.value = url
    window.setTimeout(() => {
      if (copiedUrl.value === url) copiedUrl.value = ''
    }, 2_000)
  } catch {
    copiedUrl.value = ''
  }
}
</script>

<template>
  <div class="tag-evidence">
    <ul v-if="summary.notes.length" class="evidence-list">
      <li v-for="(note, index) in summary.notes" :key="index">{{ note }}</li>
    </ul>

    <div v-if="summary.networkGroups.length" class="network-summary-list">
      <article v-for="group in summary.networkGroups" :key="group.key" class="network-summary">
        <div class="network-summary-main">
          <strong>{{ group.hosts.join(' / ') }}{{ group.path }}</strong>
          <span>{{ group.occurrences }}回</span>
        </div>
        <div class="network-params">
          <span>ID: {{ group.detectedId }}</span>
          <span>イベント: {{ group.eventName ?? '—' }}</span>
          <span v-if="group.sendTo">send_to: {{ group.sendTo }}</span>
        </div>
        <details class="network-urls">
          <summary>完全URLを表示（{{ group.urls.length }}件）</summary>
          <div v-for="(url, index) in group.urls" :key="url" class="network-url-row">
            <code>{{ url }}</code>
            <button type="button" class="button compact" @click="copyUrl(url)">
              {{ copiedUrl === url ? 'コピー済み' : `URL ${index + 1}をコピー` }}
            </button>
          </div>
        </details>
      </article>
    </div>
  </div>
</template>
