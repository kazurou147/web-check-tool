<script setup lang="ts">
import type { ProjectMutationInput, ProjectView } from '~/shared/types/project'
import { buildProjectMutationInput, createProjectFormState } from '~/shared/utils/project-form'

const props = defineProps<{
  project?: ProjectView
  submitting?: boolean
}>()

const emit = defineEmits<{
  submit: [payload: ProjectMutationInput]
}>()

const form = reactive(createProjectFormState(props.project))

function submit() {
  emit('submit', buildProjectMutationInput(form))
}
</script>

<template>
  <form class="stack" @submit.prevent="submit">
    <label>
      案件名
      <input v-model="form.name" required maxlength="200" autocomplete="off">
    </label>

    <div class="field-grid">
      <label>
        ページ並列数
        <select v-model.number="form.settings.pageConcurrency">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
        </select>
      </label>
      <label>
        タイムアウト（ミリ秒）
        <input v-model.number="form.settings.navigationTimeoutMs" type="number" min="1000" max="120000" step="1000">
      </label>
    </div>

    <label>
      ローカル・私設IPへの明示許可ホスト（1行1件）
      <textarea
        :value="form.settings.allowedPrivateHosts.join('\n')"
        rows="3"
        placeholder="staging.example.local"
        @input="form.settings.allowedPrivateHosts = ($event.target as HTMLTextAreaElement).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)"
      />
      <span class="hint">SSRF対策により通常は拒否します。検査が必要な社内・ローカル環境だけを明示してください。</span>
    </label>

    <fieldset>
      <legend>AIリンク内容判定</legend>
      <label>
        判定モード
        <select v-model="form.settings.ai.mode">
          <option value="off">OFF：AI判定を使用しない</option>
          <option value="manual">MANUAL：Codexで手動判定する</option>
          <option value="api" disabled>API：OpenAI APIで自動判定する（Phase 5-Cで実装予定）</option>
        </select>
      </label>
      <p v-if="form.settings.ai.mode === 'manual'" class="hint">
        検査後にマスキング済みJSONをダウンロードし、Codexの判定結果JSONを取り込みます。自動マスキングですべての個人情報を検出できるとは限りません。
      </p>
    </fieldset>

    <fieldset>
      <legend>認証</legend>
      <label>
        認証方式
        <select v-model="form.settings.auth.mode">
          <option value="none">なし</option>
          <option value="basic">Basic認証</option>
          <option value="form">フォーム認証</option>
        </select>
      </label>

      <div v-if="form.settings.auth.mode !== 'none'" class="stack compact">
        <p v-if="project?.credentialsConfigured" class="hint">認証情報は設定済みです。変更する場合だけ再入力してください。</p>
        <div class="field-grid">
          <label>ユーザー名<input v-model="form.username" autocomplete="off" :required="!project?.credentialsConfigured"></label>
          <label>パスワード<input v-model="form.password" type="password" autocomplete="new-password" :required="!project?.credentialsConfigured"></label>
        </div>
      </div>

      <div v-if="form.settings.auth.mode === 'form'" class="stack compact">
        <label>ログインURL<input v-model="form.settings.auth.loginUrl" type="url" required></label>
        <div class="field-grid">
          <label>ユーザー名セレクター<input v-model="form.settings.auth.usernameSelector" required></label>
          <label>パスワードセレクター<input v-model="form.settings.auth.passwordSelector" required></label>
          <label>送信セレクター<input v-model="form.settings.auth.submitSelector" required></label>
          <label>成功URLパターン<input v-model="form.settings.auth.successUrlPattern"></label>
        </div>
      </div>
    </fieldset>

    <button class="button primary" type="submit" :disabled="submitting">
      {{ submitting ? '保存中…' : project ? '変更を保存' : '案件を作成' }}
    </button>
  </form>
</template>
