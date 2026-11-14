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

export const STATUS_COLOURS = { ready: '#22A06B', problem: '#D97706', checking: '#8A8A93' };

// Graphite on crisp neutrals (Material 3), like a well-made tool rather than a toy. White cards on a
// light grey page, near-black text and buttons, secondary text well above WCAG AA. Colour is kept for
// meaning: blue links, and the green, amber and grey status dots.
export const LINK = { light: '#1D4ED8', dark: '#8AB4FF' };

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  fonts,
  roundness: 3,
  colors: {
    ...MD3LightTheme.colors,
    primary: '#18181B',
    onPrimary: '#FFFFFF',
    primaryContainer: '#E4E4E7',
    onPrimaryContainer: '#18181B',
    secondary: '#52525B',
    onSecondary: '#FFFFFF',
    secondaryContainer: '#E4E4E7',
    onSecondaryContainer: '#18181B',
    tertiary: LINK.light,
    background: '#F4F4F5',
    onBackground: '#18181B',
    surface: '#FFFFFF',
    onSurface: '#18181B',
    surfaceVariant: '#EFEFF1',
    onSurfaceVariant: '#52525B',
    surfaceDisabled: 'rgba(24, 24, 27, 0.10)',
    onSurfaceDisabled: 'rgba(24, 24, 27, 0.38)',
    outline: '#71717A',
    outlineVariant: '#D4D4D8',
    inverseSurface: '#27272A',
    inverseOnSurface: '#F4F4F5',
    elevation: {
      level0: 'transparent',
      level1: '#FFFFFF',
      level2: '#FAFAFA',
      level3: '#F7F7F8',
      level4: '#F4F4F5',
      level5: '#F1F1F3',
    },
  },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  fonts,
  roundness: 3,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#FAFAFA',
    onPrimary: '#18181B',
    primaryContainer: '#2E2E33',
    onPrimaryContainer: '#FAFAFA',
    secondary: '#A1A1AA',
    onSecondary: '#18181B',
    secondaryContainer: '#2E2E33',
    onSecondaryContainer: '#FAFAFA',
    tertiary: LINK.dark,
    background: '#09090B',
    onBackground: '#FAFAFA',
    surface: '#18181B',
    onSurface: '#FAFAFA',
    surfaceVariant: '#26262A',
    onSurfaceVariant: '#B4B4BD',
    surfaceDisabled: 'rgba(250, 250, 250, 0.10)',
    onSurfaceDisabled: 'rgba(250, 250, 250, 0.38)',
    outline: '#8A8A93',
    outlineVariant: '#3F3F46',
    inverseSurface: '#F4F4F5',
    inverseOnSurface: '#18181B',
    elevation: {
      level0: 'transparent',
      level1: '#18181B',
      level2: '#1D1D21',
      level3: '#212125',
      level4: '#232327',
      level5: '#26262A',
    },
  },
};
