import { MD3DarkTheme, MD3LightTheme, configureFonts, type MD3Theme } from 'react-native-paper';

// Inter, loaded in App.tsx. On Android each weight is its own font family, so styles pick the
// family rather than relying on fontWeight.
export const FONT = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
};

function familyFor(variant: string): string {
  if (/^(display|headline)/.test(variant) || variant === 'titleLarge') return FONT.semibold;
  if (/^(title|label)/.test(variant)) return FONT.medium;
  return FONT.regular;
}

const fontConfig = Object.fromEntries(
  Object.entries(MD3LightTheme.fonts)
    .filter(([variant]) => variant !== 'default')
    .map(([variant, style]) => [variant, { ...(style as object), fontFamily: familyFor(variant), fontWeight: 'normal' }]),
);
const fonts = configureFonts({ config: fontConfig as never });

export const STATUS_COLOURS = { ready: '#2E9E6B', problem: '#D9822B', checking: '#8A938F' };

// Green brand on crisp neutrals (Material 3). White cards sit on a light grey page, text is near
// black and secondary text stays well above WCAG AA, so screens read clearly in daylight.
export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  fonts,
  roundness: 3,
  colors: {
    ...MD3LightTheme.colors,
    primary: '#1D5C4B',
    onPrimary: '#FFFFFF',
    primaryContainer: '#BFE9D8',
    onPrimaryContainer: '#00201A',
    secondary: '#3F5951',
    secondaryContainer: '#D3E7DE',
    onSecondaryContainer: '#04201A',
    background: '#F1F3F2',
    onBackground: '#101513',
    surface: '#FFFFFF',
    onSurface: '#101513',
    surfaceVariant: '#E6EBE8',
    onSurfaceVariant: '#3E4945',
    outline: '#66716C',
    outlineVariant: '#CDD5D1',
    elevation: {
      level0: 'transparent',
      level1: '#FFFFFF',
      level2: '#F7F9F8',
      level3: '#F2F5F3',
      level4: '#EEF2F0',
      level5: '#EAEFEC',
    },
  },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  fonts,
  roundness: 3,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#93E0C6',
    onPrimary: '#00382D',
    primaryContainer: '#1F5144',
    onPrimaryContainer: '#C8F5E5',
    secondary: '#B7D1C7',
    secondaryContainer: '#293833',
    onSecondaryContainer: '#D3EEE3',
    background: '#0A0C0B',
    onBackground: '#F0F3F2',
    surface: '#171B1A',
    onSurface: '#F0F3F2',
    surfaceVariant: '#222927',
    onSurfaceVariant: '#BCC7C2',
    outline: '#86918C',
    outlineVariant: '#343D3A',
    elevation: {
      level0: 'transparent',
      level1: '#171B1A',
      level2: '#1C2120',
      level3: '#212725',
      level4: '#232A28',
      level5: '#262E2B',
    },
  },
};
