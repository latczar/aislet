// First-run set-up: your name, then getting the AI ready on this device.
import React, { useState } from 'react';
import { Image, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Button, ProgressBar, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { APP_NAME } from '../config';
import { engine } from '../engine';
import { useStore } from '../store';
import { formatSize } from './confirm';
import { cancelDownload, startDownload, useDownload } from './downloads';
import { useKeyboardInset } from './keyboard';
import { FONT, STATUS_COLOURS } from './theme';

function Step({ n, of }: { n: number; of: number }) {
  const theme = useTheme();
  return (
    <View style={styles.steps}>
      {Array.from({ length: of }, (_, i) => (
        <View key={i} style={[styles.stepDot, { backgroundColor: i < n ? theme.colors.primary : theme.colors.outlineVariant }]} />
      ))}
    </View>
  );
}

function GetModel({ onDone }: { onDone: () => void }) {
  const theme = useTheme();
  const { settings, status, refreshStatus } = useStore();
  const model = engine.models?.chatModels().find((m) => m.id === settings.modelId) ?? engine.models?.chatModels()[0];
  const dl = useDownload(model?.id ?? '');

  if (!engine.models) {
    // PC: the model lives in Ollama.
    return (
      <View style={styles.block}>
        <Text variant="headlineSmall" style={styles.title}>Check the AI is ready</Text>
        <Surface style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: status?.ready ? STATUS_COLOURS.ready : !status || status.starting ? STATUS_COLOURS.checking : STATUS_COLOURS.problem }]} />
            <Text variant="titleMedium" style={{ fontFamily: FONT.medium, flex: 1 }}>{status?.label ?? 'Checking…'}</Text>
          </View>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {status?.ready
              ? 'All set. It runs on this computer and works with no internet.'
              : !status ? 'Looking for Ollama on this computer…'
                : status.starting ? status.problem
                  : `${status.problem ?? ''} The installer sets this up; you can also install Ollama from ollama.com.`}
          </Text>
          {status && !status.ready && !status.starting && <Button onPress={refreshStatus}>Check again</Button>}
        </Surface>
        <Button mode="contained" onPress={onDone} contentStyle={styles.big}>{status?.ready ? 'Start' : 'Continue anyway'}</Button>
      </View>
    );
  }

  const downloaded = !!model?.downloaded || !!status?.ready;
  return (
    <View style={styles.block}>
      <Text variant="headlineSmall" style={styles.title}>Get your private AI</Text>
      <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
        Download it once on Wi-Fi. After that it runs entirely on this phone, even in aeroplane mode.
      </Text>
      {model && (
        <Surface style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
          <Text variant="titleMedium" style={{ fontFamily: FONT.semibold }}>{model.name}</Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>{model.note} {formatSize(model.size)}.</Text>
          {downloaded ? (
            <Text variant="labelLarge" style={{ color: theme.colors.primary }}>Downloaded and ready</Text>
          ) : dl.progress !== null ? (
            <View style={styles.progress}>
              <ProgressBar progress={dl.progress} style={styles.bar} />
              <View style={styles.rowBetween}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>{Math.round(dl.progress * 100)}% · keep the app open</Text>
                <Button compact onPress={() => cancelDownload(model.id)}>Cancel</Button>
              </View>
            </View>
          ) : (
            <Button mode="contained-tonal" icon="download" onPress={() => startDownload(model.id, refreshStatus)}>Download</Button>
          )}
          {dl.problem && <Text variant="bodySmall" style={{ color: theme.colors.error }}>{dl.problem}</Text>}
        </Surface>
      )}
      <Button mode="contained" onPress={onDone} contentStyle={styles.big} disabled={dl.progress !== null && !downloaded}>
        {downloaded ? 'Start' : 'Skip for now'}
      </Button>
      {!downloaded && (
        <Text variant="bodySmall" style={[styles.center, { color: theme.colors.onSurfaceVariant }]}>
          You can also connect to your computer later in Settings → Home and use its AI.
        </Text>
      )}
    </View>
  );
}

export function Onboarding() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { settings, updateSettings } = useStore();
  const [step, setStep] = useState(1);
  const keyboard = useKeyboardInset();
  const [name, setName] = useState(settings.name);
  const saveName = async () => {
    if (!name.trim()) return;
    await updateSettings({ name: name.trim() });
    setStep(2);
  };

  return (
    <View ref={keyboard.ref} onLayout={keyboard.onLayout} style={[styles.flex, { backgroundColor: theme.colors.background, paddingBottom: keyboard.inset }]}>
      <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Step n={step} of={2} />
        {step === 1 ? (
          <View style={styles.block}>
            <Image source={require('../../assets/icon.png')} style={styles.logo} />
            <Text variant="displaySmall" style={styles.title}>Welcome to {APP_NAME}</Text>
            <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
              Your private AI. It runs on your own devices, works without the internet, and learns about you as you chat.
              Nothing you say is sent to anyone.
            </Text>
            <TextInput
              mode="outlined"
              label="What should it call you?"
              value={name}
              onChangeText={setName}
              autoFocus={Platform.OS === 'web'}
              onSubmitEditing={saveName}
            />
            <Button mode="contained" contentStyle={styles.big} disabled={!name.trim()} onPress={saveName}>
              Continue
            </Button>
          </View>
        ) : (
          <GetModel onDone={() => updateSettings({ onboarded: true })} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { paddingHorizontal: 24, gap: 24, width: '100%', maxWidth: 560, alignSelf: 'center', flexGrow: 1 },
  steps: { flexDirection: 'row', gap: 6 },
  stepDot: { height: 4, flex: 1, borderRadius: 2 },
  block: { gap: 18 },
  logo: { width: 72, height: 72, borderRadius: 20 },
  title: { fontFamily: FONT.semibold },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 18, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  progress: { gap: 6 },
  bar: { height: 6, borderRadius: 3 },
  big: { height: 52 },
  center: { textAlign: 'center' },
});
