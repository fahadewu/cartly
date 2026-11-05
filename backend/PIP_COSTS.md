# Pip: AI cost and relevance research (October 2026)

What Pip's AI spend was made of, what was changed to cut it, how off-topic questions are now caught before any
paid call, and which options were rejected and why. Running settings and the decisions still open are in
[SCALING.md](SCALING.md) ("AI spend", "Decisions for you"); how the brain works is in [ai/README.md](ai/README.md).

**About the numbers.** This machine has no Anthropic API key, so nothing here was measured on live traffic.
Token counts come from the real local data (the 40-product catalog, real prompts, scripted replies) at
labelled characters-per-token ratios (Latin prose 3.6, JSON 3.0, Bengali/Devanagari/Arabic script 1.2), and
traffic shares are assumptions. Treat every saving as an estimate: the meter's new counters (below) and two
paid scripts (`ai/scripts/pip_model_eval.py`, about $4; `ai/scripts/pip_cache_probe.py`, about $0.10) replace
them once you approve a run.

## Summary

- A Pip message was one Claude Opus 5.5 call of about **$0.006–0.011**: ~9k cached prompt tokens (persona and
  catalog), 0.2–0.45k uncached (the context note and the message) and ~90–210 visible output tokens plus up
  to ~150 tokens of thinking, which can't be switched off on Opus 5.5. **Output was the biggest part (38–62%).**
- Nothing screened messages before Claude, so every homework question, jailbreak, "thanks" or TV-noise
  transcript was a full paid turn. But the largest avoidable spend was Pip's own interface: the product-card
  **Add / Try on buttons typed "Add number N" into a Claude turn** (two turns for a multi-size item), the
  history window rewrote itself to the cache every turn of a long chat, and `speech` was generated on typed
  turns where it is never spoken.
- The changes in this release are expected to cut **about 30–40% of Pip's chat spend on the same model**, more
  in quiet hours and during abuse; moving to Claude Sonnet 5.5 after the eval would bring it to about 60%.
- A free **relevance check** now answers obvious off-topic tasks, prompt-injection attempts, noise and plain
  thank-yous from templates in 8 languages. It made **zero wrong declines on 1,127 genuine shopping, support
  and small-talk messages** in a 1,501-message test set in 13 languages (plus romanized Bangla, Hindi and Urdu), catches 56% of off-topic and 65% of
  injection attempts, and takes 25 µs. Everything it isn't sure about still goes to Claude, which declines
  the rest itself.
- **RAG was considered and rejected** at this catalog size: on Opus 5.5 a product line in the cached prompt
  costs a twentieth of one retrieved into the uncached turn, so retrieval would cost about 4x more per turn.

## How the research was done

- Every paid AI path was read (`ai/app/brain/claude.py`, `llm.py`, `usage.py`, the storefront agent, the
  gateway, the admin photo check and product suggestions, voice, try-on). Prompts were rebuilt from the local
  database and simulated turn by turn, including what Anthropic's prompt cache reads and writes.
- Six independent tracks: a token-cost profile, where messages come from, how off-topic messages were handled,
  and web research on off-topic detection, cost levers and the psychology of chat UIs. A synthesis turned
  them into a plan, two critics attacked it, and after implementation five reviewers (correctness and cache
  mechanics, a red team on the relevance check, storefront and gateway, the copy in each language, security)
  reported 48 findings; a skeptic re-ran each one, 43 were confirmed, and all 43 were fixed with tests that
  fail on the earlier code.
- The relevance check is tested on **1,501 labelled messages** (`ai/tests/data/relevance_cases.json`): 522
  shopping, 286 store support, 156 follow-ups inside a conversation, 64 borderline, 99 small talk, 226
  off-topic, 83 injection, 33 noise and 32 abusive; English, Bangla, Banglish, Hindi, Hinglish, Urdu, Arabic,
  Spanish, plus Tamil, French, Turkish, Indonesian, Nepali and others; about half are deliberately tricky
  ("shoes for my diabetic dad", "a t-shirt with a Python logo", "আল্লাহ হাফেজ", a bill like "2×1200 koto?").
- Five multilingual sentence encoders were benchmarked on CPU against public datasets (Amazon shopping
  queries, CLINC out-of-scope, MASSIVE in Bangla, Hindi, Urdu, Arabic, Spanish) for an optional semantic layer.

## Where the money went (before this release)

| Part of a Pip turn (Opus 5.5, effort low) | Tokens | Price | Share of the turn |
|---|---|---|---|
| Persona + 40-product catalog, shared by every shopper | ~9,000 | cache read $0.20/M | 18–33% |
| Earlier messages in the chat | reads up to ~1.3k; writes 50–115 a turn, **300–500 on every turn after the 7th message** | $0.20/M read, $5/M write | 8–14% |
| Context note + message (uncached) | 210–250 for a guest, 420–450 signed in | $4/M | 9–16% |
| Visible JSON reply | 87–143 English, 126–207 Bangla | $20/M | 38–62% with thinking |
| Thinking (always on in Opus 5.5) | 0–150 (assumed) | $20/M | (included above) |

A Bangla reply costs 16–24% more than an English one, mostly in `speech` and chips: Bengali script takes
more tokens per word. The first call after five minutes of silence store-wide re-wrote the whole 9k prefix
(about $0.045, five turns' worth).

Where messages come from (estimated shares, now measured by `claude:origin:*`): typed 40–55%, voice 10–20%,
chips Claude wrote 15–25%, card Add / Try on 5–12% plus 3–6% size follow-ups, greeting chips 3–8%, the
greeting itself 1–4%, off-topic / abuse / injection / noise 5–15% (Alibaba's AliMe reports about 5% chit-chat),
small talk 5–10%.

Problems found in the code, all fixed in this release:

1. Card buttons were full Claude turns, and their English text switched Bangla and Hindi chats to English.
2. A sliding 12-message window: from the 7th message the oldest exchange dropped every turn, so the cached
   history never matched and all 12 messages were re-written at 1.25x the input price.
3. `speech` was required on every reply but only spoken for voice (27 English / 42 Bangla tokens wasted).
4. The context note paid full price for defaults ("Input: typed", "first name unknown", "nothing on").
5. The off-topic regex only ran when Claude was down; as a filter it would have caught 10% of off-topic
   messages, no injections, and wrongly blocked 4 real shopping questions out of 194.
6. Client fields reached the prompt unchecked: one crafted request could add ~28k uncached tokens a turn
   (~$0.11) or close the `<context>` note and pose as the store.
7. The default search embedder gave Bangla, Hindi and Arabic text an all-zero vector (random results).
8. The meter priced refusal fallbacks as Opus 5.5, ignored per-attempt usage, and couldn't tell sources apart.

## What changed, and what each part saves

| Change | Expected saving (estimate) |
|---|---|
| Card Add / Try on act in the browser (colour and size pickers, a note to Pip with the next message); Claude's size questions carry `askSize` / `askColor` and show size buttons | ≈ 8–15% of calls |
| Shorter replies: 2 short sentences, 2–3 chips, `speech` only when the reply will be spoken | ≈ 8–12% of each remaining turn |
| Stepped history window (16 → 8) so the cached history keeps matching | ≈ 5% overall; 15–17% of each turn past the 7th message |
| Compact, validated context note (defaults left out, products by id, festival notes early in a chat only) | ≈ 3–6% of each turn |
| Shared replies for identical guest requests; a signed-in shopper's opener kept for the hour | ≈ 3–10% of calls |
| Relevance check, template thank-yous, strikes and cooldown | ≈ 3–6% normally, 10–15% during launch spikes or abuse |
| 1-hour cache on the shared prompt | ≈ 0 at peak; most of the cost of quiet hours |
| Daily turn quotas, soft cap for guests near the budget, deadlines, websocket off, hands-free pause | caps the worst cases |
| **Together, overlaps removed** | **≈ 30–40%** |

## The irrelevant-question filter

**Principle: precision first.** A wrong block loses a shopper; a missed off-topic message costs about a cent,
and Claude still declines it (and now flags it with `offTopic`). So the check never declines because of a
*topic* word. "Doctor", "cricket", "exam", "weather", "Python", "Allah" and "news" all appear in real shopping
requests ("a gift for my doctor brother", "jacket for this rainy weather", "kurta for jummah"). It declines
only on the *shape of a task* Pip doesn't do, and only when there is no shopping signal.

The layers, in order (`ai/app/brain/gate.py`):

1. **Role tags** (`</context>`, `[INST]`, `system:`): declined as injection.
2. **Follow-up window**: an answer to Pip's own question, of any length, or a short reply to the cards or a
   rule-brain question is never declined, so "32/34", "a doctor", "yes please" and "M" all reach Claude.
3. **Noise**: only punctuation or symbols, or known speech-to-text artefacts ("[inaudible]", "thank you for
   watching"). No keyboard-mash rule, because "wkwkwk", "jsjsjs" and "yessss" are real messages.
4. **Shopping signal**: catalog words (names, types, keywords incl. Bangla, colours, materials, occasions),
   seed words in 8 languages (garments, store operations, bKash/Nagad/COD, delivery, returns, prices in $ and ৳),
   fashion and occasion emoji, Pip's own chips, and references to the cards ("the middle one", "these two").
   Any signal sends the message to Claude.
5. **Injection phrasing** aimed at Pip's own instructions ("ignore your previous instructions", "print your
   system prompt", "developer mode"), never the shopper's own ("ignore my previous message, show me black").
6. **Task shapes**: arithmetic (not sizes, ranges, dates or bills like "2×1200 koto?"), code-shaped text,
   "write me a poem/essay/letter", "translate this", "solve my homework", capital/president/score/news/weather
   forecast questions, jokes, "what model are you", and their Bangla, Banglish, Hindi, Hinglish, Urdu, Arabic
   and Spanish forms.
7. **Closers**: a whole message that is only thanks, a goodbye or a blessing ("ধন্যবাদ", "আল্লাহ হাফেজ", "shukriya",
   "gracias") gets a warm template and pauses hands-free listening. "ok", "yes", "হ্যাঁ" and "theek hai" are
   answers, not closers.
8. Everything else goes to Claude.

The reply is chosen by script and cue words: Bengali script means Bangla unless Assamese letters appear;
Devanagari means Hindi unless Nepali or Marathi words appear; Arabic script means Urdu or Arabic, and Persian
goes to Claude; Latin script means English, Banglish, Hinglish or Spanish. A language without templates
always goes to Claude.

Behind it, `ai/app/brain/limits.py` counts strikes: 3 off-topic turns (from the check or Claude's flag) within
30 minutes start a 10-minute cooldown for messages with no shopping signal. Strikes are per account, else per
guest chat; mobile shoppers often share one IP, so a stranger's messages never cool anyone else down. Daily
Claude-turn quotas apply per account, guest chat and guest network.

**Results** on the 1,501-message set, all must hold for a release (`ai/tests/test_gate.py`):

| | Result |
|---|---|
| Genuine shopping, support, follow-ups, borderline, small talk (1,127) | **0 declined**; small talk only ever gets a closer |
| Off-topic (226) | 56% answered free; the rest declined by Claude |
| Prompt injection (83) | 65% answered free; with shopping words around it, it goes to Claude and adds a strike |
| Noise (33) | 42% |
| Abusive (32) | all go to Claude, which stays kind (no topic list for insults: "ki faltu sob, aro valo dekhao" is a complaint about the picks) |
| Speed | 25 µs per message on average, 0.6 ms for a 1,000-character message |

For comparison, the previous English regex as a filter: 10% of off-topic, no injection, and 4 genuine
questions wrongly blocked. The review's red team wrote 150 new genuine messages that an earlier version
declined 258 times (complaints read as news, bills as maths, "the model in the photo" as a question about the
AI, smileys as text to translate); all are fixed and in the test set.

**Deferred: a semantic layer.** A local multilingual encoder (`multilingual-e5-small`, int8 ONNX, 118 MB, MIT,
~2 ms per message, ~350 MB RAM per worker) on top of the rules made 0 false blocks on the pilot set and 1 in
3,971 public shopping queries, but caught only 7–13% more of broad off-topic traffic, and romanized Banglish and
Hinglish are every encoder's weak spot. It is worth adding only if the meter shows that turns the check left
unsure and Claude then flagged `offTopic` reach about 3% of calls. bge-m3 transfers better across languages
but needs ~6x the latency and ~3x the memory; paraphrase-multilingual-MiniLM-L12-v2 doesn't cover Bangla.

## Psychological and UX levers

Research on chat UIs points the same way as the cost data: for structured tasks, shoppers prefer direct
manipulation and buttons to typed commands, and they want answers rather than small talk. So the cheap path is
also the better one:

- **Direct actions instead of chat commands.** Card Add / Try on and the size and colour pickers work like
  the heart button already did: instant, free, and they no longer switch a Bangla chat to English.
- **Scope set up front.** The composer asks about "products, sizes or your orders" rather than "anything", and
  the greeting says in a few words what Pip helps with. Users try fewer off-topic things once the scope is
  clear (Microsoft's guidelines for human-AI interaction).
- **Shorter replies, warmth kept.** The cards carry names and prices, so the text says why a pick fits; no
  sign-offs or filler questions; 2–3 chips phrased as the shopper would say them. The mascot carries the warmth.
- **Diverting declines.** A short, sweet "outside my wardrobe" with shopping chips, in the shopper's language;
  users rate redirecting refusals better than flat ones, and the same wording every time makes the boundary
  clear.
- **Closers end the turn.** "Thanks" and goodbyes get a warm template and the voice screen stops listening, so a
  TV in the room doesn't keep paying for transcription, Claude and voice.
- **Generous limits, framed as quick mode.** Hard caps drew complaints at Bing; Pip's quotas are high, and past
  them the shop, cart and checkout keep working with Pip's built-in answers.

Not done yet, worth testing with real traffic: chips carrying an action code (so "show cheaper" or "add the
first one" run in the browser in any language), paging "show more" locally from over-fetched results, a taka
estimate and a cash-on-delivery badge on Pip's cards (it would head off "taka koto?" turns), and a value-framed
sign-in nudge for long guest chats.

## Options rejected, and why

| Option | Why not |
|---|---|
| **RAG instead of the cached catalog** | With prompt caching, a catalog line costs $0.20/M to read and a retrieved line $4/M on Opus 5.5 (1/20th). At 40 products RAG costs ~4x more per turn; break-even is ~160 products on Opus, ~80–120 on Sonnet or Haiku. Above 150 products Pip already adds the top 8 search matches per message. |
| Semantic caching of shopping queries | "Under $50" and "under $100" embed alike; sizes, carts and "the second one" make similar questions different. Only exact matches from shoppers with no personal state are shared. |
| A paid pre-classifier (Haiku 4.5) | +0.6–0.8 s before every reply and ~$0.0005–0.001 a message; pays only when more than ~6–12% of screened messages are off-topic. Claude already declines unsure ones inside the call it makes anyway. |
| Per-turn model routing | Caches are per model, so switching mid-chat re-writes the history at the write price. Anthropic's guidance is to try the stronger model at lower effort first; Pip is already at the lowest effort. |
| Turning off thinking on Opus 5.5 | Not possible: the API rejects it. Effort low is the floor. Sonnet 5.5 can run without thinking. |
| Prompt compression (LLMLingua), rolling summaries | Chats are short; summaries cost an extra call and break the cached prefix. |
| Raising the history to 20 messages | 23–41% more expensive in long chats. |
| Guardrail frameworks (NeMo topic rails, Llama Guard, Prompt Guard) | GPU or an extra model call, weak on Bangla and romanized text, and no better than the rules on Pip's narrow task. Their ideas (topic rails, injection patterns) are in the check. |

## How to check the savings

The admin **System** page now shows "Answered without Claude" (off-topic or noise messages, thank-yous, card
taps) and "Served from cache" (greetings, Pip replies, try-on steps, voice clips). The usage meter adds:

- `gate:<kind>` for every check verdict;
- `claude:origin:<typed|voice|chip|greet>` for where each message came from;
- `claude:offtopic` for Claude's own declines;
- `pip:strikes`, `pip:cooldown`, `pip:quota` and `pip:soft_cap`;
- thinking tokens, stop reasons, and 1-hour cache writes.

After a week, compare the per-turn cost and the off-topic share with the estimates above. With approval, run the
paid eval before choosing a model.

## Sources consulted

The research agents consulted these; the main ones:

- Anthropic: [Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md),
  [optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence.md),
  [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md),
  [mitigating jailbreaks](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks.md),
  and the prompt-caching and refusal-fallback references in the Claude API skill.
- OWASP Top 10 for LLM apps, [LLM10: Unbounded consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/).
- Encoders and data: [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small),
  [bge-m3](https://huggingface.co/BAAI/bge-m3), [LaBSE](https://huggingface.co/sentence-transformers/LaBSE),
  [CLINC150 out-of-scope](https://huggingface.co/datasets/clinc/clinc_oos) (Larson et al., 2019),
  [Amazon shopping queries](https://huggingface.co/datasets/khanmu2003/amazon-shopping-queries-dataset),
  [MASSIVE bn-BD](https://huggingface.co/datasets/SetFit/amazon_massive_scenario_bn-BD).
- Guardrails: [NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails),
  [Llama Prompt Guard 2](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M),
  [semantic-router thresholds](https://docs.aurelio.ai/semantic-router/user-guide/features/threshold-optimization).
- Cost levers: FrugalGPT ([arXiv:2305.05176](https://arxiv.org/abs/2305.05176)),
  [RouteLLM](https://sky.cs.berkeley.edu/project/routellm/), [LLMLingua](https://www.microsoft.com/en-us/research/project/llmlingua/),
  RAG vs long context ([arXiv:2407.16833](https://arxiv.org/abs/2407.16833)).
- UX: [Microsoft guidelines for human-AI interaction](https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/),
  NN/g on [prompt controls](https://www.nngroup.com/articles/prompt-controls-genai/) and
  [less chat, more answer](https://www.nngroup.com/articles/less-chat-more-answer/),
  [Google conversation design: chips](https://developers.google.com/assistant/conversation-design/chips),
  [Alexa's one-breath test](https://developer.amazon.com/en-US/blogs/alexa/post/531ffdd7-acf3-43ca-9831-9c375b08afe0/things-every-alexa-skill-should-do-pass-the-one-breath-test),
  Shneiderman and Maes on [direct manipulation vs agents](https://www.cs.umd.edu/users/ben/papers/Shn-Maes-v4n6-1997.pdf),
  Amazon's playful-requests study ([PDF](https://cdn.amazon.science/3a/b0/9af936e940cabdf0d9a82601150e/alexa-do-you-want-to-build-a-snowman-characterizing-playful-requests-to-conversational-agents.pdf)).
