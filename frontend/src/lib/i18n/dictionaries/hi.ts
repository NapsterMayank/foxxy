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
    preview: 'झलक',
    sampleData: 'नमूना जानकारी',
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
    previewTitle: 'झलक',
    previewNote: 'सेवाएँ जुड़ने तक यहाँ नमूना जानकारी दिखाई जा रही है।',
    studentRole: 'विद्यार्थी झलक',
    parentRole: 'अभिभावक झलक',
    navLearn: 'सीखें',
    navProgress: 'प्रगति',
    navPractice: 'अभ्यास',
    navOverview: 'सारांश',
    navChild: 'बच्चा',
    navUpdates: 'नई जानकारी',
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
    intro: 'आपकी अगली गतिविधि तैयार है। जहाँ छोड़ा था वहाँ से शुरू करें या हाल की प्रगति देखें।',
    seeNext: 'अगली गतिविधि देखें',
    reviewProgress: 'मेरी प्रगति देखें',
    nextUpEyebrow: 'अगला',
    nextUpTitle: 'रोज़मर्रा में भिन्न',
    nextUpDescription: 'व्यंजनों और बाँटने के उदाहरणों से एक छोटा अभ्यास।',
    previewOnly: 'केवल झलक',
    weekEyebrow: 'इस सप्ताह',
    weekTitle: 'चार दिन पढ़ाई',
    weekDescription: 'लगातार बने रहना, बिना नागा वाले रिकॉर्ड से अधिक मायने रखता है। अच्छा चल रहा है।',
    weekProgressLabel: '{total} में से {done} दिन पूरे',
    progressTitle: 'आपकी पढ़ाई कैसे आगे बढ़ रही है',
  },

  parent: {
    eyebrow: 'अभिभावक डैशबोर्ड',
    greeting: 'वापसी पर स्वागत है, {name}',
    intro: 'बिना किसी रैंकिंग या तुलना के, हाल की पढ़ाई का शांत और प्रमाण-आधारित सारांश देखें।',
    updatesEyebrow: 'हाल की जानकारी',
    updatesTitle: 'पढ़ाई की गतिविधि',
  },

  progress: {
    eyebrow: 'सीखने के प्रमाण',
    sampleLabel: 'नमूना प्रगति',
  },

  childSummary: {
    eyebrow: 'आपका बच्चा',
    recentActivityLabel: 'हाल की गतिविधि',
    latestEvidenceLabel: 'नवीनतम प्रमाण',
    focusAreaLabel: 'आगे किस पर ध्यान दें',
    visibilityNote: 'इस पृष्ठ पर दिखाई गई हर बात आपका बच्चा भी देख सकता है।',
  },
};
