"""Pip's ready-made replies, for the turns Pip answers without Claude.

The relevance gate's declines (an off-topic task, an injection attempt, noise) and closers (a plain
thank-you or goodbye), the cooldown after repeated off-topic turns, quick mode past a daily quota, the
busy reply when Claude is down or slow, and Claude's own refusals. Each is warm and short: one sentence
and an invitation back to shopping, never a lecture or a long apology.

Written for every template language: Bangla with the formal আপনি; Hindi, Urdu, Arabic and Spanish
without gendered forms for Pip or the shopper; Banglish and Hinglish spelt the way people type them;
British spelling in English. A reply picks one of two or three phrasings at random.
"""
import random
import re

from ..config import settings

LANGS = ("en", "bn", "bn-Latn", "hi", "hi-Latn", "ur", "ar", "es")
KINDS = ("offtopic", "injection", "junk", "closer", "cooldown", "quota", "busy", "refusal")
# The BCP-47 tag Pip speaks and listens in for each (Banglish and Hinglish too: the same voice).
TAGS = {"en": "en", "bn": "bn-BD", "bn-Latn": "bn-BD", "hi": "hi-IN", "hi-Latn": "hi-IN", "ur": "ur-PK", "ar": "ar", "es": "es"}
# Pip's face: sweet, not sorry, when it can't help; happy when it can't chat right now or says goodbye.
MOODS = {"closer": "happy", "quota": "happy", "busy": "happy"}

# "{name}" marks where the shopper's first name goes as ", Name" when Pip knows it; it vanishes otherwise.
TEXTS: dict[str, dict[str, list[str]]] = {
    "offtopic": {
        "en": [
            "Aww, that one's outside my wardrobe! 🙈 I'm all about shopping at Cartly — shall I find you something lovely?",
            "Ooh, that's not really my department! 😊 I'm here for shopping at Cartly — want me to find you something you'll love?",
            "Hmm, that's one for someone else! 💕 Shopping at Cartly is my thing — shall we find you something nice?",
        ],
        "bn": [
            "ওহ, এটা তো আমার সিলেবাসের বাইরে! 🙈 আমি শুধু Cartly-তে কেনাকাটায় সাহায্য করি — আপনার জন্য সুন্দর কিছু খুঁজে দেব?",
            "এটা তো আমার কাজের মধ্যে পড়ে না! 😊 আমি Cartly-তে শপিংয়ে সাহায্য করি — আপনার পছন্দের কিছু দেখাব?",
            "আহা, এটায় তো আমি সাহায্য করতে পারব না! 💕 তবে Cartly-তে সুন্দর কিছু খুঁজে দিতে পারি — দেখবেন?",
        ],
        "bn-Latn": [
            "Aww, eta to amar syllabus-er baire! 🙈 Ami shudhu Cartly-te shopping-e help kori — apnar jonno sundor kichu khuje dibo?",
            "Eta to amar kajer moddhe pore na! 😊 Ami Cartly-te shopping-e help kori — apnar pochonder kichu dekhabo?",
            "Aha, eta te to help korte parbo na! 💕 Tobe Cartly-te sundor kichu khuje dite pari — dekhben?",
        ],
        "hi": [
            "अरे, यह तो मेरी अलमारी से बाहर का सवाल है! 🙈 मेरा काम Cartly पर शॉपिंग में मदद करना है — आपके लिए कुछ प्यारा ढूँढूँ?",
            "यह सवाल मेरे दायरे से बाहर है! 😊 मैं यहाँ Cartly पर शॉपिंग के लिए हूँ — आपकी पसंद का कुछ दिखाऊँ?",
            "ओह, इसमें मुझसे मदद नहीं हो पाएगी! 💕 लेकिन Cartly पर कुछ सुंदर ज़रूर मिलेगा — देखें?",
        ],
        "hi-Latn": [
            "Arre, yeh toh meri almaari se bahar ka sawaal hai! 🙈 Mera kaam Cartly par shopping mein madad karna hai — aapke liye kuch pyaara dhoondhun?",
            "Yeh sawaal mere daayre se bahar hai! 😊 Main yahan Cartly par shopping ke liye hoon — aapki pasand ka kuch dikhaun?",
            "Oh, ismein mujhse madad nahi ho paayegi! 💕 Lekin Cartly par kuch sundar zaroor milega — dekhein?",
        ],
        "ur": [
            "ارے، یہ تو میری الماری سے باہر کا سوال ہے! 🙈 میرا کام Cartly پر شاپنگ میں مدد کرنا ہے — آپ کے لیے کچھ پیارا ڈھونڈوں؟",
            "یہ سوال میرے دائرے سے باہر ہے! 😊 میں یہاں Cartly پر شاپنگ کے لیے ہوں — آپ کی پسند کا کچھ دکھاؤں؟",
            "اوہ، اس میں مجھ سے مدد نہیں ہو سکے گی! 💕 لیکن Cartly پر کچھ خوبصورت ضرور ملے گا — دیکھیں؟",
        ],
        "ar": [
            "أوه، هذا ليس مجالي! 🙈 أنا هنا لمساعدتك في التسوق من Cartly فقط — هل أبحث لك عن شيء جميل؟",
            "هذا السؤال خارج اختصاصي! 😊 مهمتي مساعدتك في التسوق من Cartly — هل أعرض لك شيئاً يعجبك؟",
        ],
        "es": [
            "¡Ay, eso se sale de mi terreno! 🙈 Lo mío es ayudarte a comprar en Cartly — ¿te busco algo bonito?",
            "¡Esa pregunta no es lo mío! 😊 Estoy aquí para ayudarte a comprar en Cartly — ¿te muestro algo que te guste?",
            "¡Uy, eso no lo tengo en mi armario! 💕 Te ayudo con tus compras en Cartly — ¿buscamos algo especial?",
        ],
    },
    "injection": {
        "en": [
            "I can only help with shopping at Cartly. 😊 What are you looking for?",
            "I'm here just for shopping at Cartly! 😊 What can I find for you?",
        ],
        "bn": [
            "আমি শুধু Cartly-তে কেনাকাটায় সাহায্য করতে পারি। 😊 আপনি কী খুঁজছেন?",
            "Cartly-তে কেনাকাটায় সাহায্য করাই আমার কাজ! 😊 বলুন, কী খুঁজে দেব?",
        ],
        "bn-Latn": [
            "Ami shudhu Cartly-te shopping-e help korte pari. 😊 Apni ki khujchen?",
            "Cartly-te shopping-e help korai amar kaj! 😊 Bolun, ki khuje dibo?",
        ],
        "hi": [
            "मैं सिर्फ़ Cartly पर शॉपिंग में मदद के लिए हूँ। 😊 आपको क्या चाहिए?",
            "Cartly पर शॉपिंग ही मेरा काम है! 😊 बताइए, क्या ढूँढूँ?",
        ],
        "hi-Latn": [
            "Main sirf Cartly par shopping mein madad ke liye hoon. 😊 Aapko kya chahiye?",
            "Cartly par shopping hi mera kaam hai! 😊 Bataiye, kya dhoondhun?",
        ],
        "ur": [
            "میں صرف Cartly پر شاپنگ میں مدد کے لیے ہوں۔ 😊 آپ کو کیا چاہیے؟",
            "میرا کام بس Cartly پر شاپنگ میں مدد کرنا ہے! 😊 بتائیے، کیا ڈھونڈوں؟",
        ],
        "ar": [
            "أستطيع المساعدة في التسوق من Cartly فقط. 😊 عمّ أبحث لك اليوم؟",
            "أنا هنا للتسوق معك من Cartly فقط! 😊 بماذا أساعدك؟",
        ],
        "es": [
            "Solo puedo ayudarte con tus compras en Cartly. 😊 ¿Qué estás buscando?",
            "¡Ayudarte a comprar en Cartly es lo mío! 😊 ¿Qué te busco hoy?",
        ],
    },
    "junk": {
        "en": [
            "Sorry, I didn't catch that — what are you looking for?",
            "Hmm, I didn't quite get that. 😊 What can I find for you?",
        ],
        "bn": [
            "দুঃখিত, ঠিক বুঝতে পারিনি — আপনি কী খুঁজছেন?",
            "হুম, কথাটা ঠিক ধরতে পারলাম না। 😊 আপনার জন্য কী খুঁজে দেব?",
        ],
        "bn-Latn": [
            "Sorry, thik bujhte parini — apni ki khujchen?",
            "Hmm, kothata thik dhorte parlam na. 😊 Apnar jonno ki khuje dibo?",
        ],
        "hi": [
            "माफ़ कीजिए, ठीक से समझ नहीं आया — आपको क्या चाहिए?",
            "हम्म, बात ठीक से पहुँची नहीं। 😊 आपके लिए क्या ढूँढूँ?",
        ],
        "hi-Latn": [
            "Maaf kijiye, theek se samajh nahi aaya — aapko kya chahiye?",
            "Hmm, baat theek se pahunchi nahi. 😊 Aapke liye kya dhoondhun?",
        ],
        "ur": [
            "معاف کیجیے، ٹھیک سے سمجھ نہیں آیا — آپ کو کیا چاہیے؟",
            "ہمم، بات ٹھیک سے پہنچی نہیں۔ 😊 آپ کے لیے کیا ڈھونڈوں؟",
        ],
        "ar": [
            "عذراً، لم أفهم ذلك جيداً — عمّ أبحث لك؟",
            "همم، لم تصلني الرسالة بوضوح. 😊 بماذا أساعدك اليوم؟",
        ],
        "es": [
            "Perdón, no te entendí bien — ¿qué estás buscando?",
            "Mmm, no me llegó bien el mensaje. 😊 ¿Qué te busco?",
        ],
    },
    "closer": {
        "en": [
            "Happy to help{name}! 💙 See you soon.",
            "Take care{name}! 💙 Come back whenever you like.",
            "Always a pleasure{name}! 💙 I'm here whenever you need me.",
        ],
        "bn": [
            "আপনাকে সাহায্য করতে পেরে ভালো লাগল{name}! 💙 আবার দেখা হবে।",
            "ভালো থাকবেন{name}! 💙 আবার আসবেন।",
            "আপনার সঙ্গে কথা বলে ভালো লাগল{name}! 💙 দরকার হলেই ডাকবেন।",
        ],
        "bn-Latn": [
            "Help korte pere bhalo laglo{name}! 💙 Abar dekha hobe.",
            "Bhalo thakben{name}! 💙 Abar ashben.",
        ],
        "hi": [
            "आपकी मदद करके अच्छा लगा{name}! 💙 फिर मिलते हैं।",
            "अपना ख़याल रखिए{name}! 💙 फिर आइएगा।",
            "आपसे बात करके अच्छा लगा{name}! 💙 जब चाहें, आ जाइए।",
        ],
        "hi-Latn": [
            "Aapki madad karke achha laga{name}! 💙 Phir milte hain.",
            "Apna khayal rakhiye{name}! 💙 Phir aaiyega.",
        ],
        "ur": [
            "آپ کی مدد کر کے اچھا لگا{name}! 💙 پھر ملتے ہیں۔",
            "اپنا خیال رکھیے{name}! 💙 پھر آئیے گا۔",
            "آپ سے بات کر کے اچھا لگا{name}! 💙 جب چاہیں، آ جائیے۔",
        ],
        "ar": [
            "سعدتُ بمساعدتك{name}! 💙 إلى اللقاء قريباً.",
            "أهلاً بك دائماً{name}! 💙 أنا هنا متى احتجت.",
            "دمت بخير{name}! 💙 نراك قريباً.",
        ],
        "es": [
            "¡Un placer ayudarte{name}! 💙 Hasta pronto.",
            "¡Cuídate mucho{name}! 💙 Vuelve cuando quieras.",
            "¡Que te vaya bien{name}! 💙 Aquí estaré cuando me necesites.",
        ],
    },
    "cooldown": {
        "en": [
            "Here at Cartly I can only help with shopping and your orders. 💕 Tell me what you need!",
            "I'm just Cartly's shopping helper! 😊 Tell me what you're shopping for, or ask about an order.",
        ],
        "bn": [
            "এখানে আমি শুধু Cartly-তে কেনাকাটা আর আপনার অর্ডার নিয়ে সাহায্য করতে পারি। 💕 কী লাগবে বলুন!",
            "আমি Cartly-র শপিং সহকারী! 😊 কী খুঁজছেন বা কোন অর্ডারের খবর চান, বলুন।",
        ],
        "bn-Latn": [
            "Ekhane ami shudhu Cartly-te shopping ar apnar order niye help korte pari. 💕 Ki lagbe bolun!",
            "Ami Cartly-r shopping helper! 😊 Ki khujchen ba kon order-er khobor chan, bolun.",
        ],
        "hi": [
            "मैं यहाँ सिर्फ़ Cartly पर शॉपिंग और आपके ऑर्डर में मदद के लिए हूँ। 💕 बताइए, क्या चाहिए?",
            "मेरा काम Cartly पर शॉपिंग में मदद करना है! 😊 बताइए, क्या चाहिए — कोई चीज़ या किसी ऑर्डर की जानकारी?",
        ],
        "hi-Latn": [
            "Main yahan sirf Cartly par shopping aur aapke order mein madad ke liye hoon. 💕 Bataiye, kya chahiye?",
            "Mera kaam Cartly par shopping mein madad karna hai! 😊 Bataiye, kya chahiye — koi cheez ya kisi order ki jaankari?",
        ],
        "ur": [
            "میں یہاں صرف Cartly پر شاپنگ اور آپ کے آرڈر میں مدد کے لیے ہوں۔ 💕 بتائیے، کیا چاہیے؟",
            "میرا کام Cartly پر شاپنگ میں مدد کرنا ہے! 😊 بتائیے، کیا چاہیے — کوئی چیز یا کسی آرڈر کی معلومات؟",
        ],
        "ar": [
            "أنا هنا للمساعدة في التسوق من Cartly وفي طلباتك فقط. 💕 بماذا أساعدك؟",
            "كل ما أعرفه هو منتجات Cartly وطلباتك! 😊 عمّ أبحث لك؟",
        ],
        "es": [
            "Aquí solo puedo ayudarte con tus compras y tus pedidos en Cartly. 💕 Cuéntame qué necesitas.",
            "¡Solo sé de compras y pedidos en Cartly! 😊 Cuéntame qué buscas o pregúntame por un pedido.",
        ],
    },
    "quota": {
        "en": [
            "I've chatted a lot today, so my chat is paused for now. 😊 The shop, search, cart and checkout all work as usual!",
            "My chat is paused for now. 😊 You can still browse, search, use your cart and check out as usual.",
        ],
        "bn": [
            "আজ অনেক কথা হয়েছে, তাই আপাতত চ্যাটে বিরতি নিচ্ছি। 😊 তবে শপ, সার্চ, কার্ট আর চেকআউট সবই আগের মতো চলছে!",
            "আপাতত আমার চ্যাট বিরতিতে আছে। 😊 শপ, সার্চ, কার্ট আর চেকআউট সবই আগের মতো চলছে।",
        ],
        "bn-Latn": [
            "Aj onek kotha hoyeche, tai apatoto chat-e break nicchi. 😊 Tobe shop, search, cart ar checkout shob ager motoi cholche!",
            "Apatoto amar chat break-e ache. 😊 Shop, search, cart ar checkout shob ager motoi cholche.",
        ],
        "hi": [
            "आज बहुत बातें हो गईं, इसलिए फ़िलहाल चैट पर ब्रेक है। 😊 पर शॉप, सर्च, कार्ट और चेकआउट सब पहले की तरह चालू हैं!",
            "फ़िलहाल मेरी चैट बंद है। 😊 शॉप, सर्च, कार्ट और चेकआउट सब पहले की तरह चालू हैं।",
        ],
        "hi-Latn": [
            "Aaj bahut baatein ho gayi, isliye filhaal chat par break hai. 😊 Par shop, search, cart aur checkout sab pehle ki tarah chalu hain!",
            "Filhaal meri chat band hai. 😊 Shop, search, cart aur checkout sab pehle ki tarah chalu hain.",
        ],
        "ur": [
            "آج بہت باتیں ہو گئیں، اس لیے فی الحال چیٹ پر وقفہ ہے۔ 😊 لیکن شاپ، سرچ، کارٹ اور چیک آؤٹ سب پہلے کی طرح چل رہے ہیں!",
            "فی الحال میری چیٹ بند ہے۔ 😊 شاپ، سرچ، کارٹ اور چیک آؤٹ سب پہلے کی طرح چل رہے ہیں۔",
        ],
        "ar": [
            "تحدثتُ كثيراً اليوم، لذا أوقفت الدردشة مؤقتاً. 😊 لكن المتجر والبحث والسلة والدفع تعمل كالمعتاد!",
            "الدردشة متوقفة مؤقتاً. 😊 المتجر والبحث والسلة والدفع كلها تعمل كالمعتاد.",
        ],
        "es": [
            "Hoy conversé mucho, así que por ahora pauso el chat. 😊 ¡Pero la tienda, el buscador, el carrito y el pago funcionan como siempre!",
            "El chat está en pausa por ahora. 😊 La tienda, el buscador, el carrito y el pago siguen funcionando como siempre.",
        ],
    },
    "busy": {
        "en": [
            "I'm a bit swamped right now! 😅 The shop, search, cart and checkout all work as usual — try me again in a moment.",
            "Lots of shoppers are chatting with me just now! 😊 The shop, search, cart and checkout all work as usual — I'll be back in a moment.",
        ],
        "bn": [
            "এই মুহূর্তে আমি একটু ব্যস্ত! 😅 শপ, সার্চ, কার্ট আর চেকআউট সবই চলছে — একটু পরে আবার লিখুন।",
            "এখন অনেকের সাথে কথা বলছি! 😊 শপ, সার্চ, কার্ট আর চেকআউট সবই চলছে — একটু পরেই ফিরছি।",
        ],
        "bn-Latn": [
            "Ei muhurte ami ektu busy! 😅 Shop, search, cart ar checkout shob cholche — ektu pore abar likhun.",
            "Ekhon onekei amar sathe kotha bolchen! 😊 Shop, search, cart ar checkout shob cholche — ektu porei firchi.",
        ],
        "hi": [
            "अभी बहुत सारे सवाल आ रहे हैं! 😅 शॉप, सर्च, कार्ट और चेकआउट सब चालू हैं — थोड़ी देर में फिर लिखिए।",
            "इस वक़्त थोड़ी भीड़ है! 😊 शॉप, सर्च, कार्ट और चेकआउट सब चालू हैं — थोड़ी देर बाद फिर बात करते हैं।",
        ],
        "hi-Latn": [
            "Abhi bahut saare sawaal aa rahe hain! 😅 Shop, search, cart aur checkout sab chalu hain — thodi der mein phir likhiye.",
            "Is waqt thodi bheed hai! 😊 Shop, search, cart aur checkout sab chalu hain — thodi der baad phir baat karte hain.",
        ],
        "ur": [
            "ابھی بہت سارے سوال آ رہے ہیں! 😅 شاپ، سرچ، کارٹ اور چیک آؤٹ سب چل رہے ہیں — تھوڑی دیر میں پھر لکھیے۔",
            "اس وقت تھوڑا رش ہے! 😊 شاپ، سرچ، کارٹ اور چیک آؤٹ سب چل رہے ہیں — تھوڑی دیر بعد پھر بات کرتے ہیں۔",
        ],
        "ar": [
            "هناك ضغط كبير عليّ الآن! 😅 المتجر والبحث والسلة والدفع تعمل كالمعتاد — يمكنك المحاولة مرة أخرى بعد قليل.",
            "الكثير من المتسوقين يتحدثون معي الآن! 😊 المتجر والبحث والسلة والدفع تعمل كالمعتاد — سأعود بعد لحظات.",
        ],
        "es": [
            "¡Ahora mismo tengo mucho trabajo! 😅 La tienda, el buscador, el carrito y el pago funcionan como siempre — escríbeme de nuevo en un momento.",
            "¡Hay muchas personas conversando conmigo ahora! 😊 La tienda, el buscador, el carrito y el pago funcionan como siempre — vuelvo en un momento.",
        ],
    },
    "refusal": {
        "en": [
            "Sorry, I can't help with that one. Want to look at something else? 😊",
            "That's not something I can help with, sorry! Shall we look at something else?",
        ],
        "bn": [
            "দুঃখিত, এটায় সাহায্য করতে পারব না। অন্য কিছু দেখবেন? 😊",
            "এটা আমি পারব না, দুঃখিত! চলুন, অন্য কিছু দেখি?",
        ],
        "bn-Latn": [
            "Sorry, eta te help korte parbo na. Onno kichu dekhben? 😊",
            "Eta ami parbo na, sorry! Cholun, onno kichu dekhi?",
        ],
        "hi": [
            "माफ़ कीजिए, इसमें मदद नहीं हो पाएगी। कुछ और देखें? 😊",
            "यह मुझसे नहीं हो पाएगा, माफ़ कीजिए! चलिए, कुछ और देखते हैं?",
        ],
        "hi-Latn": [
            "Maaf kijiye, ismein madad nahi ho paayegi. Kuch aur dekhein? 😊",
            "Yeh mujhse nahi ho paayega, maaf kijiye! Chaliye, kuch aur dekhte hain?",
        ],
        "ur": [
            "معاف کیجیے، اس میں مدد نہیں ہو پائے گی۔ کچھ اور دیکھیں؟ 😊",
            "یہ مجھ سے نہیں ہو پائے گا، معاف کیجیے! چلیے، کچھ اور دیکھتے ہیں؟",
        ],
        "ar": [
            "عذراً، لا أستطيع المساعدة في هذا. هل نلقي نظرة على شيء آخر؟ 😊",
            "هذا ليس مما أستطيع المساعدة فيه، عذراً! هل نرى شيئاً آخر؟",
        ],
        "es": [
            "Lo siento, con eso no puedo ayudarte. ¿Vemos otra cosa? 😊",
            "Eso no es algo con lo que pueda ayudarte, ¡lo siento! ¿Miramos otra cosa?",
        ],
    },
}

# Follow-ups the shopper can tap (sent as their message), in their language.
CHIPS = {
    "en": ["Show me new arrivals", "Gift ideas", "Today's deals"],
    "bn": ["নতুন কী এসেছে দেখান", "গিফট আইডিয়া", "আজকের অফার"],
    "bn-Latn": ["Notun ki esheche dekhan", "Kichu gift idea din", "Ajker offer"],
    "hi": ["नया क्या आया है, दिखाइए", "गिफ़्ट आइडिया", "आज के ऑफ़र"],
    "hi-Latn": ["Naya kya aaya hai, dikhaiye", "Kuch gift ideas dikhaiye", "Aaj ke offers"],
    "ur": ["نیا کیا آیا ہے، دکھائیے", "گفٹ آئیڈیاز", "آج کی آفرز"],
    "ar": ["ما المنتجات الجديدة؟", "أفكار هدايا", "عروض اليوم"],
    "es": ["Muéstrame las novedades", "Ideas de regalo", "Ofertas de hoy"],
}

EMOJI = re.compile(
    "[\U0001f000-\U0001faff\u2600-\u27bf\u2300-\u23ff\u2b00-\u2bff\u3030\u303d\u3297\u3299\ufe0f\u200d\u20e3]"
)
_NAME_DROP = re.compile(r"[*_`#~<>\[\]{}()|\\\"\n\r\t]")


def language_of(lang: str | None) -> str | None:
    """Map a BCP-47 tag ("bn-BD", "hi-Latn", "es-419") or a template key to the template language it is
    written in, or None. Only languages switched on in PIP_TEMPLATE_LANGS count; Roman Urdu reads the
    Hinglish templates."""
    key = _key(lang)
    return key if key in settings.pip_template_langs else None


def reply(kind: str, lang: str | None, name: str | None = None) -> dict:
    """A ready Pip reply of `kind` (see KINDS) in template language `lang` (a key or a BCP-47 tag;
    English when it has no template), with no products or actions and shopping chips to tap. Quick mode
    ("quota") has none outside English: there a tap would only get the same template back (English chips
    go to the rule brain, which answers them)."""
    if kind not in TEXTS:
        raise ValueError(f"unknown template kind {kind!r}")
    key = language_of(lang) or "en"
    text = random.choice(TEXTS[kind][key])
    who = _name(name)
    text = text.replace("{name}", f"{'، ' if key in ('ur', 'ar') else ', '}{who}" if who else "")
    return {
        "text": text,
        "speech": speech_of(text),
        "lang": TAGS[key],
        "products": [],
        "actions": [],
        "chips": [] if kind == "quota" and key != "en" else list(CHIPS[key]),
        "mood": MOODS.get(kind, "love"),
    }


def speech_of(text: str) -> str:
    """The same words for text-to-speech: no emoji or markdown."""
    return re.sub(r"\s+", " ", EMOJI.sub("", re.sub(r"[*_`#]", "", text))).strip()


def is_template(text: str | None) -> bool:
    """Was this reply text (as stored in the history) one of these templates? Declines carry no name."""
    return bool(text) and re.sub(r"\s+", " ", text).strip() in _ALL


def _key(lang: str | None) -> str | None:
    if not lang or not isinstance(lang, str):
        return None
    if lang in LANGS:
        return lang
    parts = lang.strip().replace("_", "-").split("-")
    base = parts[0].lower()
    latin = any(p.lower() == "latn" for p in parts[1:])
    if base in ("bn", "hi"):
        return f"{base}-Latn" if latin else base
    if base == "ur":
        return "hi-Latn" if latin else "ur"
    if base == "ar":
        return None if latin else "ar"  # Arabizi: no template
    return base if base in ("en", "es") else None


def _name(name: str | None) -> str:
    """The shopper's first name, safe to print: no markdown, brackets or emoji, short."""
    if not name or not isinstance(name, str):
        return ""
    clean = re.sub(r"\s+", " ", EMOJI.sub("", _NAME_DROP.sub("", name))).strip()
    return clean.split(" ")[0][:24]


_ALL = frozenset(
    re.sub(r"\s+", " ", v.replace("{name}", "")).strip() for by_lang in TEXTS.values() for vs in by_lang.values() for v in vs
)
