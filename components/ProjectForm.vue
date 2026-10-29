<script setup lang="ts">
import type { ProjectMutationInput, ProjectView } from '~/shared/types/project'
import type { AiPriceProfile } from '~/shared/types/ai'
import { buildProjectMutationInput, createProjectFormState } from '~/shared/utils/project-form'

const props = defineProps<{
  project?: ProjectView
  submitting?: boolean
}>()

const emit = defineEmits<{
  submit: [payload: ProjectMutationInput]
}>()

const form = reactive(createProjectFormState(props.project))
const { data: aiConfig } = await useFetch<{
  apiKeyConfigured: boolean
  defaultModel: string
  defaultPriceProfileId: string
  priceProfiles: AiPriceProfile[]
}>('/api/ai/config')

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
          <option value="api">API：OpenAI APIで自動判定する</option>
        </select>
      </label>
      <p v-if="form.settings.ai.mode === 'manual'" class="hint">
        検査後にマスキング済みJSONをダウンロードし、Codexの判定結果JSONを取り込みます。自動マスキングですべての個人情報を検出できるとは限りません。
      </p>
      <div v-if="form.settings.ai.mode === 'api'" class="stack compact">
        <p class="notice" :class="aiConfig?.apiKeyConfigured ? 'success' : 'error'">
          OpenAI APIキー：{{ aiConfig?.apiKeyConfigured ? 'サーバーに設定済み' : '未設定（OPENAI_API_KEYを設定してください）' }}
        </p>
        <div class="field-grid">
          <label>
            使用モデル
            <select v-model="form.settings.ai.model">
              <option v-for="profile in aiConfig?.priceProfiles ?? []" :key="profile.modelId" :value="profile.modelId">{{ profile.modelId }}</option>
            </select>
          </label>
          <label>
            価格プロファイル
            <select v-model="form.settings.ai.priceProfileId">
              <option v-for="profile in aiConfig?.priceProfiles ?? []" :key="profile.profileId" :value="profile.profileId">{{ profile.label }}</option>
            </select>
          </label>
          <label>
            1検査の料金上限（USD）
            <input v-model.number="form.settings.ai.costLimitUsd" type="number" min="0.01" max="1000" step="0.01">
          </label>
        </div>
        <p class="hint">料金は概算であり、実際の請求額を保証しません。APIキー自体は画面・案件データ・検査結果へ保存しません。</p>
      </div>
    </fieldset>

    <fieldset>
      <legend>認証</legend>
      <label>
        認証方式
        <select v-model="form.settings.auth.mode">
          <option value="none">なし</option>
          <option value="basic">Basic認証</option>
          <option value="password_protected">パスワード保護</option>
        </select>
      </label>

      <p v-if="form.settings.auth.mode === 'form'" class="notice error">
        この案件は廃止された旧フォーム認証を使用しています。検査を再開するには「なし」「Basic認証」「パスワード保護」のいずれかへ再設定してください。保存済みの認証情報は自動削除されません。
      </p>

      <div v-if="form.settings.auth.mode === 'basic'" class="stack compact">
        <p v-if="project?.credentialsConfigured" class="hint">認証情報は設定済みです。変更する場合だけ再入力してください。</p>
        <div class="field-grid">
          <label>ユーザー名<input v-model="form.username" autocomplete="off" :required="!(project?.credentialsConfigured && project.settings.auth.mode === 'basic')"></label>
          <label>パスワード<input v-model="form.password" type="password" autocomplete="new-password" :required="!(project?.credentialsConfigured && project.settings.auth.mode === 'basic')"></label>
        </div>
      </div>

      <div v-if="form.settings.auth.mode === 'password_protected'" class="stack compact">
        <p v-if="project?.credentialsConfigured && project.settings.auth.mode === 'password_protected'" class="hint">パスワードは設定済みです。変更する場合だけ再入力してください。</p>
        <label>パスワード<input v-model="form.password" type="password" autocomplete="new-password" :required="!(project?.credentialsConfigured && project.settings.auth.mode === 'password_protected')"></label>
        <p class="hint">WordPress「Password Protected」プラグインによるサイト全体のパスワード保護に対応します。</p>
      </div>
    </fieldset>

    <button class="button primary" type="submit" :disabled="submitting">
      {{ submitting ? '保存中…' : project ? '変更を保存' : '案件を作成' }}
    </button>
  </form>
</template>
