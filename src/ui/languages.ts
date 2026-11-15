// Names for speech languages ("en-GB" → "English (UK)"), and the device's own language.
// Hermes has no Intl.DisplayNames, so the common names are here.
import { I18nManager, Platform } from 'react-native';

const LANGUAGES: Record<string, string> = {
  af: 'Afrikaans', ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali', ca: 'Catalan', cmn: 'Chinese', cs: 'Czech', cy: 'Welsh',
  da: 'Danish', de: 'German', el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian', fa: 'Persian', fi: 'Finnish',
  fil: 'Filipino', fr: 'French', ga: 'Irish', gu: 'Gujarati', ha: 'Hausa', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian',
  hu: 'Hungarian', id: 'Indonesian', ig: 'Igbo', in: 'Indonesian', it: 'Italian', iw: 'Hebrew', ja: 'Japanese', kn: 'Kannada',
  ko: 'Korean', lt: 'Lithuanian', lv: 'Latvian', ml: 'Malayalam', mr: 'Marathi', ms: 'Malay', nb: 'Norwegian', nl: 'Dutch',
  no: 'Norwegian', pa: 'Punjabi', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak', sl: 'Slovenian',
  sr: 'Serbian', sv: 'Swedish', sw: 'Swahili', ta: 'Tamil', te: 'Telugu', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian',
  ur: 'Urdu', vi: 'Vietnamese', yo: 'Yoruba', yue: 'Cantonese', zh: 'Chinese', zu: 'Zulu',
};
const REGIONS: Record<string, string> = {
  AE: 'UAE', AR: 'Argentina', AT: 'Austria', AU: 'Australia', BE: 'Belgium', BR: 'Brazil', CA: 'Canada', CH: 'Switzerland',
  CL: 'Chile', CN: 'China', CO: 'Colombia', DE: 'Germany', EG: 'Egypt', ES: 'Spain', FR: 'France', GB: 'UK', GH: 'Ghana',
  HK: 'Hong Kong', IE: 'Ireland', IN: 'India', IT: 'Italy', JM: 'Jamaica', JP: 'Japan', KE: 'Kenya', KR: 'South Korea',
  MX: 'Mexico', NG: 'Nigeria', NL: 'Netherlands', NZ: 'New Zealand', PH: 'Philippines', PK: 'Pakistan', PT: 'Portugal',
  SA: 'Saudi Arabia', SG: 'Singapore', TW: 'Taiwan', US: 'US', ZA: 'South Africa',
};

export function languageName(code: string): string {
  const [lang = '', region = ''] = code.replace('_', '-').split('-');
  let name = LANGUAGES[lang.toLowerCase()];
  if (!name) {
    try {
      name = new Intl.DisplayNames(['en-GB'], { type: 'language' }).of(lang) ?? '';
    } catch {
      name = '';
    }
  }
  name ||= lang;
  return region ? `${name} (${REGIONS[region.toUpperCase()] ?? region.toUpperCase()})` : name;
}

/** The language the phone (or the PC's browser) is set to, e.g. "fr-FR". Voice uses it unless Settings says otherwise. */
export function deviceLanguage(): string {
  if (Platform.OS === 'web') return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  try {
    // Android gives e.g. "en_GB", or "zh_CN_#Hans" with a script.
    const id = (I18nManager.getConstants() as { localeIdentifier?: string | null }).localeIdentifier;
    const [lang, region] = (id ?? '').split(/[-_]/).filter((p) => p && !p.startsWith('#'));
    if (lang) return region ? `${lang}-${region}` : lang;
  } catch {
    // fall through
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}
