<script setup lang="ts">
import { compareText, visibleText } from '~/shared/utils/run-display'

const props = defineProps<{
  expected: string
  actual: string
}>()

const difference = computed(() => compareText(props.expected, props.actual))
</script>

<template>
  <section class="text-difference" aria-label="文字列の差分">
    <div class="diff-summary">
      <strong>最初の不一致: {{ difference.firstDifferencePosition }}文字目</strong>
      <span>期待値 {{ difference.expectedLength }}文字</span>
      <span>実測値 {{ difference.actualLength }}文字</span>
    </div>

    <div class="diff-character-grid">
      <div>
        <span>期待値の文字</span>
        <strong>{{ difference.expectedCharacter.display }}</strong>
        <code>{{ difference.expectedCharacter.codePoint }}</code>
        <small>{{ difference.expectedCharacter.name }}</small>
      </div>
      <div>
        <span>実測値の文字</span>
        <strong>{{ difference.actualCharacter.display }}</strong>
        <code>{{ difference.actualCharacter.codePoint }}</code>
        <small>{{ difference.actualCharacter.name }}</small>
      </div>
    </div>

    <p class="diff-legend">
      <span class="diff-removed">期待値だけ</span>
      <span class="diff-added">実測値だけ</span>
      <span>␠ 半角スペース ／ □ 全角スペース ／ ↵ 改行 ／ ⇥ タブ</span>
    </p>

    <details class="diff-fulltext" open>
      <summary>全文と不一致箇所を表示</summary>
      <div class="diff-text-grid">
        <div>
          <span class="diff-label">期待値（全文）</span>
          <pre data-diff-side="expected"><template v-for="(segment, index) in difference.expectedSegments" :key="index"><mark v-if="segment.kind === 'removed'" class="diff-removed">{{ visibleText(segment.text) }}</mark><span v-else>{{ visibleText(segment.text) }}</span></template></pre>
        </div>
        <div>
          <span class="diff-label">実測値（全文）</span>
          <pre data-diff-side="actual"><template v-for="(segment, index) in difference.actualSegments" :key="index"><mark v-if="segment.kind === 'added'" class="diff-added">{{ visibleText(segment.text) }}</mark><span v-else>{{ visibleText(segment.text) }}</span></template></pre>
        </div>
      </div>
    </details>
  </section>
</template>
