<script setup lang="ts">
import type { ProjectMutationInput, ProjectView } from '~/shared/types/project'

const submitting = ref(false)
const message = ref('')

async function create(payload: ProjectMutationInput) {
  submitting.value = true
  message.value = ''
  try {
    const response = await $fetch<{ project: ProjectView }>('/api/projects', { method: 'POST', body: payload })
    await navigateTo(`/projects/${response.project.projectId}`)
  } catch (error) {
    message.value = getErrorMessage(error)
  } finally {
    submitting.value = false
  }
}

function getErrorMessage(error: unknown): string {
  return (error as { data?: { statusMessage?: string } }).data?.statusMessage ?? '案件を作成できませんでした。'
}
</script>

<template>
  <section class="narrow stack spacious">
    <div>
      <p class="eyebrow">NEW PROJECT</p>
      <h1>案件を作成</h1>
      <p>認証情報は暗号化して案件データとは別に保存します。</p>
    </div>
    <p v-if="message" class="notice error">{{ message }}</p>
    <div class="card form-card">
      <ProjectForm :submitting="submitting" @submit="create" />
    </div>
  </section>
</template>
