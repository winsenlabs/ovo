// Vendored input fixture for scripts/flow-import: credit3-collections-poc lib/flow.js as of
// 2026-09-30 (sha256 a2aaf4dc15227f64e2367ab13395cb106a06657bbdb0e86f94327b0c8fb1330a), formatted
// by prettier and otherwise unchanged. Edit the POC, not this copy, then re-vendor and re-import.
// The conversation graph.
//
// CLIPS    every line the agent can say. A clip whose template uses a per-call
//          variable ({full_name}, {emi_words}, ...) is VARIABLE: rendered once per
//          call, before the call connects. Every other clip is GENERIC: rendered
//          once at server boot and cached on disk. Neither kind is synthesized
//          while the caller waits; only LLM-fallback replies are.
// NODES    what the agent does on entering a state: clips to play, side effects,
//          and which LISTEN set interprets the caller's next reply.
// LISTENS  the intents a reply can map to at that point, each with the
//          description Jev sees, optional instant rules, and the next node.

export const CONFIG_VARS = ['agent', 'helpline'];

export const CLIPS = {
  intro: "Hello, I'm calling from CreditMantri. My name is {agent}.",
  ask_identity: 'Am I speaking with {full_name}?',
  reassure:
    "I'm calling from CreditMantri about an account-related matter. For privacy, I can only discuss it with {full_name}. Is that you?",
  recording: 'Thank you. Please note that this call is recorded for quality purposes.',
  emi_status:
    "I'm calling about your {loan_type} ending {last4_spoken}. Your EMI of {emi_words}, due on {due_date_words}, could not be collected because {reason}.",
  charges: '{charge_sentence}',
  ask_when: 'When would you be able to make this payment?',
  pay_now_1:
    "Perfect. I'm sending a secure payment link to your registered mobile number right now.",
  pay_now_2: "It should arrive in a few seconds. Could you let me know once you've received it?",
  resend:
    "I've sent it again. The message comes from CreditMantri. You can also pay in the CreditMantri app, under Pay EMI.",
  pay_close:
    'Thank you, {first_name}. Once you pay {total_words}, it will reflect in your account within two hours.',
  ptp_today: "Thank you. I've noted that you'll make the payment today, {date_today}.",
  ptp_tomorrow: "Thank you. I've noted that you'll make the payment tomorrow, {date_tomorrow}.",
  ptp_3days: "Thank you. I've noted that you'll make the payment by {date_3days}.",
  ptp_week: "Thank you. I've noted that you'll make the payment by {date_week}.",
  ptp_later:
    'I understand. To avoid further charges, the latest date I can note is {date_week}. Would that work for you?',
  ptp_unspecified: "Could you tell me a specific date by which you'll be able to pay?",
  ptp_sms: "I'll also send you the payment link by SMS, so it's handy when you're ready.",
  already_paid_1:
    'Thank you for letting me know. Payments can take up to forty-eight hours to reflect. Could you tell me the date you paid?',
  already_paid_2:
    "Thank you. I've raised a verification request. Once it's confirmed, you can ignore any reminders.",
  hardship:
    "I understand, and I'm sorry to hear that. I can send you a link to pay part of the amount now, or I can arrange a call from our customer relief team to discuss a revised plan. Which would you prefer?",
  partial_link:
    "Sure. I'm sending the link now. You can enter any amount you're comfortable with, and it will be adjusted against your EMI.",
  relief:
    "Done. Our customer relief team will call you within twenty-four hours, and you won't receive reminder calls until then.",
  dispute:
    "I'm sorry for the trouble. I've raised a review request for this payment. Our team will contact you within forty-eight hours.",
  waiver:
    "I'm not able to waive the charge on this call, but I've flagged your request to our team. If it's approved, it will be adjusted in your next statement.",
  mandate_fix:
    "I'm sending you a link to set up auto-debit on your active bank account. It takes about two minutes, and your future EMIs will go through automatically.",
  busy: 'No problem. When would be a good time to call you back?',
  cb_evening: "Sure, I'll call you back this evening. Thank you, and have a good day.",
  cb_tomorrow_morning: "Sure, I'll call you back tomorrow morning. Thank you, and have a good day.",
  cb_tomorrow_evening: "Sure, I'll call you back tomorrow evening. Thank you, and have a good day.",
  cb_generic: "Sure, I'll call you back at a better time. Thank you, and have a good day.",
  wrong_person: "I'm sorry for the trouble. Do you happen to know {full_name}?",
  wp_knows:
    'Could you please ask them to call CreditMantri on {helpline}? Thank you, and sorry for the disturbance.',
  wp_unknown: "My apologies for the disturbance. We'll update our records. Have a good day.",
  third_party:
    'No problem. Could you please ask {first_name} to call CreditMantri back on {helpline}? Thank you, and have a good day.',
  anything_else: 'Is there anything else I can help you with?',
  goodbye: 'Thank you for your time. Have a good day!',
  human: "Sure, I'm transferring you to a CreditMantri representative. Please hold.",
  stop_calling:
    "Understood. I've noted your request. You can reach us anytime on {helpline}. Goodbye.",
  abusive:
    "I understand you're upset. I'll end the call here. You can reach us on {helpline}. Goodbye.",
  repeat_prefix: 'Sure, let me repeat that.',
  no_input: 'Hello? Can you hear me?',
  no_input_end: "I'm unable to hear you, so I'll call back later. Goodbye.",
  didnt_catch: "Sorry, I didn't quite catch that. Could you say that again?",
  filler_1: 'Okay, one moment.',
  filler_2: 'Sure, let me check that.',
  filler_3: 'Right, give me a second.',
};

// Tamil: polite spoken Tamil, mixing in the English banking words people use on
// these calls in Tamil Nadu (EMI, loan, payment link, auto-debit). Amounts and
// dates are read in English, which is how they are usually said.
export const CLIPS_TA = {
  intro: 'வணக்கம், நான் கிரெடிட் மந்த்ரியிலிருந்து பேசுகிறேன். என் பெயர் {agent}.',
  ask_identity: '{full_name} அவர்களிடம் தான் பேசுகிறேனா?',
  reassure:
    'நான் கிரெடிட் மந்த்ரியிலிருந்து ஒரு account சம்பந்தமான விஷயமாக பேசுகிறேன். Privacy காரணமாக, இதை {full_name} அவர்களிடம் மட்டுமே பேச முடியும். நீங்கள் தானா?',
  recording: 'நன்றி. இந்த அழைப்பு தரத்திற்காக பதிவு செய்யப்படுகிறது.',
  emi_status:
    'உங்கள் {loan_type} பற்றி பேசுகிறேன், கடைசி நான்கு எண்கள் {last4_spoken}. {due_date_words} அன்று செலுத்த வேண்டிய {emi_words} EMI வசூலிக்க முடியவில்லை, ஏனெனில் {reason}.',
  charges: '{charge_sentence}',
  ask_when: 'இந்த payment-ஐ எப்போது செய்ய முடியும்?',
  pay_now_1:
    'நல்லது. உங்கள் registered mobile number-க்கு ஒரு secure payment link இப்போதே அனுப்புகிறேன்.',
  pay_now_2: 'சில வினாடிகளில் வந்துவிடும். வந்ததும் எனக்கு சொல்ல முடியுமா?',
  resend:
    'மறுபடியும் அனுப்பியிருக்கிறேன். அது கிரெடிட் மந்த்ரி பெயரில் வரும். கிரெடிட் மந்த்ரி app-இல் Pay EMI பகுதியிலும் செலுத்தலாம்.',
  pay_close:
    'நன்றி {first_name}. {total_words} செலுத்தியதும், இரண்டு மணி நேரத்திற்குள் உங்கள் account-இல் update ஆகிவிடும்.',
  ptp_today: 'நன்றி. இன்று, {date_today}, payment செய்வீர்கள் என்று குறித்துக்கொண்டேன்.',
  ptp_tomorrow: 'நன்றி. நாளை, {date_tomorrow}, payment செய்வீர்கள் என்று குறித்துக்கொண்டேன்.',
  ptp_3days: 'நன்றி. {date_3days} க்குள் payment செய்வீர்கள் என்று குறித்துக்கொண்டேன்.',
  ptp_week: 'நன்றி. {date_week} க்குள் payment செய்வீர்கள் என்று குறித்துக்கொண்டேன்.',
  ptp_later:
    'புரிகிறது. கூடுதல் கட்டணத்தை தவிர்க்க, நான் குறிக்கக்கூடிய கடைசி தேதி {date_week}. அது உங்களுக்கு சரியாக இருக்குமா?',
  ptp_unspecified: 'எந்த தேதிக்குள் செலுத்த முடியும் என்று ஒரு குறிப்பிட்ட தேதி சொல்ல முடியுமா?',
  ptp_sms: 'உங்கள் வசதிக்காக, payment link-ஐ SMS-இலும் அனுப்புகிறேன்.',
  already_paid_1:
    'சொன்னதற்கு நன்றி. Payment update ஆக நாற்பத்தெட்டு மணி நேரம் வரை ஆகலாம். எந்த தேதியில் செலுத்தினீர்கள் என்று சொல்ல முடியுமா?',
  already_paid_2:
    'நன்றி. Verification request பதிவு செய்துவிட்டேன். உறுதியானதும், reminders-ஐ நீங்கள் பொருட்படுத்த வேண்டாம்.',
  hardship:
    'புரிகிறது, அதற்கு வருந்துகிறேன். இப்போது ஒரு பகுதித் தொகையை செலுத்த link அனுப்பலாம், அல்லது புதிய திட்டம் பற்றி பேச எங்கள் customer relief team-இடமிருந்து call ஏற்பாடு செய்யலாம். உங்களுக்கு எது வசதி?',
  partial_link:
    'சரி. இப்போதே link அனுப்புகிறேன். உங்களுக்கு வசதியான எந்தத் தொகையையும் செலுத்தலாம், அது உங்கள் EMI-இல் சரிசெய்யப்படும்.',
  relief:
    'முடிந்தது. எங்கள் customer relief team இருபத்து நான்கு மணி நேரத்திற்குள் உங்களை அழைப்பார்கள், அதுவரை reminder calls வராது.',
  dispute:
    'சிரமத்திற்கு வருந்துகிறேன். இந்த payment-க்கு review request பதிவு செய்துவிட்டேன். நாற்பத்தெட்டு மணி நேரத்திற்குள் எங்கள் team உங்களை தொடர்புகொள்ளும்.',
  waiver:
    'இந்த call-இல் charge-ஐ தள்ளுபடி செய்ய என்னால் முடியாது, ஆனால் உங்கள் கோரிக்கையை எங்கள் team-க்கு அனுப்பியிருக்கிறேன். Approve ஆனால், அடுத்த statement-இல் சரிசெய்யப்படும்.',
  mandate_fix:
    'உங்கள் active bank account-இல் auto-debit அமைக்க ஒரு link அனுப்புகிறேன். இரண்டு நிமிடம் தான் ஆகும், அதன் பிறகு உங்கள் EMI-கள் தானாகவே செலுத்தப்படும்.',
  busy: 'பரவாயில்லை. எப்போது மறுபடியும் அழைக்கலாம்?',
  cb_evening: 'சரி, இன்று மாலை மறுபடியும் அழைக்கிறேன். நன்றி, நல்ல நாளாக அமையட்டும்.',
  cb_tomorrow_morning: 'சரி, நாளை காலை மறுபடியும் அழைக்கிறேன். நன்றி, நல்ல நாளாக அமையட்டும்.',
  cb_tomorrow_evening: 'சரி, நாளை மாலை மறுபடியும் அழைக்கிறேன். நன்றி, நல்ல நாளாக அமையட்டும்.',
  cb_generic:
    'சரி, உங்களுக்கு வசதியான நேரத்தில் மறுபடியும் அழைக்கிறேன். நன்றி, நல்ல நாளாக அமையட்டும்.',
  wrong_person: 'சிரமத்திற்கு மன்னிக்கவும். உங்களுக்கு {full_name} அவர்களைத் தெரியுமா?',
  wp_knows:
    'அவர்களை கிரெடிட் மந்த்ரியை {helpline} என்ற எண்ணில் அழைக்கச் சொல்ல முடியுமா? நன்றி, தொந்தரவுக்கு மன்னிக்கவும்.',
  wp_unknown:
    'தொந்தரவுக்கு மன்னிக்கவும். எங்கள் பதிவுகளை update செய்கிறோம். நல்ல நாளாக அமையட்டும்.',
  third_party:
    'பரவாயில்லை. {first_name} அவர்களை கிரெடிட் மந்த்ரியை {helpline} என்ற எண்ணில் திரும்ப அழைக்கச் சொல்ல முடியுமா? நன்றி, நல்ல நாளாக அமையட்டும்.',
  anything_else: 'வேறு ஏதாவது உதவி வேண்டுமா?',
  goodbye: 'உங்கள் நேரத்திற்கு நன்றி. நல்ல நாளாக அமையட்டும்!',
  human:
    'சரி, உங்களை ஒரு கிரெடிட் மந்த்ரி representative-இடம் இணைக்கிறேன். தயவுசெய்து காத்திருங்கள்.',
  stop_calling:
    'புரிகிறது. உங்கள் கோரிக்கையை குறித்துக்கொண்டேன். எப்போது வேண்டுமானாலும் {helpline} என்ற எண்ணில் எங்களை தொடர்புகொள்ளலாம். வணக்கம்.',
  abusive:
    'நீங்கள் வருத்தத்தில் இருக்கிறீர்கள் என்று புரிகிறது. இந்த call-ஐ இங்கே முடிக்கிறேன். {helpline} என்ற எண்ணில் எங்களை தொடர்புகொள்ளலாம். வணக்கம்.',
  repeat_prefix: 'சரி, மறுபடியும் சொல்கிறேன்.',
  no_input: 'ஹலோ? நான் பேசுவது கேட்கிறதா?',
  no_input_end: 'உங்கள் குரல் கேட்கவில்லை, பிறகு அழைக்கிறேன். வணக்கம்.',
  didnt_catch: 'மன்னிக்கவும், சரியாக கேட்கவில்லை. மறுபடியும் சொல்ல முடியுமா?',
  filler_1: 'சரி, ஒரு நிமிடம்.',
  filler_2: 'சரி, பார்க்கிறேன்.',
  filler_3: 'ஒரு வினாடி.',
};

export const CLIP_SETS = { en: CLIPS, ta: CLIPS_TA };
export const LANGS = ['en', 'ta'];

export const FILLERS = ['filler_1', 'filler_2', 'filler_3'];

const templateVars = (t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
// Classification uses the English template; every language uses the same variables per clip.
export const isVariableClip = (id) => templateVars(CLIPS[id]).some((v) => !CONFIG_VARS.includes(v));
export const fillTemplate = (t, vars) =>
  t.replace(/\{(\w+)\}/g, (_, k) => {
    if (vars[k] === undefined) throw new Error(`missing template var: ${k}`);
    return vars[k];
  });

export const NODES = {
  greet: { say: ['intro', 'ask_identity'], listen: 'identity' },
  reassure: { say: ['reassure'], listen: 'identity' },
  disclose: {
    say: ['recording', 'emi_status', 'charges', 'ask_when'],
    listen: 'payment',
    verified: true,
  },
  pay_now: { say: ['pay_now_1', 'pay_now_2'], sms: 'full', listen: 'link_check' },
  resend: { say: ['resend'], sms: 'full', listen: 'link_check' },
  pay_close: { say: ['pay_close', 'anything_else'], listen: 'wrapup' },
  ptp_today: {
    say: ['ptp_today', 'ptp_sms', 'anything_else'],
    sms: 'full',
    log: 'promise_to_pay:today',
    listen: 'wrapup',
  },
  ptp_tomorrow: {
    say: ['ptp_tomorrow', 'ptp_sms', 'anything_else'],
    sms: 'full',
    log: 'promise_to_pay:tomorrow',
    listen: 'wrapup',
  },
  ptp_3days: {
    say: ['ptp_3days', 'ptp_sms', 'anything_else'],
    sms: 'full',
    log: 'promise_to_pay:3_days',
    listen: 'wrapup',
  },
  ptp_week: {
    say: ['ptp_week', 'ptp_sms', 'anything_else'],
    sms: 'full',
    log: 'promise_to_pay:7_days',
    listen: 'wrapup',
  },
  ptp_later: { say: ['ptp_later'], listen: 'confirm_week' },
  ptp_ask: { say: ['ptp_unspecified'], listen: 'payment' },
  already_paid: { say: ['already_paid_1'], listen: 'paid_date' },
  ap_done: {
    say: ['already_paid_2', 'anything_else'],
    log: 'payment_verification_requested',
    listen: 'wrapup',
  },
  hardship: { say: ['hardship'], listen: 'hardship_choice' },
  partial: { say: ['partial_link', 'anything_else'], sms: 'partial', listen: 'wrapup' },
  relief: { say: ['relief', 'anything_else'], log: 'relief_team_callback', listen: 'wrapup' },
  dispute: { say: ['dispute', 'anything_else'], log: 'dispute_raised', listen: 'wrapup' },
  waiver: { say: ['waiver', 'ask_when'], log: 'waiver_requested', listen: 'payment' },
  mandate_fix: { say: ['mandate_fix', 'ask_when'], sms: 'mandate', listen: 'payment' },
  busy: { say: ['busy'], listen: 'callback' },
  cb_evening: { say: ['cb_evening'], log: 'callback:this_evening', end: true },
  cb_tomorrow_morning: {
    say: ['cb_tomorrow_morning'],
    log: 'callback:tomorrow_morning',
    end: true,
  },
  cb_tomorrow_evening: {
    say: ['cb_tomorrow_evening'],
    log: 'callback:tomorrow_evening',
    end: true,
  },
  cb_generic: { say: ['cb_generic'], log: 'callback:unspecified', end: true },
  wrong_person: { say: ['wrong_person'], listen: 'knows' },
  wp_knows: { say: ['wp_knows'], log: 'wrong_party:knows_customer', end: true },
  wp_unknown: { say: ['wp_unknown'], log: 'wrong_number', end: true },
  third_party: { say: ['third_party'], log: 'third_party_message_left', end: true },
  goodbye: { say: ['goodbye'], end: true },
  human: { say: ['human'], log: 'transfer_to_human', end: true },
  stop_calling: { say: ['stop_calling'], log: 'do_not_call_requested', end: true },
  abusive: { say: ['abusive'], log: 'abusive_caller', end: true },
  no_input_end: { say: ['no_input_end'], log: 'no_response', end: true },
};

// Whole-utterance rules: the zero-latency tier. Deliberately narrow; anything
// with a qualifier ("yes but not now") falls through to Jev.
const YES =
  /^(yes|yeah|yep|yup|ya|haan|han|ha|haan ji|ji|ji haan|haa|sure|correct|right|ok|okay|yes please|yes sure|हाँ|हां|हा|जी|जी हाँ|जी हां|हाँ जी|हां जी|aama|aamaa|aamam|amam|aamanga|sari|seri|saringa|ஆமா|ஆமாம்|ஆம்|ஆமாங்க|சரி|சரிங்க)( (ji|please|speaking|जी|ங்க|sir|madam))?$/u;
const NO =
  /^(no|nope|nahi|nahin|na|no thanks|no thank you|nothing|nothing else|thats all|thats it|no thats all|no thats it|nahi ji|no ji|नहीं|नही|ना|नहीं जी|illa|illai|illainga|venam|vendam|podhum|pothum|இல்லை|இல்ல|இல்லைங்க|வேண்டாம்|வேணாம்|போதும்|நன்றி)$/u;
const SPEAKING =
  /^((yes|haan|haan ji|ji) )?(speaking|this is (he|she|him|her|me)|(he|she) speaking|thats me|its me|bol raha hoon|bol rahi hoon|naan dhaan|naan thaan|naan than|pesuren|நான் தான்|நான்தான்|பேசுறேன்|நான் தான் பேசுறேன்)$/u;

export const GLOBAL_INTENTS = {
  repeat: {
    desc: 'They did not hear or understand and want the agent to repeat what it just said',
    rule: /^(sorry|pardon|what|come again|repeat|repeat that|can you repeat|can you repeat that|say that again|kya|sorry what|excuse me)$/,
  },
  human_agent: { desc: 'They ask to speak to a human, a manager, or a real person', next: 'human' },
  stop_calling: {
    desc: 'They ask CreditMantri to stop calling them or to not call again',
    next: 'stop_calling',
  },
  abusive: {
    desc: 'They are abusive, threatening, or using profanity at the agent',
    next: 'abusive',
  },
};

export const LISTENS = {
  identity: {
    question:
      'The agent asked to confirm the identity of the person who picked up the phone. How did they respond in `caller_reply`?',
    intents: {
      confirmed: {
        desc: 'They confirm they are the named person (yes, speaking, haan)',
        rule: [YES, SPEAKING],
        next: 'disclose',
      },
      wrong_person: {
        desc: 'They say it is a wrong number or that they are not the person and do not know them',
        rule: /^(no )?(wrong number|you have the wrong number)$/,
        next: 'wrong_person',
      },
      third_party: {
        desc: 'Someone else who knows the named person answered (family, colleague); the person is not available',
        next: 'third_party',
      },
      busy: { desc: 'They are the named person but are busy and ask to talk later', next: 'busy' },
      asks_purpose: {
        desc: 'They ask who is calling or why before confirming who they are',
        next: 'reassure',
      },
    },
  },
  payment: {
    question:
      'The agent told the customer their EMI payment failed and asked when they can pay. What does `caller_reply` express?',
    intents: {
      pay_now: {
        desc: 'They want to pay right now or today on this call, or ask for the payment link now',
        next: 'pay_now',
      },
      promise_to_pay: {
        desc: 'They commit to paying later, with or without a specific date or day',
        next: (slots) =>
          ({
            today: 'ptp_today',
            tomorrow: 'ptp_tomorrow',
            within_3_days: 'ptp_3days',
            within_week: 'ptp_week',
            later: 'ptp_later',
          })[slots.ptp_when] || 'ptp_ask',
      },
      already_paid: { desc: 'They say they have already paid this EMI', next: 'already_paid' },
      cannot_pay: {
        desc: 'They say they cannot pay because of money problems, job loss, medical or other hardship',
        next: 'hardship',
      },
      dispute: {
        desc: "They dispute the amount or the bounce, or say it is the bank's or lender's mistake",
        next: 'dispute',
      },
      waiver_request: {
        desc: 'They ask for the bounce charge or late fee to be removed or waived',
        next: 'waiver',
      },
      mandate_help: {
        desc: 'They say their bank account or auto-debit changed and ask how to update or fix the auto-debit mandate',
        next: 'mandate_fix',
      },
      busy: { desc: 'They are busy and ask to talk later', next: 'busy' },
    },
    slots: {
      ptp_when: {
        question:
          'If the caller in `caller_reply` commits to paying, by when do they say they will pay? Today is given in `today`.',
        options: {
          today: 'Today, later today, tonight, or right after this call',
          tomorrow: 'Tomorrow',
          within_3_days: 'Within the next two or three days, or by a date up to three days away',
          within_week:
            'Within a week: this week, by the weekend, or a date four to seven days away',
          later: 'More than a week away: next month, after salary, or a date over seven days away',
          unspecified: 'No time given, or it is unclear when',
        },
      },
    },
  },
  link_check: {
    question:
      'The agent sent a payment link by SMS and asked the customer to confirm when it arrives. What does `caller_reply` say?',
    intents: {
      received: {
        desc: 'They received the link, or have already paid through it',
        rule: [
          YES,
          /^(got it|received|yes got it|yes received|done|i got it|mil gaya|haan mil gaya)$/,
        ],
        next: 'pay_close',
      },
      not_received: {
        desc: 'They have not received the link yet',
        rule: [NO, /^(not yet|not received|didnt get it|havent received|nahi aaya|abhi nahi)$/],
        next: 'resend',
      },
    },
  },
  wrapup: {
    question:
      'The agent asked if there is anything else it can help with. What does `caller_reply` say?',
    intents: {
      no_more: {
        desc: 'Nothing else; they are done, say thanks or bye',
        rule: [
          NO,
          /^(thanks|thank you|bye|ok bye|okay bye|thank you bye|no bye|dhanyavaad|shukriya)$/,
        ],
        next: 'goodbye',
      },
    },
  },
  confirm_week: {
    question:
      'The agent offered the latest payment date it can note and asked if that works. What does `caller_reply` say?',
    intents: {
      yes: { desc: 'They agree to pay by that date', rule: YES, next: 'ptp_week' },
      no: { desc: 'They cannot pay by that date', rule: NO, next: 'hardship' },
    },
  },
  paid_date: {
    question:
      'The customer said they already paid, and the agent asked for the date of payment. What does `caller_reply` say?',
    intents: {
      gave_date: { desc: 'They give a date or day when they paid', next: 'ap_done' },
      doesnt_remember: {
        desc: 'They do not remember the date or will check later',
        next: 'ap_done',
      },
    },
  },
  hardship_choice: {
    question:
      'The agent offered two options: a link to pay part of the amount now, or a call from the customer relief team. Which does `caller_reply` choose?',
    intents: {
      partial: {
        desc: 'They want to pay part of the amount now / the partial payment link',
        next: 'partial',
      },
      relief: {
        desc: 'They want the call from the customer relief team or a revised plan',
        next: 'relief',
      },
    },
  },
  callback: {
    question:
      'The agent asked when would be a good time to call back. When does `caller_reply` want the callback?',
    intents: {
      this_evening: { desc: 'Later today or this evening', next: 'cb_evening' },
      tomorrow_morning: { desc: 'Tomorrow morning', next: 'cb_tomorrow_morning' },
      tomorrow_evening: { desc: 'Tomorrow afternoon or evening', next: 'cb_tomorrow_evening' },
      other_time: { desc: 'Some other specific or vague time', next: 'cb_generic' },
    },
  },
  knows: {
    question:
      'The person who answered is not the customer. The agent asked if they know the customer. What does `caller_reply` say?',
    intents: {
      yes: { desc: 'Yes, they know the person', rule: YES, next: 'wp_knows' },
      no: { desc: 'No, they do not know the person', rule: NO, next: 'wp_unknown' },
    },
  },
};

export const OTHER_DESC =
  'None of the above fits: a question, a new topic, or anything the listed options do not cover';

export const normalize = (t) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

export function ruleMatch(listenId, text) {
  const n = normalize(text);
  const test = (r) => (Array.isArray(r) ? r : [r]).some((re) => re.test(n));
  for (const [intent, def] of Object.entries(LISTENS[listenId].intents)) {
    if (def.rule && test(def.rule)) return intent;
  }
  for (const [intent, def] of Object.entries(GLOBAL_INTENTS)) {
    if (def.rule && test(def.rule)) return intent;
  }
  return null;
}

// Map an intent (plus any slot answers) to the next node. `repeat` is handled
// by the caller since it replays rather than advances.
export function nextNode(listenId, intent, slots = {}) {
  const def = LISTENS[listenId].intents[intent] || GLOBAL_INTENTS[intent];
  if (!def || !def.next) return null;
  return typeof def.next === 'function' ? def.next(slots) : def.next;
}

export function allNextNodes(def) {
  if (typeof def.next !== 'function') return def.next ? [def.next] : [];
  const slotKeys = Object.keys(LISTENS.payment.slots.ptp_when.options);
  return [...new Set(slotKeys.map((k) => def.next({ ptp_when: k })))];
}
