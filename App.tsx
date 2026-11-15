import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
// One import per weight: the package's main import bundles all 18 Inter fonts (about 6 MB) into the app.
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect } from 'react';
import { useColorScheme, View } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from './src/store';
import { Onboarding } from './src/ui/Onboarding';
import { PairPrompt } from './src/ui/PairPrompt';
import { Shell } from './src/ui/Shell';
import { darkTheme, lightTheme } from './src/ui/theme';

type IconProps = { name: string; color?: string; size: number };
const renderIcon = ({ name, color, size }: IconProps) => (
  <MaterialCommunityIcons name={name as keyof typeof MaterialCommunityIcons.glyphMap} color={color} size={size} />
);

/** Light by default; Settings can switch to dark or match the phone. */
function Themed() {
  const { settings, loaded } = useStore();
  const system = useColorScheme();
  const dark = settings.appearance === 'dark' || (settings.appearance === 'system' && system === 'dark');
  const theme = dark ? darkTheme : lightTheme;

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.colors.background).catch(() => undefined);
  }, [theme]);

  if (!loaded) return <View style={{ flex: 1, backgroundColor: lightTheme.colors.background }} />;
  return (
    <PaperProvider theme={theme} settings={{ icon: renderIcon }}>
      {settings.onboarded ? <Shell /> : <Onboarding />}
      <PairPrompt />
      <StatusBar style={dark ? 'light' : 'dark'} />
    </PaperProvider>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({ ...MaterialCommunityIcons.font, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: lightTheme.colors.background }} />;
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <Themed />
      </StoreProvider>
    </SafeAreaProvider>
  );
}
