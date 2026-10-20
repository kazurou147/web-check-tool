<script setup lang="ts">
import { $fetch as rawFetch } from 'ofetch'
import type { ProjectMutationInput, ProjectView } from '~/shared/types/project'

const route = useRoute()
const projectId = route.params.projectId as string
const { data, error, refresh } = await useFetch<{ project: ProjectView }>(`/api/projects/${projectId}`)
const submitting = ref(false)
const uploading = ref(false)
const message = ref('')
const messageKind = ref<'success' | 'error'>('success')
const excelInput = ref<HTMLInputElement>()

async function save(payload: ProjectMutationInput) {
  submitting.value = true
  setMessage('', 'success')
  try {
    await rawFetch(`/api/projects/${projectId}`, { method: 'PATCH', body: payload })
    await refresh()
    setMessage('案件設定を保存しました。', 'success')
  } catch (caught) {
    setMessage(getErrorMessage(caught), 'error')
  } finally {
    submitting.value = false
  }
}

async function uploadExcel() {
  const file = excelInput.value?.files?.[0]
  if (!file) return setMessage('Excelファイルを選択してください。', 'error')
  uploading.value = true
  const body = new FormData()
  body.append('excel', file)
  try {
    await $fetch(`/api/projects/${projectId}/excel`, { method: 'POST', body })
    await refresh()
    if (excelInput.value) excelInput.value.value = ''
    setMessage('Excelを案件フォルダへコピー保存しました。原本は変更していません。', 'success')
  } catch (caught) {
    setMessage(getErrorMessage(caught), 'error')
  } finally {
    uploading.value = false
  }
}

async function toggleArchive() {
  const project = data.value?.project
  if (!project) return
  const action = project.archivedAt ? 'unarchive' : 'archive'
  await $fetch(`/api/projects/${projectId}/${action}`, { method: 'POST' })
  if (action === 'archive') await navigateTo('/')
  else await refresh()
}

function setMessage(value: string, kind: 'success' | 'error') {
  message.value = value
  messageKind.value = kind
}

function getErrorMessage(caught: unknown): string {
  return (caught as { data?: { statusMessage?: string } }).data?.statusMessage ?? '処理に失敗しました。'
}
</script>

<template>
  <section class="narrow stack spacious">
    <p v-if="error" class="notice error">案件を読み込めませんでした。</p>
    <template v-else-if="data?.project">
      <div class="page-heading">
        <div>
          <p class="eyebrow">PROJECT SETTINGS</p>
          <h1>{{ data.project.name }}</h1>
          <p v-if="data.project.archivedAt" class="archive-label">アーカイブ中 — 設定とExcelは変更できません。</p>
        </div>
        <button class="button" :class="data.project.archivedAt ? 'primary' : 'danger'" @click="toggleArchive">
          {{ data.project.archivedAt ? 'アーカイブを解除' : 'アーカイブ' }}
        </button>
      </div>

      <p v-if="message" class="notice" :class="messageKind">{{ message }}</p>

      <div class="card form-card" :class="{ disabled: data.project.archivedAt }">
        <h2>基本設定</h2>
        <ProjectForm
          :project="data.project"
          :submitting="submitting"
          :aria-disabled="Boolean(data.project.archivedAt)"
          @submit="save"
        />
      </div>

      <div class="card form-card" :class="{ disabled: data.project.archivedAt }">
        <p class="eyebrow">EXCEL</p>
        <h2>入力ファイル</h2>
        <p>登録済み: <strong>{{ data.project.excelFileName || '未登録' }}</strong></p>
        <p class="hint">.xlsxを案件内の input/current.xlsx へコピーします。内容検証はPhase 2で実装します。</p>
        <div class="upload-row">
          <input ref="excelInput" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :disabled="Boolean(data.project.archivedAt)">
          <button class="button primary" :disabled="uploading || Boolean(data.project.archivedAt)" @click="uploadExcel">
            {{ uploading ? '保存中…' : 'Excelを登録' }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>
