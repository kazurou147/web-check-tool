<script setup lang="ts">
import type { InputIssue, InputSnapshot } from '~/shared/types/excel-input'

const props = defineProps<{
  projectId: string
}>()

const { data, status, error } = await useFetch<{ preview: InputSnapshot }>(
  `/api/projects/${props.projectId}/excel/preview`,
)

const preview = computed(() => data.value?.preview)
const excludedUrlCount = computed(() => preview.value?.invalidRows.filter(
  issue => issue.code === 'missing_url' || issue.code === 'invalid_url',
).length ?? 0)
const issues = computed(() => {
  if (!preview.value) return []
  return [
    ...preview.value.headerIssues,
    ...preview.value.mergeIssues,
    ...preview.value.invalidRows,
    ...preview.value.formulaIssues,
    ...preview.value.tagIssues,
  ]
})

function issueLocation(issue: InputIssue): string {
  if (issue.range) return `${issue.sheetName}!${issue.range}`
  if (issue.cell) return `${issue.sheetName}!${issue.cell}`
  return issue.sheetName
}

function expectationLabel(state: 'unique' | 'blank_present' | 'conflict'): string {
  if (state === 'conflict') return '矛盾'
  if (state === 'blank_present') return '空欄あり'
  return '一致'
}
</script>

<template>
  <section class="card form-card stack preview-panel">
    <div class="preview-heading">
      <div>
        <p class="eyebrow">INPUT PREVIEW</p>
        <h2>Excel入力プレビュー</h2>
      </div>
      <span v-if="preview" class="status-chip" :class="preview.canStart ? 'ok' : 'fatal'">
        {{ preview.canStart ? '入力検証OK' : '修正が必要' }}
      </span>
    </div>

    <p v-if="status === 'pending'" class="notice">Excelを解析しています…</p>
    <p v-else-if="error" class="notice error">Excel入力を解析できませんでした。</p>

    <template v-else-if="preview">
      <div class="metrics" aria-label="入力集計">
        <div><strong>{{ preview.totalDataRows }}</strong><span>対象行</span></div>
        <div><strong>{{ preview.validRows }}</strong><span>有効行</span></div>
        <div><strong>{{ preview.uniqueUrlCount }}</strong><span>固有URL</span></div>
        <div><strong>{{ preview.blankRows }}</strong><span>空白行</span></div>
        <div><strong>{{ preview.hiddenExcludedRows }}</strong><span>非表示除外</span></div>
        <div><strong>{{ excludedUrlCount }}</strong><span>URL欠落・不正</span></div>
        <div><strong>{{ preview.duplicateGroups.length }}</strong><span>重複URL</span></div>
        <div><strong>{{ preview.mergeIssues.length }}</strong><span>結合セル</span></div>
        <div><strong>{{ preview.formulaIssues.length }}</strong><span>数式セル</span></div>
        <div><strong>{{ preview.expectedGoogleTags.length }}</strong><span>有効タグ行</span></div>
        <div><strong>{{ issues.length }}</strong><span>警告・エラー</span></div>
      </div>

      <div v-if="issues.length" class="preview-section">
        <h3>警告・エラー</h3>
        <ul class="issue-list">
          <li v-for="(issue, index) in issues" :key="`${issue.code}-${issueLocation(issue)}-${index}`" :class="issue.severity">
            <strong>{{ issue.severity === 'fatal' ? '開始不可' : '警告' }}</strong>
            <span>{{ issueLocation(issue) }}</span>
            {{ issue.message }}
          </li>
        </ul>
      </div>

      <div v-if="preview.duplicateGroups.length" class="preview-section">
        <h3>重複URL</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>URL</th><th>元行</th><th>title</th><th>description</th></tr></thead>
            <tbody>
              <tr v-for="group in preview.duplicateGroups" :key="group.normalizedUrl">
                <td class="break-all">{{ group.normalizedUrl }}</td>
                <td>{{ group.sourceRows.join(', ') }}</td>
                <td>{{ expectationLabel(group.titleExpectation.state) }}</td>
                <td>{{ expectationLabel(group.descriptionExpectation.state) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="preview-section">
        <h3>有効な対象ページ</h3>
        <div v-if="preview.pageRows.length" class="table-wrap">
          <table>
            <thead><tr><th>行</th><th>ページ名</th><th>URL</th><th>title</th><th>description</th></tr></thead>
            <tbody>
              <tr v-for="row in preview.pageRows" :key="row.sourceRow">
                <td>{{ row.sourceRow }}</td>
                <td>{{ row.displayName }}</td>
                <td class="break-all">{{ row.url }}</td>
                <td>{{ row.titleState === 'formula' ? '数式（要確認）' : row.expectedTitle ?? '空欄（要確認）' }}</td>
                <td>{{ row.descriptionState === 'formula' ? '数式（要確認）' : row.expectedDescription ?? '空欄（要確認）' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="hint">有効な対象ページはありません。</p>
      </div>

      <div class="preview-section">
        <h3>Googleタグ登録</h3>
        <div v-if="preview.expectedGoogleTags.length" class="tag-list">
          <article v-for="tag in preview.expectedGoogleTags" :key="tag.sourceRow" class="tag-row">
            <div>
              <strong>{{ tag.name || `行 ${tag.sourceRow}` }}</strong>
              <span>{{ tag.placement === 'unspecified' ? '位置指定なし' : `${tag.placement}用` }}</span>
            </div>
            <code>{{ tag.ids.map(item => item.id).join(', ') }}</code>
          </article>
        </div>
        <p v-else class="hint">有効なGoogleタグ登録は0件です。</p>
      </div>
    </template>
  </section>
</template>
