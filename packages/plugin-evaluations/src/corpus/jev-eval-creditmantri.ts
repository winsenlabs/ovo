import { readFileSync } from 'node:fs';
import type { AgentFlow } from '../jev-eval-flow.ts';
import type { JevEvalCase, JevEvalLanguage, JevEvalSet } from '../jev-eval.ts';

/**
 * Labelled caller replies for the CreditMantri collections flow, per listen set, in English, Indian
 * English and Hinglish, with the awkward ones a phone line produces: one-word replies, recognition
 * errors, backchannels, and replies that say yes and then something else.
 *
 * Labels are what a careful human agent would route to, not what the POC's rules happen to do:
 * where the two disagree ("ok" after "tell me once the link arrives" is not "received") the eval
 * reports the rule tier's misroute, which is the point of having it.
 */

type Row = [
  text: string,
  expected: string,
  language: JevEvalLanguage,
  tags?: string,
  slot?: string,
];

const listen = (name: string, rows: Row[], node?: string): JevEvalCase[] =>
  rows.map(([text, expected, language, tags = '', slot], index) => ({
    id: `${name}-${String(index + 1).padStart(2, '0')}`,
    listen: name,
    ...(node ? { node } : {}),
    text,
    expected,
    language,
    tags: tags.split(' ').filter(Boolean),
    ...(slot ? { slots: { ptp_when: slot } } : {}),
  }));

const identity = listen('identity', [
  ['yes', 'confirmed', 'en', 'short'],
  ['Yes, this is Rahul.', 'confirmed', 'en'],
  ['speaking', 'confirmed', 'en', 'short'],
  ["Yeah that's me, tell me.", 'confirmed', 'en'],
  ['Yes, Rahul only speaking.', 'confirmed', 'en-IN'],
  ['haan ji bol raha hoon', 'confirmed', 'hinglish'],
  ['Haan, main hi hoon.', 'confirmed', 'hinglish'],
  ['yes speak in', 'confirmed', 'en', 'noisy'],
  ['wrong number', 'wrong_person', 'en', 'short'],
  ['No, there is no Rahul here.', 'wrong_person', 'en'],
  ['I think you have dialled the wrong number.', 'wrong_person', 'en-IN'],
  ['Galat number hai.', 'wrong_person', 'hinglish'],
  ['rong number', 'wrong_person', 'en', 'noisy short'],
  ['He is not at home, I am his wife.', 'third_party', 'en'],
  ["Rahul is my son, he's gone to office.", 'third_party', 'en-IN'],
  ['Woh ghar pe nahi hai, main unki behen bol rahi hoon.', 'third_party', 'hinglish'],
  ["Yes but I'm driving right now, call me later.", 'busy', 'en', 'qualified'],
  ['Haan, but I am in a meeting, call after some time.', 'busy', 'en-IN', 'qualified'],
  ['Abhi busy hoon, baad mein call karo.', 'busy', 'hinglish'],
  ['Who is this?', 'asks_purpose', 'en'],
  ['What is this regarding?', 'asks_purpose', 'en'],
  ['Kaun bol raha hai?', 'asks_purpose', 'hinglish'],
  ['who is dis', 'asks_purpose', 'en', 'noisy short'],
  ['Sorry?', 'repeat', 'en', 'short'],
  ['can you repeat that', 'repeat', 'en'],
  ['kya?', 'repeat', 'hinglish', 'short'],
  ["I didn't hear you properly, say again.", 'repeat', 'en-IN'],
  ['I want to talk to a real person.', 'human_agent', 'en'],
  ["Stop calling me, don't call this number again.", 'stop_calling', 'en'],
  ['Shut up, you idiot.', 'abusive', 'en'],
  ['hmm', 'other', 'en', 'backchannel short'],
  ['Is this about the Diwali offer?', 'other', 'en-IN'],
]);

const payment = listen('payment', [
  ["I'll pay right now, send me the link.", 'pay_now', 'en'],
  ['Kindly send the payment link, I will do it now itself.', 'pay_now', 'en-IN'],
  ['Abhi kar deta hoon, link bhejo.', 'pay_now', 'hinglish'],
  ["I'll pay tomorrow.", 'promise_to_pay', 'en', 'slot', 'tomorrow'],
  ["I'll pay to morrow", 'promise_to_pay', 'en', 'slot noisy', 'tomorrow'],
  ['Kal tak kar dunga.', 'promise_to_pay', 'hinglish', 'slot', 'tomorrow'],
  ["I'll pay tonight after I get home.", 'promise_to_pay', 'en', 'slot', 'today'],
  ['I can pay by Friday.', 'promise_to_pay', 'en', 'slot', 'within_3_days'],
  ['Do teen din mein kar dunga.', 'promise_to_pay', 'hinglish', 'slot', 'within_3_days'],
  ['I will pay within this week.', 'promise_to_pay', 'en-IN', 'slot', 'within_week'],
  ['Salary comes on the first, I will pay after that.', 'promise_to_pay', 'en-IN', 'slot', 'later'],
  ['Agle mahine pakka.', 'promise_to_pay', 'hinglish', 'slot', 'later'],
  ['I will pay, just give me some time.', 'promise_to_pay', 'en-IN', 'slot', 'unspecified'],
  ['I already paid it yesterday.', 'already_paid', 'en'],
  ['Paid through UPI last week only.', 'already_paid', 'en-IN'],
  ['Maine already payment kar diya hai.', 'already_paid', 'hinglish'],
  ["I lost my job, I can't pay right now.", 'cannot_pay', 'en'],
  ['There is a medical emergency at home, no money.', 'cannot_pay', 'en-IN'],
  ['Paise nahi hai abhi.', 'cannot_pay', 'hinglish'],
  ['This is the bank mistake, I had balance in my account.', 'dispute', 'en-IN'],
  ['The amount is wrong, my EMI is not this much.', 'dispute', 'en'],
  ['Please remove the bounce charge.', 'waiver_request', 'en'],
  ['Can you waive the late fee?', 'waiver_request', 'en'],
  ['Charges hata do please.', 'waiver_request', 'hinglish'],
  ['I changed my bank account, how do I update the auto debit?', 'mandate_help', 'en'],
  ['My old account is closed, NACH has to be changed.', 'mandate_help', 'en-IN'],
  ["I'm busy now, call me later.", 'busy', 'en'],
  ['Let me talk to your manager.', 'human_agent', 'en'],
  ['Stop calling me every day.', 'stop_calling', 'en'],
  ['What is my total outstanding?', 'other', 'en', 'question'],
  ['ok', 'other', 'en', 'backchannel short'],
  ['hmm hmm', 'other', 'en', 'backchannel short'],
]);

const linkCheck = listen('link_check', [
  ['yes', 'received', 'en', 'short'],
  ['got it', 'received', 'en', 'short'],
  ['Yes, I got the message.', 'received', 'en'],
  ['Haan aa gaya.', 'received', 'hinglish', 'short'],
  ['mil gaya', 'received', 'hinglish', 'short'],
  ['not yet', 'not_received', 'en', 'short'],
  ['No message has come.', 'not_received', 'en-IN'],
  ['Abhi tak nahi aaya.', 'not_received', 'hinglish'],
  ['ok', 'other', 'en', 'backchannel short'],
  ['Which number did you send it to?', 'other', 'en', 'question'],
  ['sorry?', 'repeat', 'en', 'short'],
]);

const wrapup = listen('wrapup', [
  ['no thanks', 'no_more', 'en', 'short'],
  ["That's all, thank you.", 'no_more', 'en'],
  ['nothing else', 'no_more', 'en', 'short'],
  ['No, bye.', 'no_more', 'en', 'short'],
  ['Bas itna hi, thank you.', 'no_more', 'hinglish'],
  ['Okay thank you bye bye.', 'no_more', 'en-IN'],
  ['Actually, can you tell me my loan balance?', 'other', 'en', 'question'],
  ['Yes, one more thing.', 'other', 'en', 'qualified'],
  ["Just don't call me again.", 'stop_calling', 'en'],
]);

const confirmWeek = listen('confirm_week', [
  ['yes', 'yes', 'en', 'short'],
  ['Okay, that works.', 'yes', 'en'],
  ['Haan theek hai.', 'yes', 'hinglish', 'short'],
  ['no', 'no', 'en', 'short'],
  ["No, I can't pay by then.", 'no', 'en'],
  ['Nahi ho payega.', 'no', 'hinglish'],
  ['What if I pay half by then?', 'other', 'en', 'question'],
]);

const paidDate = listen('paid_date', [
  ['On the second of October.', 'gave_date', 'en'],
  ['Last Monday.', 'gave_date', 'en', 'short'],
  ['Parso kiya tha.', 'gave_date', 'hinglish'],
  ["I don't remember exactly.", 'doesnt_remember', 'en'],
  ['Let me check and tell you.', 'doesnt_remember', 'en-IN'],
  ['Yaad nahi hai.', 'doesnt_remember', 'hinglish'],
]);

const hardshipChoice = listen('hardship_choice', [
  ["Send the link, I'll pay something now.", 'partial', 'en'],
  ['I can pay part of it.', 'partial', 'en-IN'],
  ['Thoda abhi de deta hoon.', 'partial', 'hinglish'],
  ['Please arrange the call from the team.', 'relief', 'en'],
  ['I need a revised plan.', 'relief', 'en-IN'],
  ['Team se baat karwa do.', 'relief', 'hinglish'],
  ['What is the minimum I have to pay?', 'other', 'en', 'question'],
]);

const callback = listen('callback', [
  ['Call me in the evening.', 'this_evening', 'en'],
  ['After 6 pm today.', 'this_evening', 'en-IN'],
  ['Shaam ko call karna.', 'this_evening', 'hinglish'],
  ['Tomorrow morning.', 'tomorrow_morning', 'en', 'short'],
  ['Kal subah.', 'tomorrow_morning', 'hinglish', 'short'],
  ['Tomorrow after lunch.', 'tomorrow_evening', 'en'],
  ['kal shaam ko', 'tomorrow_evening', 'hinglish', 'short'],
  ['Next week sometime.', 'other_time', 'en'],
  ['Call me on Saturday.', 'other_time', 'en'],
]);

const knows = listen('knows', [
  ['yes', 'yes', 'en', 'short'],
  ["Yes, he's my neighbour.", 'yes', 'en'],
  ['Haan jaanta hoon.', 'yes', 'hinglish'],
  ['no', 'no', 'en', 'short'],
  ['I have no idea who that is.', 'no', 'en'],
  ['Nahi jaanta.', 'no', 'hinglish', 'short'],
]);

const imported = JSON.parse(
  readFileSync(new URL('./creditmantri-flow.json', import.meta.url), 'utf8'),
);

export const CREDITMANTRI_JEV_EVAL: JevEvalSet = {
  name: 'CreditMantri collections',
  flow: imported.flow as AgentFlow,
  // One of the POC's cases (lib/cases.js, NACH bounce) as the dialer would render it on 7 Oct 2026.
  variables: {
    full_name: 'Rahul Sharma',
    first_name: 'Rahul',
    loan_type: 'two-wheeler loan',
    last4_spoken: 'eight two one three',
    emi_words: 'four thousand eight hundred and fifty rupees',
    due_date_words: 'the 25th of September',
    reason: 'the auto-debit from your bank account bounced due to insufficient balance',
    charge_sentence:
      'A bounce charge of five hundred and ninety rupees has been added, and the account is now 12 days overdue.',
    total_words: 'five thousand four hundred and forty rupees',
    date_today: 'Wednesday, the 7th of October',
    date_tomorrow: 'Thursday, the 8th of October',
    date_3days: 'Saturday, the 10th of October',
    date_week: 'Wednesday, the 14th of October',
  },
  today: 'Wednesday, the 7th of October 2026',
  cases: [
    ...identity,
    ...payment,
    ...linkCheck,
    ...wrapup,
    ...confirmWeek,
    ...paidDate,
    ...hardshipChoice,
    ...callback,
    ...knows,
  ],
  gate: { minAccuracy: 0.9, minListenAccuracy: 0.8, minSlotAccuracy: 0.85 },
};
