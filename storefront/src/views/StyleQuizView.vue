<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import ProductCard from '../components/ProductCard.vue'
import { auth } from '../auth.js'
import { buildRounds, labelOf, picksFor, saveStyle, style } from '../style.js'
import { useAgent } from '../agent/useAgent.js'
import { toast } from '../toast.js'

// "This or that": seven quick picks between two looks. Shoppers value what they helped shape, and the store
// can then explain picks with what they chose ("because you picked Minimalist") rather than what it guessed.
const router = useRouter()
const agent = useAgent()

const step = ref('who') // who → play → done
const gender = ref(style.gender ?? 'all')
const rounds = ref([])
const at = ref(0)
const score = reactive({})
const leaving = ref(null) // which side was just picked, for the animation

function start(g) {
  gender.value = g
  rounds.value = buildRounds(g)
  Object.keys(score).forEach((k) => delete score[k])
  at.value = 0
  step.value = rounds.value.length >= 3 ? 'play' : 'thin'
}

function choose(side) {
  if (leaving.value || step.value !== 'play') return
  const [a, b] = rounds.value[at.value]
  if (side === 'a' || side === 'both') score[a.key] = (score[a.key] ?? 0) + (side === 'both' ? 0.5 : 1)
  if (side === 'b' || side === 'both') score[b.key] = (score[b.key] ?? 0) + (side === 'both' ? 0.5 : 1)
  leaving.value = side
  setTimeout(() => {
    leaving.value = null
    if (at.value + 1 < rounds.value.length) at.value++
    else finish()
  }, 260)
}

const ranked = computed(() =>
  Object.entries(score)
    .filter(([, n]) => n > 0)
    .sort((x, y) => y[1] - x[1]),
)
// Their top styles: the best one, plus any close behind it (at most three).
const result = computed(() => {
  const best = ranked.value[0]?.[1] ?? 0
  return ranked.value.filter(([, n], i) => i === 0 || n >= Math.max(1, best - 1)).slice(0, 3).map(([k]) => k)
})
const picks = computed(() => picksFor(result.value, gender.value))
const saving = ref(false)

async function finish() {
  step.value = 'done'
  if (!result.value.length) return
  saving.value = true
  try {
    await saveStyle(result.value, gender.value)
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    saving.value = false
  }
}

function askPip() {
  agent.open('chat')
  agent.send(`Style me an outfit. I picked ${result.value.map(labelOf).join(' and ')} in the style quiz.`)
}

const onKey = (e) => {
  if (step.value !== 'play') return
  if (e.key === 'ArrowLeft') choose('a')
  if (e.key === 'ArrowRight') choose('b')
}
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="quiz-page">
    <section v-if="step === 'who'" class="intro">
      <span class="kicker"><Icon name="sparkle" :size="16" />30-second style quiz</span>
      <h1>This or that?</h1>
      <p>Seven quick picks between two looks. Then everything we suggest starts from what <b>you</b> chose, and you can change it any time.</p>
      <div class="who">
        <button @click="start('women')"><Icon name="woman" :size="22" />Women’s</button>
        <button @click="start('men')"><Icon name="man" :size="22" />Men’s</button>
        <button @click="start('all')"><Icon name="grid" :size="22" />Show me both</button>
      </div>
      <p v-if="style.picked.length" class="muted small">Last time you picked {{ style.picked.map(labelOf).join(', ') }}.</p>
    </section>

    <section v-else-if="step === 'thin'" class="intro">
      <h1>Not enough to compare yet</h1>
      <p>We need a few more pieces in the shop for this quiz. Try “Show me both”, or ask Pip instead.</p>
      <button class="btn-secondary" @click="step = 'who'">Back</button>
    </section>

    <section v-else-if="step === 'play'" class="play">
      <header>
        <button class="link" @click="step = 'who'"><Icon name="chevronLeft" :size="16" />Start over</button>
        <div class="dots" :aria-label="`Pick ${at + 1} of ${rounds.length}`">
          <i v-for="(r, i) in rounds" :key="i" :class="{ done: i < at, on: i === at }" />
        </div>
        <span class="muted small">{{ at + 1 }} / {{ rounds.length }}</span>
      </header>
      <h2>Which feels more like you?</h2>
      <div class="pair">
        <button v-for="(side, si) in rounds[at]" :key="`${at}-${side.key}`" class="look" :class="{ picked: leaving === (si ? 'b' : 'a') || leaving === 'both', out: leaving && leaving !== (si ? 'b' : 'a') && leaving !== 'both' }" :aria-label="`This one: ${side.items.map((p) => p.name).join(' and ')}`" @click="choose(si ? 'b' : 'a')">
          <span class="imgs">
            <img v-for="p in side.items" :key="p.id" :src="p.image" :alt="p.name" />
          </span>
          <span class="this">{{ si ? 'That' : 'This' }}</span>
        </button>
      </div>
      <div class="also">
        <button class="btn-secondary sm" @click="choose('both')">I like both</button>
        <button class="btn-secondary sm" @click="choose('none')">Neither</button>
      </div>
      <p class="muted small hint">Tip: ← and → keys pick too.</p>
    </section>

    <section v-else class="done">
      <template v-if="result.length">
        <span class="kicker"><Icon name="check" :size="16" />{{ saving ? 'Saving…' : auth.user ? 'Saved to your account' : 'Saved on this device' }}</span>
        <h1>You picked <em>{{ result.map(labelOf).join(' + ') }}</em></h1>
        <p>From now on “Picked for you” and Pip start from this. Retake it whenever your mood changes.</p>
        <div class="acts">
          <button class="btn-primary" @click="askPip"><Icon name="sparkle" :size="17" />Ask Pip to style me</button>
          <button class="btn-secondary" @click="step = 'who'"><Icon name="refresh" :size="16" />Retake</button>
          <RouterLink v-if="!auth.user" :to="{ name: 'signup', query: { redirect: '/style' } }" class="btn-secondary">Keep it on an account</RouterLink>
        </div>
        <h2 class="picks-title">Picked from your choices</h2>
        <div class="product-grid">
          <ProductCard v-for="p in picks" :key="p.id" :product="p" compact />
        </div>
      </template>
      <template v-else>
        <h1>Nothing clicked? That’s fine.</h1>
        <p>Tell Pip what you’re after in your own words instead.</p>
        <div class="acts">
          <button class="btn-primary" @click="agent.open('chat')"><Icon name="sparkle" :size="17" />Talk to Pip</button>
          <button class="btn-secondary" @click="router.push('/')">Browse</button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.quiz-page {
  padding: 28px 34px 40px 22px;
}
.intro,
.done {
  max-width: 760px;
}
.kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: var(--r-pill);
  background: var(--mint);
  font-size: 14px;
  font-weight: 500;
}
h1 {
  margin: 14px 0 8px;
  font-size: 44px;
  font-weight: 600;
  letter-spacing: -0.03em;
}
h1 em {
  font-style: normal;
  color: var(--blue);
}
.intro > p,
.done > p {
  max-width: 560px;
  font-size: 17px;
  line-height: 1.55;
  color: #4b5058;
}
.who {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 26px 0 14px;
}
.who button {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 64px;
  padding: 0 26px;
  border-radius: 22px;
  background: var(--card);
  font-size: 17px;
  font-weight: 500;
  transition: transform 0.12s ease, background 0.12s ease;
}
.who button:hover {
  background: var(--butter);
  transform: translateY(-2px);
}
.small {
  font-size: 13px;
}
.play header {
  display: flex;
  align-items: center;
  gap: 16px;
}
.play header .link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
}
.dots {
  flex: 1;
  display: flex;
  justify-content: center;
  gap: 6px;
}
.dots i {
  width: 28px;
  height: 6px;
  border-radius: 3px;
  background: var(--line);
  transition: background 0.2s ease;
}
.dots i.done {
  background: var(--ink);
}
.dots i.on {
  background: var(--blue);
}
.play h2 {
  margin: 22px 0 16px;
  font-size: 28px;
  font-weight: 600;
  text-align: center;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  max-width: 980px;
  margin: 0 auto;
}
.look {
  position: relative;
  padding: 12px;
  border: 2px solid transparent;
  border-radius: 32px;
  background: var(--card);
  transition: transform 0.25s ease, opacity 0.25s ease, border-color 0.15s ease;
}
.look:hover {
  border-color: var(--ink);
  transform: translateY(-3px);
}
.look.picked {
  border-color: var(--blue);
  transform: scale(1.03);
}
.look.out {
  opacity: 0.25;
  transform: scale(0.97);
}
.imgs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.imgs img {
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 22px;
  object-fit: cover;
  background: #fff;
}
.this {
  display: inline-block;
  margin-top: 12px;
  padding: 6px 18px;
  border-radius: var(--r-pill);
  background: #fff;
  font-size: 15px;
  font-weight: 600;
}
.also {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 18px;
}
.hint {
  margin-top: 10px;
  text-align: center;
}
.acts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 22px 0 8px;
}
.acts .btn-primary {
  padding: 0 26px;
}
.acts .btn-primary,
.acts .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
}
.picks-title {
  margin: 34px 0 16px;
  font-size: 24px;
  font-weight: 600;
}
.done {
  max-width: none;
}
@media (max-width: 760px) {
  .quiz-page {
    padding: 20px 16px 32px;
  }
  h1 {
    font-size: 32px;
  }
  .pair {
    gap: 10px;
  }
  .look {
    padding: 8px;
    border-radius: 24px;
  }
  .imgs {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .imgs img:nth-child(2) {
    display: none;
  }
  .play h2 {
    font-size: 22px;
  }
}
</style>
