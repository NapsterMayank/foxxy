import type { Dictionary } from './en';

/**
 * ===========================================================================
 * THE HINDI DICTIONARY.
 *
 * Typed as `Dictionary`, so a missing key is a COMPILE ERROR. That is the
 * whole reason the type exists: a translation file drifts silently otherwise,
 * and the symptom is an English sentence in the middle of a Hindi screen —
 * which nobody working in English ever sees.
 *
 * ---------------------------------------------------------------------------
 * NOT YET REVIEWED BY A NATIVE SPEAKER, AND THAT IS RECORDED RATHER THAN
 * ASSUMED.
 *
 * These strings are engineering-quality Hindi: correct, plain, and consistent
 * in register (आप throughout, not तुम — the product speaks to a child
 * respectfully, and a parent reads the same words). They are NOT launch copy.
 * `frontend/PROGRESS.md` carries this as a launch blocker alongside the other
 * content that needs approval.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY LEFT IN ENGLISH (§8: "never translate").
 *
 *   Alfanumrik   a brand name
 *   CBSE, NCERT  the boards, as every student writes them
 *   XP           the product's own unit
 *   Subject names as the syllabus writes them — a student searching for
 *                "Science" must not have to guess "विज्ञान"
 *
 * ---------------------------------------------------------------------------
 * HINDI RUNS LONGER THAN ENGLISH (§8). Every string here is a layout risk at
 * 360px, which is why the plan asks for the visual-regression language axis —
 * see `tests/e2e/visual.spec.ts`, where that axis is now unblocked.
 * ===========================================================================
 */

export const hi: Dictionary = {
  common: {
    brand: 'Alfanumrik',
    brandPrefix: 'Alfa',
    brandSuffix: 'numrik',
    loading: 'पृष्ठ खुल रहा है',
    languageLabel: 'भाषा',
    english: 'English',
    hindi: 'हिन्दी',
  },

  offline: 'आप ऑफ़लाइन हैं। कनेक्शन लौटने तक आपका काम सहेजा नहीं जाएगा।',

  home: {
    eyebrow: 'अपनी जगह चुनें',
    title: 'Alfanumrik में आपका स्वागत है',
    description: 'चुनें कि आप कैसे आगे बढ़ना चाहते हैं।',
    accountPrompt: 'यहाँ नए हैं?',
    accountAction: 'खाता बनाएँ',
    student: {
      label: 'मैं विद्यार्थी हूँ',
      description: 'सीखें, अभ्यास करें, परीक्षा दें और अपनी प्रगति देखें।',
      action: 'विद्यार्थी के रूप में जारी रखें',
    },
    parent: {
      label: 'मैं अभिभावक हूँ',
      description: 'प्रगति देखें, सदस्यता संभालें और अपने बच्चे का साथ दें।',
      action: 'अभिभावक के रूप में जारी रखें',
    },
  },

  notFound: {
    eyebrow: '404',
    title: 'यह पृष्ठ अभी तैयार नहीं है',
    description: 'शुरुआत पर लौटें और दूसरा रास्ता चुनें।',
    action: 'शुरुआत पर लौटें',
  },

  error: {
    eyebrow: 'पृष्ठ में त्रुटि',
    title: 'इस पृष्ठ में कुछ रुक गया',
    description: 'इस हिस्से को फिर से खोलकर देखें। आगे बढ़ने से पहले अपनी जानकारी जाँच लें।',
    action: 'फिर कोशिश करें',
  },

  session: {
    checking: 'आपका खाता जाँचा जा रहा है',
    noAccessTitle: 'यह जगह आपके खाते के लिए उपलब्ध नहीं है',
    noAccessDescription: 'जिस खाते के पास पहुँच है उससे साइन इन करें, या शुरुआत पर लौटें।',
    noAccessAction: 'साइन इन पर लौटें',
  },

  shell: {
    studentRole: 'विद्यार्थी',
    parentRole: 'अभिभावक',
    navLearn: 'सीखें',
    navProgress: 'प्रगति',
    navPractice: 'अभ्यास',
    navOverview: 'सारांश',
    navChild: 'बच्चा',
    navUpdates: 'नई जानकारी',
    navLearn2: 'अध्ययन',
    navFoxy: 'Foxy से पूछें',
    navBilling: 'योजना',

    identityAction: 'अपनी प्रोफ़ाइल देखें और बदलें',
    identityUnknown: 'आपका खाता',
  },

  auth: {
    loginEyebrow: 'वापसी पर स्वागत है',
    loginTitle: 'जारी रखने के लिए साइन इन करें',
    loginTitleStudent: 'विद्यार्थी के रूप में जारी रखने के लिए साइन इन करें',
    loginTitleParent: 'अभिभावक के रूप में जारी रखने के लिए साइन इन करें',
    loginDescription: 'अपने सीखने की जगह से जुड़े खाते का विवरण उपयोग करें।',
    signupEyebrow: 'Alfanumrik से जुड़ें',
    signupTitle: 'अपना खाता बनाएँ',
    signupDescription: 'ज़रूरी जानकारी से शुरू करें। सीखने की पसंद अगले चरण में।',
    verifyEyebrow: 'एक छोटी जाँच',
    verifyTitle: 'अपना ईमेल सत्यापित करें',
    verifyDescription: 'हमने जो लिंक ईमेल किया है उसे खोलें। जाँच यहीं पूरी होगी।',
    forgotEyebrow: 'खाता पुनःप्राप्ति',
    forgotTitle: 'अपना पासवर्ड रीसेट करें',
    forgotDescription: 'अपना ईमेल दर्ज करें, हम पासवर्ड रीसेट करने के निर्देश भेजेंगे।',
    resetEyebrow: 'खाता पुनःप्राप्ति',
    resetTitle: 'नया पासवर्ड चुनें',
    resetDescription: 'कम से कम 10 अक्षर रखें और अपना पासवर्ड गोपनीय रखें।',

    emailLabel: 'ईमेल पता',
    passwordLabel: 'पासवर्ड',
    newPasswordLabel: 'नया पासवर्ड',
    confirmPasswordLabel: 'पासवर्ड दोहराएँ',
    confirmNewPasswordLabel: 'नया पासवर्ड दोहराएँ',
    accountTypeLabel: 'खाते का प्रकार',
    forgotLink: 'पासवर्ड भूल गए?',
    termsLabel: 'मैं नियम व शर्तों और गोपनीयता नीति से सहमत हूँ।',

    loginAction: 'साइन इन करें',
    signupAction: 'खाता बनाएँ',
    forgotAction: 'रीसेट लिंक भेजें',
    resetAction: 'नया पासवर्ड सहेजें',
    waitAction: 'कृपया प्रतीक्षा करें…',
    resendAction: 'लिंक फिर से भेजें',

    passwordMismatch: 'दोनों पासवर्ड एक जैसे होने चाहिए।',

    errorRequired: 'आगे बढ़ने के लिए यह भरें।',
    errorEmailInvalid: 'सही ईमेल पता दर्ज करें।',
    errorPasswordTooShort: 'कम से कम 10 अक्षर रखें।',
    errorPasswordTooLong: 'अधिकतम 200 अक्षर रखें।',
    errorTermsRequired: 'खाता बनाने के लिए नियम व शर्तें और गोपनीयता नीति स्वीकार करें।',

    errorInvalidCredentials: 'यह ईमेल और पासवर्ड किसी खाते से मेल नहीं खाते।',
    errorRateLimited: 'बहुत बार कोशिश हुई। थोड़ी देर बाद फिर कोशिश करें।',
    errorRateLimitedSeconds: 'बहुत बार कोशिश हुई। {seconds} सेकंड बाद फिर कोशिश करें।',
    errorDegraded: 'हमारी एक सेवा अभी उपलब्ध नहीं है। थोड़ी देर बाद कोशिश करें।',
    errorBlocked: 'यह अनुरोध अस्वीकार हुआ। पेज दोबारा लोड करके कोशिश करें।',
    errorLinkInvalid: 'यह लिंक समाप्त हो चुका है या पहले ही उपयोग हो चुका है।',
    errorGeneric: 'कुछ गड़बड़ हुई। फिर कोशिश करें।',

    verifyMissingToken: 'यह लिंक अधूरा है। अपने ईमेल से पूरा लिंक खोलें।',
    verifyPending: 'आपका लिंक जाँचा जा रहा है…',
    verifySuccess: 'आपका ईमेल सत्यापित हो गया। जारी रखने के लिए साइन इन करें।',
    verifyNeeded: 'आपका ईमेल पता अभी सत्यापित नहीं है।',
    resendEmailHint: 'हम इसी पते पर सत्यापन लिंक दोबारा भेजेंगे।',
    resendSent: 'यदि उस पते को सत्यापन चाहिए, तो नया लिंक भेज दिया गया है।',

    forgotSent: 'यदि उस पते से खाता जुड़ा है, तो रीसेट निर्देश भेज दिए गए हैं।',
    resetSuccess: 'आपका नया पासवर्ड सहेज लिया गया। अब उसी से साइन इन करें।',
    signupSuccess: 'खाता बन गया। सत्यापन लिंक के लिए अपना ईमेल देखें।',

    changeRole: 'भूमिका बदलें',
    footerNewHere: 'यहाँ नए हैं?',
    footerCreate: 'खाता बनाएँ',
    footerHaveAccount: 'पहले से खाता है?',
    footerSignIn: 'साइन इन करें',

  },

  onboarding: {
    studentEyebrow: 'अपनी पढ़ाई तैयार करें',
    studentTitle: 'सीखना अपने हिसाब से',
    studentDescription: 'बताएँ कि आप कहाँ पढ़ रहे हैं ताकि अभ्यास आपकी कक्षा से मेल खाए।',
    parentEyebrow: 'अपना खाता तैयार करें',
    parentTitle: 'अपने बच्चे से जुड़ें',
    parentDescription: 'खाता सुरक्षित रूप से जोड़ने के लिए ज़रूरी विवरण भरें।',

    displayNameLabel: 'दिखाने का नाम',
    gradeLabel: 'कक्षा',
    gradePlaceholder: 'अपनी कक्षा चुनें',
    languageLabel: 'पसंदीदा भाषा',
    subjectsLabel: 'किन विषयों से शुरू करें',
    gradeOption: 'कक्षा {grade}',
    consentLabel: 'मैं पुष्टि करता/करती हूँ कि मैं इस बच्चे का अभिभावक या कानूनी संरक्षक हूँ।',
    linkCodeLabel: 'बच्चे का आमंत्रण कोड',
    linkCodeHint: 'यह कोड आपका बच्चा अपने खाते में बनाता है।',
    action: 'सहेजें और आगे बढ़ें',

    subjectOption: {
      mathematics: 'गणित',
      science: 'विज्ञान',
    },

    errorSubjectsRequired: 'कम से कम एक विषय चुनें।',
    errorGradeRequired: 'अपनी कक्षा चुनें।',
    errorDisplayNameRequired: 'वह नाम लिखें जिससे आपको बुलाया जाए।',
    errorLinkCodeInvalid: 'लिंक कोड 6 अक्षरों का होता है।',
    errorLinkCodeUnknown: 'यह कोड मान्य नहीं है। अपने बच्चे से नया कोड लें।',
    errorConsentRequired: 'आगे बढ़ने के लिए पुष्टि करें कि आप अभिभावक या संरक्षक हैं।',

    studentSaved: 'आपकी प्रोफ़ाइल तैयार है। अभ्यास शुरू करने के लिए तैयार है।',
    linkPending: 'अनुरोध भेज दिया गया। आपका बच्चा अपने खाते से मंज़ूरी देगा, तभी जानकारी दिखेगी।',
  },

  student: {
    eyebrow: 'विद्यार्थी डैशबोर्ड',
    greeting: 'नमस्ते, {name}',
    intro: 'आपका अगला अभ्यास और हाल के सत्र क्या दिखाते हैं।',
    greetingUnknown: 'नमस्ते',
    reviewProgress: 'मेरी प्रगति देखें',

    nextUpEyebrow: 'अगला',
    nextUpChapter: 'अध्याय {number} · {title}',
    nextUpQuestions: '{count} प्रश्न',
    startPractice: 'अभ्यास शुरू करें',
    missionEmptyTitle: 'अभी अभ्यास के लिए कुछ नहीं',
    missionEmptyDescription: 'आपके विषयों में अध्याय जुड़ते ही अगला अभ्यास यहाँ दिखेगा।',

    continueEyebrow: 'जहाँ छोड़ा था',
    continueNone: 'आपने अभी कोई अभ्यास सत्र पूरा नहीं किया है।',
    continueChapter: '{title} · अभ्यास {date}',

    loading: 'आपका डैशबोर्ड खुल रहा है',
    errorTitle: 'आपका डैशबोर्ड खुल नहीं सका',
    retryAction: 'फिर कोशिश करें',
  },

  parent: {
    eyebrow: 'अभिभावक डैशबोर्ड',
    title: 'आपके बच्चे की पढ़ाई',
    intro: 'बिना किसी रैंकिंग या तुलना के, हाल की पढ़ाई का शांत और प्रमाण-आधारित सारांश देखें।',
    updatesEyebrow: 'हाल की जानकारी',
    updatesTitle: 'पढ़ाई की गतिविधि',
  },

  /** चार प्रमाण-लेबल — §9.1। कोई प्रतिशत नहीं, केवल शब्द। */
  evidence: {
    strong: 'पक्का प्रमाण',
    developing: 'बन रहा है',
    needsAnotherSession: 'एक और सत्र चाहिए',
    notAssessed: 'अभी आकलन नहीं हुआ',
  },

  /** Foxy — `Foxy`, NCERT और विषयों के नाम अनुवादित नहीं हैं (§8)। */
  foxy: {
    eyebrow: 'Foxy से पूछें',
    title: 'Foxy, आपकी किताब का शिक्षक',
    description: 'Foxy आपकी NCERT किताब से उत्तर देता है और बताता है कि उत्तर कहाँ से आया।',

    startTitle: 'आप क्या करना चाहेंगे?',
    startDescription: 'विषय चुनें और तय करें कि कैसे पढ़ना है। आप कभी भी नई शुरुआत कर सकते हैं।',
    modeLabel: 'आप कैसे पढ़ना चाहेंगे?',
    modeOption: {
      doubt: 'मुझसे कुछ भी पूछें',
      explain: 'एक विषय समझाएँ',
      practice: 'मुझसे सवाल पूछें',
    },
    subjectLabel: 'विषय',
    startAction: 'शुरू करें',
    startAgainAction: 'नई बातचीत शुरू करें',

    transcriptLabel: 'Foxy के साथ बातचीत',
    youLabel: 'आप',
    foxyLabel: 'Foxy',
    streamingLabel: 'Foxy उत्तर दे रहा है',
    abstainedLabel: 'यह आपकी किताब में नहीं मिला',
    citationsTitle: 'आपकी किताब से',
    citationChapter: 'अध्याय {number}: {title}',
    citationUnknownChapter: 'आपकी किताब',
    truncatedNotice: 'यह उत्तर दिखाने के लिए बहुत लंबा था। छोटे उत्तर के लिए फिर से पूछें।',

    composerLabel: 'आपका सवाल',
    composerPlaceholder: 'अपना सवाल लिखें',
    composerRemaining: '{remaining} अक्षर बाकी',
    sendAction: 'भेजें',
    stopAction: 'रोकें',
    retryAction: 'फिर से कोशिश करें',

    actionsTitle: 'या Foxy से कहें',

    emptyTitle: 'अपना पहला सवाल पूछें',
    emptyDescription: 'सवाल लिखें, या शुरू करने के लिए नीचे दिए बटनों में से कोई चुनें।',
    loadingTranscript: 'आपकी बातचीत खुल रही है',

    usageRemaining: 'आज {limit} में से {remaining} संदेश बाकी',
    usageExhausted: 'आज के सारे संदेश इस्तेमाल हो गए। Foxy कल फिर उपलब्ध होगा।',

    errorTitle: 'Foxy उत्तर नहीं दे सका',
    errorGeneric: 'उत्तर बीच में रुक गया। फिर से पूछें।',
    errorPartial: 'उत्तर बीच में रुक गया। जितना आया, वह ऊपर मौजूद है।',
    errorRateLimited: 'बहुत तेज़ी हो गई। थोड़ा रुककर फिर पूछें।',
    errorRateLimitedSeconds: 'बहुत तेज़ी हो गई। {seconds} सेकंड बाद फिर कोशिश करें।',
    errorDegraded: 'Foxy अभी व्यस्त है। थोड़ी देर में फिर कोशिश करें।',
    errorBlocked: 'यह सवाल भेजा नहीं जा सका। इसे दूसरे शब्दों में लिखें।',
    errorNotFound: 'यह बातचीत अब उपलब्ध नहीं है। नई बातचीत शुरू करें।',
    errorStartFailed: 'बातचीत शुरू नहीं हो सकी। फिर से कोशिश करें।',
    errorCapabilities: 'Foxy खुल नहीं सका। फिर से कोशिश करें।',
  },

  practice: {
    eyebrow: 'अभ्यास',
    title: 'आज का अभ्यास',
    description: 'आप जो पढ़ रहे हैं, उसमें से चुने गए कुछ सवाल।',

    missionEyebrow: 'आपके लिए चुना गया',
    missionNoneTitle: 'अभी आपके लिए कुछ तैयार नहीं है',
    missionNoneDescription:
      'अपने विषयों में से कोई अध्याय शुरू करें, फिर अभ्यास यहाँ दिखेगा।',
    missionQuestionCount: '{count} सवाल',
    startAction: 'अभ्यास शुरू करें',
    startAgainAction: 'कुछ और अभ्यास करें',

    questionProgress: 'सवाल {total} में से {current}',
    optionsLabel: 'एक उत्तर चुनें',
    answerAction: 'मेरा उत्तर जाँचें',
    nextAction: 'अगला सवाल',
    finishAction: 'पूरा करें और नतीजा देखें',
    resumeReadyDescription: 'इस सत्र के सभी सवालों के उत्तर हो चुके हैं।',
    loadingSession: 'आपके सवाल तैयार हो रहे हैं',

    feedbackCorrect: 'यह सही है।',
    feedbackIncorrect: 'इस बार नहीं। कारण यह रहा।',
    correctAnswerLabel: 'सही उत्तर:',
    explanationTitle: 'क्यों',

    summaryTitle: 'सत्र पूरा हुआ',
    summaryScore: '{total} में से {correct} सही',
    summaryXp: '{xp} XP',
    summaryXpWithheld: '{withheld} XP नहीं जुड़े — आज की सीमा पूरी हो चुकी है।',
    summaryEvidenceTitle: 'इससे क्या पता चलता है',
    summaryNextReview: 'यह अध्याय {date} को फिर आएगा।',
    summaryDoneAction: 'मेरे डैशबोर्ड पर लौटें',

    invalidTitle: 'यह प्रयास गिना नहीं गया',
    invalidTooFast:
      'उत्तर पढ़ने से भी तेज़ आए। आराम से, अध्याय फिर से करें।',
    invalidSameAnswer:
      'हर सवाल में एक ही विकल्प चुना गया। हर सवाल देखकर फिर कोशिश करें।',
    invalidGeneric:
      'इस प्रयास को गिना नहीं जा सका। अध्याय फिर से करें।',

    errorTitle: 'अभ्यास खुल नहीं सका',
    errorGeneric: 'कुछ गड़बड़ हुई। फिर कोशिश करें।',
    errorStartFailed:
      'अभ्यास सत्र शुरू नहीं हो सका। फिर कोशिश करें।',
    errorAnswerFailed:
      'यह उत्तर दर्ज नहीं हुआ। फिर कोशिश करें।',
    errorConflict:
      'यह पहले ही दर्ज हो चुका है। स्क्रीन पर जहाँ हैं, वहीं से आगे बढ़ें।',
    errorAnswerConflict:
      'इस सवाल का उत्तर पहले ही दर्ज है, और उत्तर बदले नहीं जा सकते।',
    errorSubmitConflict: 'यह सत्र पहले ही पूरा हो चुका है।',
    errorSessionGone:
      'यह अभ्यास सत्र अब उपलब्ध नहीं है। नया सत्र शुरू करें।',
    errorRateLimited: 'बहुत तेज़ी हो गई। थोड़ा रुककर फिर कोशिश करें।',
    errorRateLimitedSeconds: 'बहुत तेज़ी हो गई। {seconds} सेकंड बाद फिर कोशिश करें।',
    errorDegraded:
      'हमारी एक सेवा अभी उपलब्ध नहीं है। थोड़ी देर बाद कोशिश करें।',
    retryAction: 'फिर कोशिश करें',
  },

  progressScreen: {
    eyebrow: 'आपकी प्रगति',
    title: 'आपके अभ्यास से क्या पता चलता है',
    description:
      'आपके अपने सत्रों से मिले प्रमाण। कोई अंक नहीं, और किसी से तुलना नहीं।',

    totalXpLabel: 'कुल XP',
    xpTodayLabel: 'आज का XP',
    sessionsLabel: 'पूरे हुए सत्र',

    chaptersTitle: 'अध्याय दर अध्याय',
    attemptsLabel: '{count} सत्र',
    lastPractisedLabel: 'पिछला अभ्यास {date}',
    neverPractisedLabel: 'अभी अभ्यास नहीं हुआ',
    nextReviewLabel: 'दोहराव {date} को',

    historyTitle: 'हाल के सत्र',
    historyScore: '{xp} XP',
    historyPending: 'पूरा नहीं हुआ',
    historyInvalid: 'गिना नहीं गया',

    emptyTitle: 'अभी कोई अभ्यास नहीं',
    emptyDescription:
      'एक अभ्यास सत्र पूरा करें, फिर आपके प्रमाण यहाँ दिखेंगे।',
    loading: 'आपकी प्रगति खुल रही है',
    errorTitle: 'प्रगति खुल नहीं सकी',
    retryAction: 'फिर कोशिश करें',
  },

  profileScreen: {
    eyebrow: 'आपका खाता',
    title: 'आपकी प्रोफ़ाइल',
    description:
      'आपको किस नाम से बुलाया जाए, आप किस कक्षा में हैं, और हम किस भाषा में उत्तर दें।',

    displayNameLabel: 'दिखने वाला नाम',
    displayNameHint: 'यही नाम Foxy और आपके अभिभावक को दिखता है।',
    gradeLabel: 'कक्षा',
    gradeOption: 'कक्षा {grade}',
    languageLabel: 'उत्तर की भाषा',
    languageHint: 'सहेजते ही Foxy, आपकी रिपोर्ट और यह ऐप — सब इसी भाषा में हो जाएँगे।',
    boardLabel: 'बोर्ड',
    boardNote: 'बोर्ड खाता बनते समय तय होता है और यहाँ से नहीं बदला जा सकता।',

    action: 'बदलाव सहेजें',
    unchangedHint: 'सहेजने के लिए कुछ बदलें।',
    saved: 'आपकी प्रोफ़ाइल अपडेट हो गई।',

    errorDisplayNameRequired: 'वह नाम लिखें जिससे आपको बुलाया जाए।',
    errorGradeRequired: 'अपनी कक्षा चुनें।',
    errorLanguageRequired: 'एक भाषा चुनें।',
    errorGeneric: 'आपकी प्रोफ़ाइल सहेजी नहीं जा सकी। फिर कोशिश करें।',
    errorConflict: 'आपकी प्रोफ़ाइल कहीं और बदल गई है। पेज दोबारा खोलकर कोशिश करें।',

    loading: 'आपकी प्रोफ़ाइल खुल रही है',
    errorTitle: 'आपकी प्रोफ़ाइल खुल नहीं सकी',
    retryAction: 'फिर कोशिश करें',
    missingTitle: 'अभी कोई प्रोफ़ाइल नहीं',
    missingDescription: 'अपना खाता सेट करना पूरा करें, फिर आपकी प्रोफ़ाइल यहाँ दिखेगी।',
    missingAction: 'मेरा खाता सेट करें',
  },

  parentDashboard: {
    childLabel: '{name} · कक्षा {grade}',
    childPickerLabel: 'चुनें कि किस बच्चे की जानकारी देखनी है',

    snapshotTitle: 'इस सप्ताह',
    trendMore: 'पिछले सप्ताह से ज़्यादा अभ्यास',
    trendSame: 'पिछले सप्ताह जैसा ही',
    trendLess: 'पिछले सप्ताह से कम अभ्यास',
    trendFirstWeek: 'यह पहला सप्ताह है, तुलना के लिए अभी कुछ नहीं',

    digestTitle: 'इस सप्ताह क्या दिखा',
    digestActionTitle: 'एक बात जो मदद करेगी',
    digestMisconception: 'संदर्भ: {code}',
    digestCounts: '{days} दिन · {sessions} सत्र · {questions} सवाल',
    digestPendingTitle: 'इस सप्ताह का सारांश अभी नहीं लिखा गया',
    digestPendingDescription:
      'सारांश सप्ताह में एक बार तैयार होता है। तैयार होते ही यहाँ दिखेगा।',

    transcriptTitle: 'Foxy के साथ बातचीत',
    transcriptChild: 'आपका बच्चा',
    transcriptFoxy: 'Foxy',
    transcriptReadOnly: 'केवल पढ़ने के लिए',
    transcriptEmptyTitle: 'अभी कोई बातचीत नहीं',
    transcriptEmptyDescription: 'आपका बच्चा Foxy से जो पूछेगा, वह यहाँ दिखेगा।',
    transcriptUnavailableTitle: 'बातचीत अभी उपलब्ध नहीं है',
    transcriptUnavailableDescription:
      'उत्पाद का यह हिस्सा अभी तैयार नहीं है। ऐसा नहीं है कि आपके बच्चे ने कुछ नहीं पूछा।',

    visibilityChildTold: 'आपका बच्चा जानता है कि आप ये बातचीत पढ़ सकते हैं।',
    visibilityChildNotTold:
      'आपके बच्चे को नहीं बताया गया है कि आप ये बातचीत पढ़ सकते हैं।',

    consentTitle: 'आपकी पहुँच',
    consentViewSnapshot: 'साप्ताहिक झलक',
    consentViewDigest: 'साप्ताहिक सारांश',
    consentViewTranscript: 'Foxy के साथ बातचीत',
    consentChildInformed: 'आपके बच्चे को इस पहुँच के बारे में बताया गया है।',
    consentChildNotInformed: 'आपके बच्चे को इस पहुँच के बारे में नहीं बताया गया है।',
    consentRevokeAction: 'मेरी पहुँच वापस लें',
    consentRevokeTitle: 'अपनी पहुँच वापस लें?',
    consentRevokeDescription:
      'आपको इस बच्चे की झलक, सारांश और बातचीत दिखनी बंद हो जाएगी। दोबारा पहुँच केवल आपका बच्चा नए आमंत्रण कोड से दे सकता है।',
    consentRevokeConfirm: 'पहुँच वापस लें',
    consentRevokeCancel: 'पहुँच बनी रहने दें',

    noChildrenTitle: 'अभी कोई बच्चा जुड़ा नहीं है',
    noChildrenDescription:
      'शुरू करने के लिए अपने बच्चे से उनके खाते का आमंत्रण कोड लें।',
    pendingTitle: 'आपके बच्चे की मंज़ूरी का इंतज़ार',
    pendingDescription:
      'आपका अनुरोध भेज दिया गया है। जब तक आपका बच्चा अपने खाते से मंज़ूरी नहीं देता, यहाँ कुछ नहीं दिखेगा।',

    loading: 'खुल रहा है',
    errorTitle: 'यह खुल नहीं सका',
    panelErrorDescription:
      'यह हिस्सा खुल नहीं सका। बाकी पृष्ठ पर इसका असर नहीं है।',
    errorGeneric: 'कुछ गड़बड़ हुई। फिर कोशिश करें।',
    errorNoAccess:
      'अब आपके पास इस बच्चे की पढ़ाई देखने की पहुँच नहीं है। दोबारा पहुँच केवल आपका बच्चा दे सकता है।',
    errorNotFound: 'यह अब उपलब्ध नहीं है।',
    errorBlocked: 'यह अनुरोध अस्वीकार हुआ। पेज दोबारा लोड करके कोशिश करें।',
    errorRateLimited: 'बहुत ज़्यादा अनुरोध। थोड़ा रुककर फिर कोशिश करें।',
    errorRateLimitedSeconds: 'बहुत ज़्यादा अनुरोध। {seconds} सेकंड बाद फिर कोशिश करें।',
    errorDegraded: 'हमारी एक सेवा अभी उपलब्ध नहीं है। थोड़ी देर बाद कोशिश करें।',
    retryAction: 'फिर कोशिश करें',
  },

  billing: {
    eyebrow: 'सदस्यता',
    title: 'आपकी योजना',
    description: 'आपके खाते में क्या शामिल है, और बदलने पर क्या लागत होगी।',

    currentTitle: 'अभी',
    planFree: 'मुफ़्त योजना',
    planPaid: 'सशुल्क योजना',
    currentPlanBadge: 'आपकी योजना',
    currentPlanNote: 'आप इसी योजना पर हैं।',
    paidBySchool:
      'इस खाते का भुगतान आपका स्कूल करता है। आपको कुछ खरीदने या रद्द करने की ज़रूरत नहीं।',

    statusActive: 'चालू',
    statusPending: 'भुगतान की प्रतीक्षा',
    statusPastDue: 'भुगतान पर ध्यान दें',
    statusCancelled: 'रद्द',
    statusExpired: 'समाप्त',

    renewsOn: '{date} को नवीनीकरण होगा।',
    accessUntil: '{date} तक आपकी पहुँच बनी रहेगी।',
    cancelledNote: 'यह योजना आगे नवीनीकृत नहीं होगी।',

    plansTitle: 'योजनाएँ',
    perMonth: 'प्रति माह',
    perYear: 'प्रति वर्ष',
    perDays: 'हर {days} दिन',
    chooseAction: 'यह योजना चुनें',

    featurePracticeBasic: 'रोज़ का अभ्यास',
    featurePracticeUnlimited: 'असीमित अभ्यास',
    featureFoxyBasic: 'Foxy से पूछें',
    featureFoxyUnlimited: 'Foxy से असीमित सवाल',
    featureParentDigest: 'अभिभावक के लिए साप्ताहिक सारांश',

    cancelAction: 'मेरी योजना रद्द करें',
    cancelTitle: 'योजना रद्द करें?',
    cancelDescription:
      'आपकी योजना आगे नवीनीकृत नहीं होगी। {date} तक आपके पास सब कुछ बना रहेगा, और उसके बाद कोई शुल्क नहीं लगेगा।',
    cancelConfirm: 'योजना रद्द करें',
    cancelKeep: 'योजना बनी रहने दें',

    loading: 'आपकी योजना खुल रही है',
    errorTitle: 'आपकी योजना खुल नहीं सकी',
    errorPlansTitle: 'योजनाएँ खुल नहीं सकीं',
    errorGeneric: 'कुछ गड़बड़ हुई। फिर कोशिश करें।',
    errorAlreadySubscribed:
      'आपके पास पहले से एक चालू योजना है। इसे देखने के लिए पेज दोबारा लोड करें।',
    errorPlanUnavailable:
      'यह योजना अब उपलब्ध नहीं है। मौजूदा योजनाओं के लिए पेज दोबारा लोड करें।',
    errorNoSubscription: 'बदलने के लिए कोई योजना नहीं है।',
    errorCheckoutFailed:
      'भुगतान पृष्ठ नहीं खुल सका। कोई शुल्क नहीं लिया गया है।',
    errorCheckoutUnavailable:
      'भुगतान पृष्ठ नहीं खुल सका। कोई शुल्क नहीं लिया गया है।',
    errorProviderUnavailable:
      'भुगतान सेवा अभी उपलब्ध नहीं है। थोड़ी देर बाद कोशिश करें।',
    errorBlocked: 'यह अनुरोध अस्वीकार हुआ। पेज दोबारा लोड करके कोशिश करें।',
    errorRateLimited: 'बहुत बार कोशिश हुई। थोड़ा रुककर फिर कोशिश करें।',
    errorRateLimitedSeconds: 'बहुत बार कोशिश हुई। {seconds} सेकंड बाद फिर कोशिश करें।',
    retryAction: 'फिर कोशिश करें',
  },

  learn: {
    eyebrow: 'अध्ययन',
    title: 'आपके विषय',
    description: 'अध्याय को एक-एक विचार करके पढ़ें, फिर अभ्यास करें।',

    subjectsLabel: 'विषय चुनें',
    pickSubject: 'अध्याय देखने के लिए विषय चुनें।',
    chaptersTitle: 'अध्याय',
    noChapters: 'इस विषय में आपकी कक्षा के लिए अभी कोई अध्याय नहीं है।',

    chapterNumber: 'अध्याय {number}',
    backToChapters: '← सभी अध्याय',
    conceptProgress: '{total} में से {current} विचार',
    keyFormula: 'सूत्र',
    example: 'उदाहरण',
    commonMistakes: 'इनसे बचें',

    previousConcept: 'पीछे',
    nextConcept: 'अगला विचार',
    practiceThisChapter: 'इसका अभ्यास करें',
    practiceInstead: 'इस अध्याय का अभ्यास करें',
    askFoxy: 'इस बारे में Foxy से पूछें',

    noConceptsTitle: 'इस अध्याय की पढ़ाई अभी तैयार नहीं है',
    noConceptsDescription: 'इसके सवाल तैयार हैं, तो आप अभ्यास कर सकते हैं।',

    loading: 'खुल रहा है',
    errorTitle: 'यह खुल नहीं सका',
    errorDescription: 'कुछ गड़बड़ हुई। फिर कोशिश करें।',
    retryAction: 'फिर कोशिश करें',
  },

  childSummary: {
    eyebrow: 'आपका बच्चा',
    recentActivityLabel: 'हाल की गतिविधि',
    latestEvidenceLabel: 'नवीनतम प्रमाण',
    focusAreaLabel: 'आगे किस पर ध्यान दें',
    visibilityNote: 'इस पृष्ठ पर दिखाई गई हर बात आपका बच्चा भी देख सकता है।',
  },
};
