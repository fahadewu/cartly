<script setup>
import { reactive, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import AuthField from '../components/AuthField.vue'
import Icon from '../components/Icon.vue'
import { useShop } from '../store.js'
import { auth } from '../auth.js'
import { toast } from '../toast.js'

const { state, addRequest } = useShop()

const blank = () => ({ product: '', category: 'Clothing', size: '', budget: '', link: '', notes: '', email: auth.user?.email ?? '' })
const form = reactive(blank())
const errors = reactive({})
const sending = ref(false)

function validate() {
  const e = {}
  if (form.product.trim().length < 3) e.product = 'Tell us what you’re looking for.'
  if (form.budget && !(Number(form.budget) > 0)) e.budget = 'Enter a number, e.g. 80.'
  if (form.link && !/^https?:\/\/\S+\.\S+/.test(form.link)) e.link = 'Enter a full link starting with https://'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Enter a valid email so we can reply.'
  Object.keys(errors).forEach((k) => delete errors[k])
  Object.assign(errors, e)
  return !Object.keys(e).length
}

async function submit() {
  if (!validate()) return
  sending.value = true
  try {
    await addRequest({ ...form, product: form.product.trim(), notes: form.notes.trim(), email: form.email.trim() })
    Object.assign(form, blank())
    toast('Request sent. We’ll be in touch within 48 hours')
  } catch (e) {
    errors.form = e.message
  } finally {
    sending.value = false
  }
}

const fmt = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
</script>

<template>
  <div>
    <PageHeader
      title="Request a product"
      subtitle="Can’t find it? Tell us and our buyers will try to source it for you."
      :crumbs="[{ label: 'Explore', to: '/' }, { label: 'Request a product' }]"
    />

    <div class="page layout">
      <form class="box" novalidate @submit.prevent="submit">
        <h2>What are you looking for?</h2>
        <div class="form-grid">
          <AuthField v-model="form.product" label="Product" icon="search" placeholder="e.g. Linen wide-leg trousers in olive" :error="errors.product" class="full" />
          <div>
            <label class="label" for="req-cat">Category</label>
            <select id="req-cat" v-model="form.category" class="select">
              <option>Clothing</option>
              <option>Shoes</option>
              <option>Accessories</option>
              <option>Home</option>
              <option>Gifts</option>
            </select>
          </div>
          <AuthField v-model="form.size" label="Size (optional)" placeholder="e.g. M or 42" />
          <AuthField v-model="form.budget" label="Budget in $ (optional)" inputmode="decimal" placeholder="e.g. 80" :error="errors.budget" />
          <AuthField v-model="form.link" label="Reference link (optional)" type="url" placeholder="https://" :error="errors.link" />
          <div class="full">
            <label class="label" for="req-notes">Anything else? (optional)</label>
            <textarea id="req-notes" v-model="form.notes" class="textarea" maxlength="500" placeholder="Colour, material, occasion…" />
          </div>
          <AuthField v-model="form.email" label="Where should we reply?" icon="mail" type="email" :error="errors.email" class="full" />
        </div>
        <p v-if="errors.form" class="form-alert error" role="alert"><Icon name="alert" :size="16" />{{ errors.form }}</p>
        <button class="btn-primary submit" type="submit" :disabled="sending">
          <span v-if="sending" class="spinner" />{{ sending ? 'Sending…' : 'Send request' }}
        </button>
      </form>

      <aside class="side">
        <div class="how">
          <h3>How it works</h3>
          <ol>
            <li><b>1</b>Tell us what you need</li>
            <li><b>2</b>Our buyers search 400+ brands</li>
            <li><b>3</b>We email you options within 48 hours</li>
          </ol>
        </div>

        <section class="box">
          <h2>Your requests</h2>
          <p v-if="!state.requests.length" class="muted none">No requests yet. They’ll appear here once sent.</p>
          <ul v-else class="reqs">
            <li v-for="r in state.requests" :key="r.id">
              <span class="ic"><Icon name="search" :size="16" /></span>
              <div>
                <b>{{ r.product }}</b>
                <small>{{ r.category }}<template v-if="r.budget"> · up to ${{ r.budget }}</template> · {{ fmt(r.date) }}</small>
              </div>
              <span class="status" :class="r.status.toLowerCase()">{{ r.status }}</span>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: 24px;
  align-items: start;
}
.submit {
  width: 100%;
  margin-top: 24px;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.how {
  padding: 28px;
  border-radius: var(--r-card);
  background: var(--butter);
}
.how h3 {
  margin-bottom: 16px;
  font-size: 18px;
  font-weight: 600;
}
.how ol {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
}
.how li {
  display: flex;
  align-items: center;
  gap: 12px;
}
.how li b {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #fff;
  font-size: 13px;
}
.none {
  font-size: 14px;
}
.reqs {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.reqs li {
  display: flex;
  align-items: center;
  gap: 12px;
}
.reqs div {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.reqs b {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reqs small {
  font-size: 12px;
  color: var(--muted);
}
.ic {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--chip);
  color: var(--blue);
}

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
