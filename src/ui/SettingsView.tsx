import React, { useEffect, useRef, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import {
  Avatar, Button, Chip, Divider, IconButton, List, ProgressBar, RadioButton, SegmentedButtons, Snackbar, Surface, Switch, Text, TextInput,
  useTheme,
} from 'react-native-paper';
import { APP_NAME } from '../config';
import { findLaptops } from '../discover';
import { engine } from '../engine';
import type { ModelInfo } from '../engine/types';
import { STALE_PC_KEY, hubNewCode, hubPairing, hubPing, normaliseAddress } from '../hub';
import { useStore } from '../store';
import type { Accel, AnswerLength, Appearance, Performance } from '../types';
import { formatWhen } from './confirm';
import { confirm, formatSize } from './confirm';
import { cancelDownload, startDownload, useDownload } from './downloads';
import { SHORTCUTS } from './shortcuts';
import { FONT, STATUS_COLOURS } from './theme';

function Section({ title, children, footer }: { title: string; children: React.ReactNode; footer?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text variant="labelLarge" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>{title}</Text>
      <Surface style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
        {children}
      </Surface>
      {footer && <Text variant="bodySmall" style={[styles.footer, { color: theme.colors.onSurfaceVariant }]}>{footer}</Text>}
    </View>
  );
}

function ModelRow({ model, selected, onSelect, onChanged }: {
  model: ModelInfo; selected?: boolean; onSelect?: () => void; onChanged: () => void;
}) {
  const theme = useTheme();
  const dl = useDownload(model.id);
  return (
    <View>
      <List.Item
        title={model.name}
        titleStyle={{ fontFamily: FONT.medium }}
        description={`${model.note} ${formatSize(model.size)}`}
        descriptionNumberOfLines={2}
        onPress={model.downloaded && onSelect ? onSelect : undefined}
        left={(p) =>
          onSelect ? (
            <View style={styles.radio}>
              <RadioButton value={model.id} status={selected ? 'checked' : 'unchecked'} disabled={!model.downloaded} onPress={onSelect} />
            </View>
          ) : (
            <List.Icon {...p} icon="text-search" />
          )
        }
        right={() =>
          dl.progress !== null ? (
            <Button compact onPress={() => cancelDownload(model.id)}>Cancel</Button>
          ) : model.downloaded ? (
            <IconButton
              icon="trash-can-outline"
              iconColor={theme.colors.onSurfaceVariant}
              accessibilityLabel={`Delete ${model.name}`}
              onPress={async () => {
                if (await confirm(`Delete ${model.name}?`, `This frees ${formatSize(model.size)}. You can download it again later.`)) {
                  await engine.models!.remove(model.id);
                  onChanged();
                }
              }}
            />
          ) : (
            <Button mode="contained-tonal" compact icon="download" onPress={() => startDownload(model.id, () => { onChanged(); onSelect?.(); })}>
              Get
            </Button>
          )
        }
      />
      {dl.progress !== null && (
        <View style={styles.progress}>
          <ProgressBar progress={dl.progress} style={styles.bar} />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {Math.round(dl.progress * 100)}% of {formatSize(model.size)} · keep the app open
          </Text>
        </View>
      )}
      {dl.problem && <Text variant="bodySmall" style={[styles.progress, { color: theme.colors.error }]}>{dl.problem}</Text>}
    </View>
  );
}

/** PC: show the address and code to type into the phone. */
function PairPhone() {
  const theme = useTheme();
  const { hub } = useStore();
  const [info, setInfo] = useState<{ code: string; urls: string[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    hubPairing().then(setInfo).catch((e) => setProblem((e as Error).message));
  }, []);
  if (problem) return <Text variant="bodyMedium" style={[styles.pad, { color: theme.colors.error }]}>{problem === STALE_PC_KEY ? problem : `The hub isn't running: ${problem}`}</Text>;
  if (!info) return <Text variant="bodyMedium" style={styles.pad}>Loading…</Text>;
  return (
    <View style={styles.pad}>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        On your phone, open {APP_NAME} → Settings → Home and tap Find my laptop (or type the address), then enter the code:
      </Text>
      <View style={styles.pairGrid}>
        <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>Address</Text>
        <Text variant="titleMedium" selectable style={styles.mono}>{info.urls[0]?.replace('http://', '').replace(':8766', '') ?? 'Connect to Wi-Fi first'}</Text>
        <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>Code</Text>
        <Text variant="titleLarge" selectable style={[styles.mono, { color: theme.colors.primary, letterSpacing: 3 }]}>{info.code}</Text>
      </View>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        Both need to be on the same Wi-Fi. The first time, Windows may ask whether Python can use the network: choose Allow.
        {hub.lastSync ? ` Last synced ${formatWhen(hub.lastSync)}.` : ''}
      </Text>
      <Button
        mode="text"
        icon="refresh"
        style={styles.leftButton}
        onPress={async () => {
          if (await confirm('Make a new code?', 'Phones using the old code will need the new one before they can sync again.', 'New code')) {
            hubNewCode().then(setInfo).catch((e) => setProblem((e as Error).message));
          }
        }}
      >
        New code
      </Button>
    </View>
  );
}

/** Phone: connect to the laptop hub, or show the connection. */
function ConnectLaptop() {
  const theme = useTheme();
  const { settings, updateSettings, hub, syncNow, refreshStatus } = useStore();
  const [address, setAddress] = useState(settings.hubUrl.replace(/^https?:\/\//, '').replace(/:8766$/, ''));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState<{ progress: number; found: string[]; done: boolean } | null>(null);
  const cancelSearch = useRef<AbortController | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => () => cancelSearch.current?.abort(), []);

  // A router can give the laptop a new address. Look for it on the Wi-Fi again, keeping the same code.
  const findAgain = async () => {
    setProblem(null);
    setNote(null);
    const controller = new AbortController();
    cancelSearch.current = controller;
    setSearch({ progress: 0, found: [], done: false });
    const result = { match: '' };
    const checks: Promise<void>[] = [];
    try {
      await findLaptops(
        (a) => {
          checks.push(hubPing({ base: normaliseAddress(a), key: settings.hubKey, kind: 'phone' })
            .then((info) => {
              if (info.paired && !result.match) {
                result.match = a;
                controller.abort(); // found it: stop looking
              }
            })
            .catch(() => undefined));
        },
        (progress) => setSearch((s) => (s ? { ...s, progress } : s)),
        controller.signal,
      );
      await Promise.all(checks);
    } catch (e) {
      if (!result.match) {
        setSearch(null);
        setProblem((e as Error).message);
        return;
      }
    }
    setSearch(null);
    if (result.match) {
      await updateSettings({ hubUrl: normaliseAddress(result.match) });
      setNote(`Found it at ${result.match}`);
      refreshStatus();
    } else if (!controller.signal.aborted) {
      setProblem(`Couldn't find your laptop on this Wi-Fi. Check it's on and ${APP_NAME} is running there, or disconnect and type its address.`);
    }
  };

  if (settings.hubUrl && settings.hubKey) {
    const looking = !!search && !search.done;
    return (
      <View>
        <List.Item
          title={hub.connected ? `Connected to ${hub.name ?? 'your laptop'}` : 'Laptop not reachable'}
          titleStyle={{ fontFamily: FONT.medium }}
          description={hub.connected
            ? (hub.syncing ? 'Syncing…' : hub.lastSync ? `Synced ${formatWhen(hub.lastSync)}` : 'Ready to sync')
            : `${hub.problem ?? ''} It works on its own until you're home.`.trim()}
          descriptionNumberOfLines={3}
          left={() => (
            <View style={styles.radio}>
              <View style={[styles.statusDot, { backgroundColor: hub.connected ? STATUS_COLOURS.ready : STATUS_COLOURS.checking }]} />
            </View>
          )}
          right={() => <Button compact onPress={() => (hub.connected ? syncNow() : refreshStatus())}>{hub.connected ? 'Sync' : 'Retry'}</Button>}
        />
        <Divider />
        <List.Item
          title="Laptop's address"
          description={looking ? `Looking on your Wi-Fi… ${Math.round(search.progress * 100)}%` : note ?? settings.hubUrl.replace(/^https?:\/\//, '').replace(/:8766$/, '')}
          right={() => (looking
            ? <Button compact onPress={() => { cancelSearch.current?.abort(); setSearch(null); }}>Cancel</Button>
            : <Button compact icon="magnify" onPress={findAgain}>Find again</Button>)}
        />
        {problem && <Text variant="bodySmall" style={[styles.refindProblem, { color: theme.colors.error }]}>{problem}</Text>}
        <Divider />
        <List.Item
          title="Use the laptop's AI at home"
          description="Better answers and a cooler phone when the laptop is reachable"
          descriptionNumberOfLines={2}
          right={() => <Switch value={settings.useLaptop} onValueChange={(v) => updateSettings({ useLaptop: v })} />}
        />
        <Divider />
        <List.Item
          title="Disconnect"
          titleStyle={{ color: theme.colors.error }}
          left={(p) => <List.Icon {...p} icon="link-off" color={theme.colors.error} />}
          onPress={() => updateSettings({ hubUrl: '', hubKey: '' })}
        />
      </View>
    );
  }

  const connect = async () => {
    setProblem(null);
    setBusy(true);
    const base = normaliseAddress(address);
    const key = code.trim().toUpperCase();
    try {
      const info = await hubPing({ base, key, kind: 'phone' });
      if (!info.paired) throw new Error("That code didn't match. Check the code on the laptop.");
      await updateSettings({ hubUrl: base, hubKey: key });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const find = async () => {
    setProblem(null);
    const controller = new AbortController();
    cancelSearch.current = controller;
    setSearch({ progress: 0, found: [], done: false });
    try {
      const found = await findLaptops(
        (a) => {
          setSearch((s) => (s ? { ...s, found: [...s.found, a] } : s));
          setAddress((current) => current || a); // fill in the first one found
        },
        (progress) => setSearch((s) => (s ? { ...s, progress } : s)),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSearch((s) => (s ? { ...s, done: true } : s));
      if (!found.length) {
        setProblem(`No laptop found. Check it's on and ${APP_NAME} is running there, then try again. `
          + "If it still isn't found, Windows Firewall may be blocking Python: allow it on private networks, or type the address.");
      }
    } catch (e) {
      setSearch(null);
      setProblem((e as Error).message);
    }
  };

  const searching = !!search && !search.done;

  return (
    <View style={styles.pad}>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        On the laptop, open {APP_NAME} → Settings → Home to see the code. Both need to be on the same Wi-Fi.
      </Text>
      {searching ? (
        <View style={styles.finding}>
          <View style={styles.rowBetween}>
            <Text variant="bodyMedium">Looking on your Wi-Fi… {Math.round(search.progress * 100)}%</Text>
            <Button compact onPress={() => { cancelSearch.current?.abort(); setSearch(null); }}>Cancel</Button>
          </View>
          <ProgressBar progress={search.progress} style={styles.findBar} />
        </View>
      ) : (
        <Button mode="contained-tonal" icon="laptop" onPress={find} style={styles.leftButton}>Find my laptop</Button>
      )}
      {!!search?.found.length && (
        <View style={styles.foundRow}>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {search.found.length === 1 ? 'Found:' : 'Found these. Tap yours:'}
          </Text>
          {search.found.map((a) => (
            <Chip key={a} icon={address === a ? 'check' : 'laptop'} selected={address === a} onPress={() => setAddress(a)} compact>{a}</Chip>
          ))}
        </View>
      )}
      <TextInput mode="outlined" dense label="Laptop address" placeholder="e.g. 192.168.1.20" value={address} onChangeText={setAddress} keyboardType="numbers-and-punctuation" autoCapitalize="none" />
      <TextInput mode="outlined" dense label="Code" value={code} onChangeText={setCode} autoCapitalize="characters" maxLength={8} />
      {problem && <Text variant="bodySmall" style={{ color: theme.colors.error }}>{problem}</Text>}
      <Button mode="contained" onPress={connect} loading={busy} disabled={busy || !address.trim() || code.trim().length < 8}>Connect</Button>
    </View>
  );
}

export function SettingsView() {
  const theme = useTheme();
  const { settings, updateSettings, status, refreshStatus, exportData, importData, clearChats, chats, memories, notes } = useStore();
  const [name, setName] = useState(settings.name);
  const [instructions, setInstructions] = useState(settings.instructions);
  const [toast, setToast] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const changed = () => {
    setTick((t) => t + 1);
    refreshStatus();
  };
  const initials = (settings.name || '?').trim().slice(0, 1).toUpperCase();

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Text variant="headlineSmall" style={styles.h1}>Settings</Text>

        <Section title="You">
          <View style={styles.profile}>
            <Avatar.Text size={48} label={initials} style={{ backgroundColor: theme.colors.primaryContainer }} color={theme.colors.onPrimaryContainer} />
            <TextInput
              mode="outlined"
              label="Your name"
              value={name}
              onChangeText={setName}
              onBlur={() => updateSettings({ name: name.trim() })}
              onSubmitEditing={() => updateSettings({ name: name.trim() })}
              style={styles.flex}
              dense
            />
          </View>
        </Section>

        <Section title="Appearance">
          <View style={styles.pad}>
            <SegmentedButtons
              value={settings.appearance}
              onValueChange={(v) => updateSettings({ appearance: v as Appearance })}
              buttons={[
                { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
                { value: 'dark', label: 'Dark', icon: 'weather-night' },
                { value: 'system', label: Platform.OS === 'web' ? 'Match system' : 'Match phone', icon: 'theme-light-dark' },
              ]}
            />
          </View>
        </Section>

        {Platform.OS === 'web' && (
          <Section title="Keyboard shortcuts">
            {SHORTCUTS.map((s, i) => (
              <View key={s.label}>
                {i > 0 && <Divider />}
                <List.Item
                  title={s.label}
                  right={() => <Text variant="labelLarge" style={[styles.keys, { color: theme.colors.onSurfaceVariant }]}>{s.keys}</Text>}
                />
              </View>
            ))}
          </Section>
        )}

        <Section title="How it answers" footer="Instructions apply to every chat, on top of what it remembers about you.">
          <View style={styles.pad}>
            <Text variant="labelLarge" style={styles.label}>Answer length</Text>
            <SegmentedButtons
              value={settings.length}
              onValueChange={(v) => updateSettings({ length: v as AnswerLength })}
              buttons={[
                { value: 'short', label: 'Short' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'detailed', label: 'Detailed' },
              ]}
            />
            <TextInput
              mode="outlined"
              label="Custom instructions"
              placeholder="e.g. Be direct. Explain code step by step. Use metric units."
              value={instructions}
              onChangeText={setInstructions}
              onBlur={() => updateSettings({ instructions: instructions.trim() })}
              multiline
              style={styles.instructions}
            />
          </View>
        </Section>

        <Section
          title="Home"
          footer={Platform.OS === 'web'
            ? 'Your phone syncs chats, memory and notes with this laptop over home Wi-Fi, and can use its bigger AI.'
            : 'At home, chats, memory and notes sync with your laptop, and the phone can use its bigger AI. Photos stay on the phone.'}
        >
          {Platform.OS === 'web' ? <PairPhone /> : <ConnectLaptop />}
        </Section>

        <Section title="AI model">
          <List.Item
            title={status?.label ?? 'Checking…'}
            titleStyle={{ fontFamily: FONT.medium }}
            description={status?.ready ? 'Ready. Works with no internet.' : status?.problem}
            descriptionNumberOfLines={3}
            left={() => (
              <View style={styles.radio}>
                <View style={[styles.statusDot, { backgroundColor: !status || status.starting ? STATUS_COLOURS.checking : status.ready ? STATUS_COLOURS.ready : STATUS_COLOURS.problem }]} />
              </View>
            )}
            right={() => <Button compact onPress={refreshStatus}>Check</Button>}
          />
          {engine.models && (
            <>
              <Divider />
              <RadioButton.Group value={settings.modelId} onValueChange={(id) => updateSettings({ modelId: id })}>
                {engine.models.chatModels().map((m) => (
                  <ModelRow key={m.id} model={m} selected={settings.modelId === m.id} onSelect={() => updateSettings({ modelId: m.id })} onChanged={changed} />
                ))}
              </RadioButton.Group>
              <Divider />
              <ModelRow model={engine.models.searchModel()} onChanged={changed} />
              <Divider />
              <ModelRow model={engine.models.visionModel()} onChanged={changed} />
            </>
          )}
        </Section>

        <Section
          title="Speed and heat"
          footer={[
            settings.performance === 'cool'
              ? 'Cool: slower replies, least heat and battery. The model loads only when you send.'
              : settings.performance === 'max'
                ? 'Max: quickest with long questions and files. Uses more cores and keeps the model ready, so it runs warmer.'
                : 'Balanced: quick replies without working the device too hard.',
            engine.models ? 'On the phone, the AI chip is usually the coolest if it works; CPU is the most reliable.' : '',
            engine.lastSpeed?.() ? `Last reply: ${engine.lastSpeed()!.toFixed(1)} tokens a second.` : '',
          ].filter(Boolean).join(' ')}
        >
          <View style={styles.pad}>
            <Text variant="labelLarge">Performance</Text>
            <SegmentedButtons
              value={settings.performance}
              onValueChange={(v) => updateSettings({ performance: v as Performance })}
              buttons={[
                { value: 'cool', label: 'Cool', icon: 'snowflake' },
                { value: 'balanced', label: 'Balanced', icon: 'scale-balance' },
                { value: 'max', label: 'Max', icon: 'lightning-bolt' },
              ]}
            />
            {engine.models && (
              <>
                <Text variant="labelLarge">Runs on</Text>
                <SegmentedButtons
                  value={settings.accel}
                  onValueChange={(v) => updateSettings({ accel: v as Accel })}
                  buttons={[
                    { value: 'cpu', label: 'CPU' },
                    { value: 'gpu', label: 'GPU' },
                    { value: 'npu', label: 'AI chip' },
                  ]}
                />
              </>
            )}
          </View>
        </Section>

        <Section
          title="Your data"
          footer="Export makes a file with your memory and notes. Import it on your other device to bring them over. Chats stay where they are."
        >
          <List.Item
            title="Export memory and notes"
            description={`${memories.length} facts · ${notes.length} notes`}
            left={(p) => <List.Icon {...p} icon="export-variant" />}
            onPress={() => exportData().catch((e) => setToast((e as Error).message))}
          />
          <Divider />
          <List.Item
            title="Import from a backup"
            description="Adds anything new; nothing is overwritten"
            left={(p) => <List.Icon {...p} icon="import" />}
            onPress={async () => {
              try {
                const summary = await importData();
                if (summary) setToast(summary);
              } catch (e) {
                setToast((e as Error).message);
              }
            }}
          />
          <Divider />
          <List.Item
            title="Delete all chats"
            titleStyle={{ color: theme.colors.error }}
            description={`${chats.length} ${chats.length === 1 ? 'chat' : 'chats'}. Memory and notes are kept.`}
            left={(p) => <List.Icon {...p} icon="trash-can-outline" color={theme.colors.error} />}
            disabled={!chats.length}
            onPress={async () => {
              if (await confirm('Delete all chats?', "This can't be undone. Your memory and notes stay.")) clearChats();
            }}
          />
        </Section>

        <Text variant="bodySmall" style={[styles.about, { color: theme.colors.onSurfaceVariant }]}>
          {engine.where === 'laptop'
            ? `${APP_NAME} runs on this laptop through Ollama. Your data stays on your own devices.`
            : `${APP_NAME} runs on this phone, and on your laptop when you're home. Your data stays on your own devices; the internet is only used to download models.`}
          {'\n\n'}
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.primary }}
            onPress={() => Linking.openURL('https://github.com/latczar/untethered/blob/main/THIRD_PARTY_LICENSES.md')}
          >
            Open-source licences
          </Text>
        </Text>
      </ScrollView>
      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={3000}>{toast}</Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 20, paddingBottom: 32, gap: 6, width: '100%', maxWidth: 720, alignSelf: 'center' },
  h1: { fontFamily: FONT.semibold, marginBottom: 8 },
  section: { gap: 8, marginTop: 10 },
  sectionTitle: { paddingHorizontal: 4 },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  footer: { paddingHorizontal: 4, lineHeight: 18 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  pad: { padding: 14, gap: 12 },
  label: {},
  instructions: { minHeight: 96 },
  radio: { justifyContent: 'center', alignItems: 'center', paddingLeft: 4, minWidth: 40 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  keys: { alignSelf: 'center', fontFamily: FONT.medium },
  finding: { gap: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  findBar: { height: 4, borderRadius: 2 },
  foundRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  leftButton: { alignSelf: 'flex-start' },
  refindProblem: { paddingHorizontal: 16, paddingBottom: 10 },
  pairGrid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 6, columnGap: 16 },
  mono: { fontFamily: Platform.select({ web: 'ui-monospace, Consolas, monospace', android: 'monospace', default: 'Menlo' }), minWidth: '60%' },
  progress: { paddingHorizontal: 16, paddingBottom: 12, gap: 6 },
  bar: { height: 6, borderRadius: 3 },
  about: { marginTop: 16, lineHeight: 18, paddingHorizontal: 4 },
});
