// First-run set-up: your name, then getting the AI ready on this device.
import React, { useState } from 'react';
import { Image, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Button, ProgressBar, Surface, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { APP_NAME } from '../config';
import { engine } from '../engine';
import { useStore } from '../store';
import { Field } from './Field';
import { formatSize } from './confirm';
import { cancelDownload, startDownload, useDownload } from './downloads';
import { useKeyboardInset } from './keyboard';
import { ScanPair } from './ScanPair';
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
              ? 'All set. It runs on this computer and works with no internet. To add your phone, open Settings → Home and scan the code with it.'
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

  const onPhone = !!model?.downloaded;
  const paired = !!settings.hubUrl && !!settings.hubKey;
  const ready = onPhone || !!status?.ready;
  const muted = { color: theme.colors.onSurfaceVariant };
  return (
    <View style={styles.block}>
      <Text variant="headlineSmall" style={styles.title}>Get your private AI</Text>
      <Text variant="bodyLarge" style={muted}>Choose where it runs. You can use both, and change this later in Settings.</Text>
      {model && (
        <Surface style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
          <Text variant="titleMedium" style={{ fontFamily: FONT.semibold }}>On this phone</Text>
          <Text variant="bodyMedium" style={muted}>
            {model.name}, {formatSize(model.size)}. Download it once on Wi-Fi; after that it works anywhere, even with no signal.
          </Text>
          {onPhone ? (
            <Text variant="labelLarge" style={{ color: theme.colors.primary }}>Downloaded and ready</Text>
          ) : dl.progress !== null ? (
            <View style={styles.progress}>
              <ProgressBar progress={dl.progress} style={styles.bar} />
              <View style={styles.rowBetween}>
                <Text variant="labelMedium" style={muted}>{Math.round(dl.progress * 100)}% · keep the app open</Text>
                <Button compact onPress={() => cancelDownload(model.id)}>Cancel</Button>
              </View>
            </View>
          ) : (
            <Button mode="contained-tonal" icon="download" onPress={() => startDownload(model.id, refreshStatus)}>Download</Button>
          )}
          {dl.problem && <Text variant="bodySmall" style={{ color: theme.colors.error }}>{dl.problem}</Text>}
        </Surface>
      )}
      <Surface style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
        <Text variant="titleMedium" style={{ fontFamily: FONT.semibold }}>On your laptop</Text>
        {paired ? (
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: status?.ready ? STATUS_COLOURS.ready : STATUS_COLOURS.checking }]} />
            <Text variant="bodyMedium" style={{ flex: 1 }}>
              Paired with {settings.hubUrl.replace(/^https?:\/\//, '').replace(/:8766$/, '')}. {status?.ready ? 'Its AI is ready.' : 'Checking its AI…'}
            </Text>
          </View>
        ) : (
          <>
            <Text variant="bodyMedium" style={muted}>
              With {APP_NAME} on your laptop, open Settings → Home there and scan its code. At home, the phone then uses
              the laptop's bigger AI and syncs with it.
            </Text>
            {Platform.OS !== 'web' && <ScanPair mode="contained-tonal" />}
          </>
        )}
      </Surface>
      <Button mode="contained" onPress={onDone} contentStyle={styles.big} disabled={dl.progress !== null && !ready}>
        {ready ? 'Start' : 'Skip for now'}
      </Button>
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
              A private AI on your own phone and laptop. It works without the internet and learns about you as you chat.
              Nothing you say leaves your devices.
            </Text>
            <Field
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
});
