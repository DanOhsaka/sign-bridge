/* ============================================================
   SignBridge — Teaching dataset (signs.js)
   ------------------------------------------------------------
   Written from a sign-language teacher's perspective.

   Every ASL letter is described using the FOUR PHONOLOGICAL
   PARAMETERS of ASL — handshape, orientation, location,
   movement — the same lens a teacher uses to correct a
   student. `tip` holds the minimal-pair warning ("this sign
   is confused with…"), which the Practice view turns into
   corrective feedback. Confusion maps drive the simulated
   recognizer so the UI shows realistic near-miss behaviour.
   ============================================================ */

window.SB = window.SB || {};

/* ---------- 26 ASL letters ---------- */
SB.LETTERS = [
  { l: "A", shape: "Fist", orient: "Palm away from you", loc: "Neutral space in front of chest", move: "None (static)", tip: "The thumb rests ALONGSIDE the index finger — not tucked under. A / S / T are thumb-placement siblings.", conf: ["S", "T"] },
  { l: "B", shape: "Flat open palm, fingers together", orient: "Palm away from you, fingers up", loc: "Chest height", move: "None (static)", tip: "Thumb tucks across the palm. If the thumb sticks out, it drifts toward 4.", conf: ["4"] },
  { l: "C", shape: "Fingers curved like a cup", orient: "Palm to the side", loc: "Chest height", move: "None (static)", tip: "Fingers stay together and curved. Open it too far and you lose the 'cup' — closest cousin is O.", conf: ["O"] },
  { l: "D", shape: "Index finger up, others curled", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "The thumb rests ON the middle fingertip. If the thumb touches the index fingertip instead, you've drifted toward F.", conf: ["F"] },
  { l: "E", shape: "Fingers curled down toward palm", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "Fingertips touch the palm; thumb sweeps across the front. Curl the fingers too little and it looks like O.", conf: ["O", "S"] },
  { l: "F", shape: "Thumb + index form a circle", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "The other three fingers point straight UP, relaxed. Dropping them makes it look like a '9'-style handshape.", conf: ["D", "T"] },
  { l: "G", shape: "Index + thumb extended forward", orient: "Palm facing in (thumb up)", loc: "Chest height", move: "None (static)", tip: "Palm faces IN for G. Rotate it down and it becomes Q.", conf: ["Q"] },
  { l: "H", shape: "Index + middle extended, together", orient: "Palm facing in, fingers sideways", loc: "Chest height", move: "None (static)", tip: "Two fingers TOGETHER, pointing sideways. Straighten them up with palm out and you're at U.", conf: ["U"] },
  { l: "I", shape: "Pinky up, others curled", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "Thumb rests on top of the curled fingers. Add a downward arc and it becomes J.", conf: ["J"] },
  { l: "J", shape: "Pinky up, others curled", orient: "Palm away from you", loc: "Starts at chest, traces a J", move: "Pinky draws a hook: down, across, up", tip: "Same handshape as I — the MOVEMENT is what makes it J. Trace the hook with your pinky, not your wrist.", conf: ["I", "Z"] },
  { l: "K", shape: "Index + middle up, spread, thumb between", orient: "Palm facing you (thumb up)", loc: "Chest height", move: "None (static)", tip: "Thumb sits between index and middle, fingertips pointing UP. Same handshape, palm DOWN = P.", conf: ["P"] },
  { l: "L", shape: "Index + thumb form an L", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "Thumb straight out. Bend the thumb into the palm and it drifts toward 7.", conf: ["7"] },
  { l: "M", shape: "Index, middle, ring folded over thumb", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "THREE fingers folded over the thumb. Two fingers only = N.", conf: ["N", "T"] },
  { l: "N", shape: "Index + middle folded over thumb", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "TWO fingers folded over the thumb. Three fingers = M.", conf: ["M"] },
  { l: "O", shape: "All fingers + thumb touch in a ring", orient: "Palm to the side", loc: "Chest height", move: "None (static)", tip: "Fingertips meet the thumb tip in a tight circle. Loosen the fingers into a curve and it becomes C.", conf: ["C", "E"] },
  { l: "P", shape: "Index + middle down, thumb between", orient: "Palm facing you, pointing DOWN", loc: "Chest height", move: "None (static)", tip: "Same handshape as K, rotated so fingertips point DOWN.", conf: ["K"] },
  { l: "Q", shape: "Index + thumb extended forward", orient: "Palm facing in, pointing DOWN", loc: "Chest height", move: "None (static)", tip: "Same handshape as G, rotated down.", conf: ["G"] },
  { l: "R", shape: "Index + middle crossed", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "Two fingers CROSSED. Uncross them and you have U.", conf: ["U"] },
  { l: "S", shape: "Fist, thumb wrapped across fingers", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "Thumb wraps OVER the curled fingers. Tuck it between index and middle and it becomes T.", conf: ["A", "T"] },
  { l: "T", shape: "Fist, thumb between index + middle", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "Thumb pokes BETWEEN index and middle. Wrapped over the fingers instead = S.", conf: ["A", "S"] },
  { l: "U", shape: "Index + middle up, TOGETHER", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "Two fingers together, up. Spread them apart = V. Tip them sideways = H.", conf: ["H", "V"] },
  { l: "V", shape: "Index + middle up, SPREAD", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "Two fingers apart, like a peace sign. Squeeze together = U.", conf: ["U", "2"] },
  { l: "W", shape: "Index, middle, ring up", orient: "Palm away from you", loc: "Chest height", move: "None (static)", tip: "THREE fingers up. Thumb rests on the pinky. Let the thumb out and it becomes 3.", conf: ["3"] },
  { l: "X", shape: "Index finger hooked (bent at middle joint)", orient: "Palm facing you", loc: "Chest height", move: "None (static)", tip: "The index hooks like a question mark. Straight index, palm away = 1/D.", conf: ["I", "1"] },
  { l: "Y", shape: "Thumb + pinky out, others curled", orient: "Palm facing you", loc: "Chest height", move: "None (static)", tip: "Thumb and pinky both point out. Tuck the pinky into the palm and it becomes 8.", conf: ["8"] },
  { l: "Z", shape: "Index extended, others curled", orient: "Palm to the side", loc: "Traces a Z in front of you", move: "Index draws: right, diagonal down, right", tip: "It's ALL movement — the handshape never changes. Draw the Z with a loose wrist.", conf: ["J"] },
];
SB.LETTER_MAP = {};
SB.LETTERS.forEach(function (e) { SB.LETTER_MAP[e.l] = e; });

/* ---------- Common phrases (Learn + Practice + Translate chips) ---------- */
SB.PHRASES = [
  { id: "hello",          name: "Hello",            emoji: "👋", cat: "Greetings",  desc: "Flat palm to the forehead, sweep outward and down into neutral space. Face says hello too — a smile does half the work." },
  { id: "good-morning",   name: "Good morning",     emoji: "🌅", cat: "Greetings",  desc: "Good (flat hand on chin, arc forward) + morning (flat palm rests on the other forearm's elbow crease, arm rises like the sun)." },
  { id: "good-night",     name: "Good night",       emoji: "🌙", cat: "Greetings",  desc: "Good + night (flat hand rests on the opposite hand, which sweeps down and closes as the palm lowers)." },
  { id: "nice-to-meet",   name: "Nice to meet you", emoji: "🤝", cat: "Greetings",  desc: "Nice (palm strokes the back of the other hand twice) + meet (two index fingers approach and touch)." },
  { id: "how-are-you",    name: "How are you?",     emoji: "💬", cat: "Greetings",  desc: "How (two thumbs-down hands bounce up toward each other) + are + you (index points out). Raised eyebrows make it a question — expression is grammar!" },
  { id: "thank-you",      name: "Thank you",        emoji: "🙏", cat: "Essentials", desc: "Flat hand at the chin, fingertips touch the mouth, then arc forward and down — the 'blown kiss' toward the person you thank." },
  { id: "please",         name: "Please",           emoji: "🥺", cat: "Essentials", desc: "Flat open hand circles on the chest. Slow and circular — rushing it reads as 'more, hurry up'." },
  { id: "sorry",          name: "Sorry",            emoji: "😔", cat: "Essentials", desc: "Fist rubs a circle on the chest over the heart. The facial expression matters as much as the hand." },
  { id: "excuse-me",      name: "Excuse me",        emoji: "🫡", cat: "Essentials", desc: "Flat hand with thumb out brushes twice across the chest, palm in." },
  { id: "yes",            name: "Yes",              emoji: "✅", cat: "Essentials", desc: "S-hand (fist, thumb out) nods up and down like a head bobbing. Just two small beats." },
  { id: "no",             name: "No",               emoji: "❌", cat: "Essentials", desc: "Index + middle together (N-handshape) close onto the thumb, opening and closing like a mouth saying 'no'." },
  { id: "help",           name: "Help",             emoji: "🆘", cat: "Essentials", desc: "Flat 'A' hand under the other flat palm, and the bottom hand lifts the top one upward. Two beats feels urgent, one beat is neutral." },
  { id: "stop",           name: "Stop",             emoji: "✋", cat: "Essentials", desc: "Flat hand, palm down, chops downward onto the other palm edge. A fast, decisive beat." },
  { id: "wait",           name: "Wait",             emoji: "⏳", cat: "Essentials", desc: "Flat hands, palms up, fingers wiggle as the hands hover. The wiggling says 'hold on — patience'." },
  { id: "understand",     name: "Understand",       emoji: "🧠", cat: "Essentials", desc: "Flat hand, palm out, index fingertip touches the forehead and flicks slightly upward, palm turning toward you." },
  { id: "dont-understand", name: "Don't understand", emoji: "🤷", cat: "Essentials", desc: "Understand + flick the hand back toward the signer while shaking your head — negation lives in the movement and the face." },
  { id: "water",          name: "Water",            emoji: "💧", cat: "Food & drink", desc: "W-handshape (three fingers up) taps the chin twice, index corner of the mouth." },
  { id: "food",           name: "Food / Eat",       emoji: "🍽️", cat: "Food & drink", desc: "Flat hand with thumb up taps the mouth twice. The same sign covers 'eat' — context picks the meaning." },
  { id: "drink",          name: "Drink",            emoji: "🥤", cat: "Food & drink", desc: "C-handshape tips toward the mouth like lifting a cup." },
  { id: "hungry",         name: "Hungry",           emoji: "😋", cat: "Food & drink", desc: "C-handshape at the throat (collarbone), hand curves down like food going down. Your stomach does the face." },
  { id: "more",           name: "More",             emoji: "➕", cat: "Food & drink", desc: "Two pinched hands (fingertips together) tap together twice, fingertips to fingertips." },
  { id: "friend",         name: "Friend",           emoji: "🤗", cat: "People",     desc: "Two index fingers hook together, then rotate and hook again — two people connecting. The double rotation matters." },
  { id: "family",         name: "Family",           emoji: "👨‍👩‍👧", cat: "People",     desc: "F-handshape (thumb + index circle) makes a big circle with both hands, then closes them — the people you circle around." },
  { id: "teacher",        name: "Teacher",          emoji: "🧑‍🏫", cat: "People",     desc: "Teach (two flattened O-hands push away from the forehead) + person (flat hands sweep down the chest)." },
  { id: "student",        name: "Student",          emoji: "🎓", cat: "People",     desc: "Learn (open hand lifts knowledge from the other palm to the forehead) + person." },
  { id: "name",           name: "Name",             emoji: "🏷️", cat: "People",     desc: "H-handshape (two fingers together) taps twice on the other hand's index + middle, palm-up." },
  { id: "i-me",           name: "I / Me",           emoji: "🙋", cat: "People",     desc: "Index finger points to your own chest. The simplest pronoun in ASL — and one of the first things students overthink." },
  { id: "you",            name: "You",              emoji: "👉", cat: "People",     desc: "Index finger points toward the person you mean. In a group, always sign who you mean." },
  { id: "deaf",           name: "Deaf",             emoji: "🦻", cat: "People",     desc: "Index finger touches the ear, then the mouth — ear-to-mouth sweep. Many Deaf people prefer identity-first: 'Deaf person', not 'hearing-impaired'." },
  { id: "sign-language",  name: "Sign language",    emoji: "🤟", cat: "People",     desc: "Two index fingers circle each other in alternating vertical loops, like two hands signing together. It's the most-used sign in this app — learn it first." },
  { id: "home",           name: "Home",             emoji: "🏠", cat: "Places",     desc: "Flat hand (fingers together, thumb out) touches the lips, then moves to the cheek. Mouth → cheek: where you eat and where you sleep." },
  { id: "school",         name: "School",           emoji: "🏫", cat: "Places",     desc: "Flat hand claps twice against the open palm — the hands clapping for learning. The bottom hand is the blackboard." },
  { id: "bathroom",       name: "Bathroom",         emoji: "🚻", cat: "Places",     desc: "'T' handshape shakes side to side at chest height. Polite, universal, and a classic early-vocabulary sign." },
  { id: "hospital",       name: "Hospital",         emoji: "🏥", cat: "Places",     desc: "'H' handshape traces a cross on the upper arm (the medical cross). Two fingers together = H, not V." },
  { id: "work",           name: "Work",             emoji: "💼", cat: "Places",     desc: "S-hands (fists) tap twice, dominant wrist on top of the non-dominant wrist — hammering at the anvil." },
  { id: "love",           name: "Love",             emoji: "❤️", cat: "Feelings",   desc: "Crossed arms over the chest, fists clenched — hugging yourself. The version with thumbs out means 'I love you'." },
  { id: "happy",          name: "Happy",            emoji: "😊", cat: "Feelings",   desc: "Flat hand brushes up the chest twice, like joy rising. The smile is not decoration — it's part of the sign." },
  { id: "sad",            name: "Sad",              emoji: "😢", cat: "Feelings",   desc: "Both flat hands slide DOWN the face. The downward motion IS the sadness." },
  { id: "tired",          name: "Tired",            emoji: "😴", cat: "Feelings",   desc: "Both hands, palms facing you, droop down from the shoulders like melting candle wax." },
  { id: "sick",           name: "Sick",             emoji: "🤒", cat: "Feelings",   desc: "Middle finger touches the forehead, the other fingers spread to the side — the thermometer reading." },
  { id: "where",          name: "Where?",           emoji: "❓", cat: "Questions",  desc: "Index finger wiggles side to side in neutral space. Eyebrows down (not up!) marks this as a WH-question." },
  { id: "what",           name: "What?",            emoji: "🤔", cat: "Questions",  desc: "Both flat hands wiggle down from the shoulders. Works as 'what' on its own, or as 'what is that?' toward an object." },
  { id: "when",           name: "When?",            emoji: "📅", cat: "Questions",  desc: "Both index fingers circle each other horizontally at chest height, like two clocks turning." },
  { id: "who",            name: "Who?",             emoji: "🫵", cat: "Questions",  desc: "Thumb + index circle (F-handshape) taps the mouth twice — the shape of a mouth saying 'who'." },
  { id: "one",            name: "One",              emoji: "1️⃣", cat: "Numbers",    desc: "Index finger up, palm away. Numbers 1-5 share the same palm orientation — palm IN means a different number system entirely." },
  { id: "two",            name: "Two",              emoji: "2️⃣", cat: "Numbers",    desc: "Index + middle up, palm away. Same handshape as V — context and motion decide which it is." },
  { id: "three",          name: "Three",            emoji: "3️⃣", cat: "Numbers",    desc: "Thumb + index + middle up, palm away. Fingers spread. Keep the ring and pinky tucked." },
  { id: "how-many",       name: "How many?",        emoji: "🔢", cat: "Numbers",    desc: "Both flat hands bounce in the air, palms up, fingers spread — the 'counting question'." },
];

SB.PHRASE_MAP = {};
SB.PHRASES.forEach(function (p) { SB.PHRASE_MAP[p.id] = p; });

/* ---------- Confusion maps for the simulated recognizer ----------
   These are REAL, documented confusions in ASL recognition and in
   human learning — the UI deliberately shows near-misses because
   a wrong guess with a good hint is the strongest teaching moment. */
SB.CONFUSIONS = {
  A: ["S", "T"], B: ["4"], C: ["O"], D: ["F"], E: ["O", "S"], F: ["D", "T"],
  G: ["Q"], H: ["U"], I: ["J", "1"], J: ["I", "Z"], K: ["P"], L: ["7"],
  M: ["N", "T"], N: ["M"], O: ["C", "E"], P: ["K"], Q: ["G"], R: ["U"],
  S: ["A", "T"], T: ["S", "A"], U: ["H", "V"], V: ["U", "2"], W: ["3"],
  X: ["1", "I"], Y: ["8"], Z: ["J"],
  "1": ["I", "X"], "2": ["V"], "3": ["W"], "4": ["B"], "7": ["L"], "8": ["Y"],
  hello: ["hi", "hey"], "thank-you": ["thanks"], "nice-to-meet": ["meet", "hello"],
  "how-are-you": ["hello", "how"], please: ["more", "thank-you"], sorry: ["excuse-me"],
  "sign-language": ["deaf", "learn"], understand: ["don't-understand"], more: ["please"],
  deaf: ["sign-language", "hear"], love: ["i-love-you"], water: ["drink"],
  food: ["eat"], hungry: ["food"], home: ["school"], family: ["friend"],
};

/* ---------- Minimal pairs cheat sheet ---------- */
SB.MINIP_AIRS = [
  { letters: "A · S · T", diff: "Only the thumb moves — alongside, over the fingers, or between index and middle. The classic first trap." },
  { letters: "M · N",     diff: "Which fingers fold over the thumb? Three = M, two = N. Count them deliberately." },
  { letters: "U · V",     diff: "Identical except ONE gap — V spreads the two fingers, U keeps them glued." },
  { letters: "H · U",     diff: "Same two fingers; the difference is orientation and which way they point." },
  { letters: "K · P",     diff: "Same handshape; P points the fingertips DOWN at the floor." },
  { letters: "G · Q",     diff: "Same handshape; Q aims the fingertips at the floor." },
  { letters: "D · F",     diff: "Where does the thumb touch? D: thumb on the middle finger. F: thumb pinches the index." },
  { letters: "E · O",     diff: "O makes a tight ring of fingertips; E tucks the fingers flat against the palm." },
  { letters: "I · J",     diff: "J is I plus a movement — the hook the pinky draws. Movement is a full parameter of meaning." },
  { letters: "W · 3",     diff: "Thumb tucked (W) vs thumb out (3). The thumb is the difference between a letter and a number." },
  { letters: "C · O",     diff: "C is an open cup; O closes to a ring. Watch how far the fingers travel." },
  { letters: "B · 4",     diff: "Fingers glued (B) vs fingers spread (4)." },
];

/* ---------- Demo sentence (Watch demo) ---------- */
SB.DEMO_SENTENCE = [
  { text: "Hello" },
  { text: "thank", conf: 0.92 },
  { text: "you", conf: 0.96 },
  { text: "for", conf: 0.88 },
  { text: "watching", conf: 0.64, alt: ["waving", "waiting"] },   // deliberately low — shows the alternates UI
  { text: "my", conf: 0.97 },
  { text: "name", conf: 0.91, alt: ["same"] },                    // classic N/M-adjacent confusion
  { text: "is", conf: 0.98 },
  { text: "SignBridge", conf: 0.76, alt: ["SignBreak", "SignBridge!"], glyph: "🤟" },
  { text: "I", conf: 0.99 },
  { text: "am", conf: 0.98 },
  { text: "learning", conf: 0.83, alt: ["teaching", "signing"] },
  { text: "American", conf: 0.9, alt: ["America"] },
  { text: "Sign", conf: 0.94 },
  { text: "Language", conf: 0.89 },
  { text: "Nice", conf: 0.93 },
  { text: "to", conf: 0.97 },
  { text: "meet", conf: 0.72, alt: ["greet", "meat"] },
  { text: "you", conf: 0.99 },
];

/* ---------- Quick phrases on the Translate page (1–9 hotkeys) ---------- */
SB.QUICK_PHRASES = [
  { id: "hello",        emoji: "👋" },
  { id: "thank-you",    emoji: "🙏" },
  { id: "please",       emoji: "🥺" },
  { id: "sorry",        emoji: "😔" },
  { id: "yes",          emoji: "✅" },
  { id: "no",           emoji: "❌" },
  { id: "help",         emoji: "🆘" },
  { id: "how-are-you",  emoji: "💬" },
  { id: "nice-to-meet", emoji: "🤝" },
];

/* ---------- Etiquette: how to communicate with Deaf / hard-of-hearing people ---------- */
SB.ETIQUETTE = [
  { title: "Get attention the right way", text: "Wave within their line of sight, or tap gently on the shoulder. Never grab hands or wave directly in the face." },
  { title: "Eye contact is the conversation", text: "In sign language, looking away mid-sign is like hanging up the phone. Hold eye contact — it's not a stare." },
  { title: "Keep your hands visible", text: "Sign in the 'signing space' — roughly from your waist to your forehead, elbows loose. Don't cover your mouth; many people lip-read alongside signing." },
  { title: "Facial expressions are grammar", text: "Eyebrows raised can turn a statement into a question; a headshake means 'no'. Your face is not decoration — it carries syntax." },
  { title: "One signer at a time", text: "Hands are how people 'talk'. Interrupting a signer is like talking over someone — wait your turn." },
  { title: "Don't shout", text: "Volume doesn't help and distorts lip-reading. Speak normally if speaking, or just sign." },
  { title: "Fingerspell slowly, not perfectly", text: "Clarity beats speed every time. If you're stuck, write it down or type it — communication first, form second." },
  { title: "There is no 'sign for every word'", text: "ASL has its own grammar and word order. When you can't find a sign, fingerspell or describe the idea — that's what native signers do." },
];

/* ---------- ASL facts ---------- */
SB.ASL_FACTS = [
  { ico: "🗣️", text: "<strong>ASL is not English on the hands.</strong> It has its own grammar, word order (often topic-first), and no one-to-one match with English words. That's why the translator can't just 'spell everything'." },
  { ico: "🌎", text: "<strong>There are hundreds of sign languages.</strong> ASL, BSL, FSL, JSL… a Deaf person from London and one from Chicago don't share a language. This app targets ASL first." },
  { ico: "✍️", text: "<strong>Fingerspelling is for names, places, and new words</strong> — not everyday conversation. It's the tool you use when there's no sign yet, or when you're introducing yourself." },
  { ico: "🏠", text: "<strong>Most Deaf children are born to hearing parents</strong> — which is exactly why student-built tools like this one matter: the learning gap is real, and bridging it changes lives." },
];
