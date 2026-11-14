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

// Calm green brand on neutral surfaces (Material 3).
export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  fonts,
  roundness: 3,
  colors: {
    ...MD3LightTheme.colors,
    primary: '#2F6F5E',
    onPrimary: '#FFFFFF',
    primaryContainer: '#C6EEDF',
    onPrimaryContainer: '#002019',
    secondary: '#4B635B',
    secondaryContainer: '#DCE9E3',
    onSecondaryContainer: '#08201A',
    background: '#FBFCFA',
    surface: '#FFFFFF',
    surfaceVariant: '#F0F3F1',
    onSurfaceVariant: '#55605B',
    outline: '#79837E',
    outlineVariant: '#DCE2DF',
    elevation: {
      level0: 'transparent',
      level1: '#F5F8F6',
      level2: '#EFF3F1',
      level3: '#EAF0ED',
      level4: '#E7EEEA',
      level5: '#E3EBE7',
    },
  },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  fonts,
  roundness: 3,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#8BD5BD',
    onPrimary: '#00382D',
    primaryContainer: '#1D4B40',
    onPrimaryContainer: '#C2F0E0',
    secondary: '#B2CCC2',
    secondaryContainer: '#26332F',
    onSecondaryContainer: '#CEE9DE',
    background: '#0F1211',
    surface: '#161A19',
    surfaceVariant: '#1B201E',
    onSurfaceVariant: '#A9B4AF',
    outline: '#7D8783',
    outlineVariant: '#2C3431',
    elevation: {
      level0: 'transparent',
      level1: '#151A18',
      level2: '#191F1D',
      level3: '#1D2421',
      level4: '#1F2623',
      level5: '#222A27',
    },
  },
};
