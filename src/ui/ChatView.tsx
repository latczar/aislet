import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, Image, Platform, Pressable, ScrollView, type ScrollViewInstance, StyleSheet, TextInput,
  type TextInputInstance, View, useWindowDimensions,
} from 'react-native';
import { ActivityIndicator, Button, Icon, IconButton, Menu, ProgressBar, Snackbar, Surface, Text, useTheme } from 'react-native-paper';
import { engine } from '../engine';
import { hubExtract, localHub } from '../hub';
import { useStore } from '../store';
import type { Message } from '../types';
import { copy, speak, stopSpeaking, tap } from './actions';
import { cameraSupported, pickDocument, pickPhoto, readBase64, readText } from './attach';
import { formatSize } from './confirm';
import { cancelDownload, startDownload, useDownload } from './downloads';
import { Markdown } from './Markdown';
import { FONT, STATUS_COLOURS } from './theme';
import type { Incoming } from './share';
import { registerFocus } from './shortcuts';
import { useVoice, voiceSupported } from './voice';
import { useBackCloses } from './back';

const SUGGESTIONS = [
  { icon: 'calendar-check-outline', title: 'Plan my day', sub: 'Turn my to-dos into a simple plan', prompt: 'Help me plan my day. Ask me what I need to get done first.' },
  { icon: 'lightbulb-on-outline', title: 'Explain something', sub: 'Any topic, in plain English', prompt: 'Explain a topic to me in plain English. Ask me which topic first.' },
  { icon: 'email-edit-outline', title: 'Draft a message', sub: 'Emails, texts or replies', prompt: "Help me draft a message. Ask me who it's for and what I want to say." },
  { icon: 'code-braces', title: 'Help with code', sub: 'Debug, explain or write it', prompt: "I need help with some code. Ask me what I'm working on." },
];

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

/** Title and live status, shown at the top of the chat. */
export function ChatHeader({ left, right }: { left?: React.ReactNode; right?: React.ReactNode }) {
  const theme = useTheme();
  const { chat, status } = useStore();
  const colour = !status || status.starting ? STATUS_COLOURS.checking : status.ready ? STATUS_COLOURS.ready : STATUS_COLOURS.problem;
  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.outlineVariant }]}>
      <View style={styles.headerSide}>{left}</View>
      <View style={styles.headerMid}>
        <Text variant="titleMedium" numberOfLines={1} style={{ fontFamily: FONT.semibold }}>{chat?.title ?? 'New chat'}</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: colour }]} />
          <Text variant="labelSmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
            {!status ? 'Starting…' : status.ready ? `${status.label} · private` : status.label}
          </Text>
        </View>
      </View>
      <View style={[styles.headerSide, styles.headerRight]}>{right}</View>
    </View>
  );
}

function ThinkingDots() {
  const theme = useTheme();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(anim, { toValue: 3, duration: 1200, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <View style={styles.dots}>
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={i}
          style={[styles.thinkDot, {
            backgroundColor: theme.colors.onSurfaceVariant,
            opacity: anim.interpolate({ inputRange: [i, i + 0.5, i + 1, 3], outputRange: [0.3, 1, 0.3, 0.3], extrapolate: 'clamp' }),
          }]}
        />
      ))}
    </View>
  );
}

function SetupCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  const theme = useTheme();
  const { refreshStatus, settings } = useStore();
  const model = engine.models?.chatModels().find((m) => m.id === settings.modelId) ?? engine.models?.chatModels()[0];
  const dl = useDownload(model?.id ?? '');
  if (!model) return null;
  return (
    <Surface style={[styles.setup, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={0}>
      <Text variant="titleMedium" style={{ fontFamily: FONT.semibold }}>Set up your private AI</Text>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        Download {model.name} once ({formatSize(model.size)}, a few minutes on Wi-Fi). After that it runs entirely on this phone, even with no signal.
      </Text>
      {dl.progress !== null ? (
        <View style={styles.setupProgress}>
          <ProgressBar progress={dl.progress} style={styles.bar} />
          <View style={styles.rowBetween}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {Math.round(dl.progress * 100)}% · keep the app open
            </Text>
            <Button compact onPress={() => cancelDownload(model.id)}>Cancel</Button>
          </View>
        </View>
      ) : (
        <View style={styles.rowBetween}>
          <Button mode="text" compact onPress={onOpenSettings}>Other models</Button>
          <Button mode="contained" icon="download" onPress={() => startDownload(model.id, refreshStatus)}>Download</Button>
        </View>
      )}
      {dl.problem && <Text variant="bodySmall" style={{ color: theme.colors.error }}>{dl.problem}</Text>}
    </Surface>
  );
}

const INTERVIEW = { icon: 'account-heart-outline', title: 'Get to know me', sub: 'A quick chat so it learns about you', prompt: '' };

function Welcome({ onOpenSettings }: { onOpenSettings: () => void }) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { settings, status, send, memories, startInterview } = useStore();
  // While it knows little about you, offer the get-to-know-me chat first.
  const cards = memories.length < 5 ? [INTERVIEW, ...SUGGESTIONS.slice(0, 3)] : SUGGESTIONS;
  const cardWidth = width >= 700 ? '48.8%' : '48%';
  return (
    <View style={styles.welcome}>
      <Image source={require('../../assets/icon.png')} style={styles.logo} />
      <Text variant="headlineMedium" style={styles.greeting}>{greeting(settings.name)}</Text>
      <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
        How can I help? Everything stays on this device.
      </Text>
      {status?.needsModel ? (
        <SetupCard onOpenSettings={onOpenSettings} />
      ) : (
        <View style={styles.cards}>
          {cards.map((s) => (
            <Pressable
              key={s.title}
              disabled={!status?.ready}
              onPress={() => { tap(); if (s === INTERVIEW) startInterview(); else send(s.prompt); }}
              style={({ pressed }) => [styles.card, {
                width: cardWidth, backgroundColor: pressed ? theme.colors.surfaceVariant : theme.colors.surface,
                borderColor: theme.colors.outlineVariant, opacity: status?.ready ? 1 : 0.5,
              }]}
            >
              <IconButton icon={s.icon} size={18} style={styles.cardIcon} iconColor={theme.colors.primary} />
              <Text variant="titleSmall" style={{ fontFamily: FONT.semibold }}>{s.title}</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>{s.sub}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

type AssistantProps = { text: string; last: boolean; streaming: boolean; busy: boolean; noted?: string[]; onRetry: () => void };

// Memoised, like UserMessage: while a reply streams, only the message that's changing redraws.
const AssistantMessage = React.memo(function AssistantMessage({ text, last, streaming, busy, noted, onRetry }: AssistantProps) {
  const theme = useTheme();
  const [speaking, setSpeaking] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => stopSpeaking(), []);
  return (
    <View style={styles.aiRow}>
      <Image source={require('../../assets/icon.png')} style={styles.avatar} />
      <View style={styles.aiBody}>
        {text ? <Markdown text={text} /> : streaming ? <ThinkingDots /> : null}
        {!!text && !streaming && (
          <View style={styles.actions}>
            <IconButton
              icon={copied ? 'check' : 'content-copy'} size={17} iconColor={theme.colors.onSurfaceVariant} style={styles.action}
              accessibilityLabel="Copy" onPress={async () => { await copy(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            />
            <IconButton
              icon={speaking ? 'stop-circle-outline' : 'volume-high'} size={17} iconColor={theme.colors.onSurfaceVariant} style={styles.action}
              accessibilityLabel={speaking ? 'Stop reading' : 'Read aloud'}
              onPress={() => {
                if (speaking) { stopSpeaking(); setSpeaking(false); return; }
                setSpeaking(true);
                speak(text, () => setSpeaking(false));
              }}
            />
            {last && (
              <IconButton
                icon="refresh" size={17} iconColor={theme.colors.onSurfaceVariant} style={styles.action}
                disabled={busy} accessibilityLabel="Try again" onPress={() => { tap(); onRetry(); }}
              />
            )}
          </View>
        )}
        {noted && (
          <View style={[styles.noted, { backgroundColor: theme.colors.secondaryContainer }]}>
            <IconButton icon="brain" size={14} style={styles.notedIcon} iconColor={theme.colors.onSecondaryContainer} />
            <Text variant="labelMedium" style={{ color: theme.colors.onSecondaryContainer, flexShrink: 1 }}>
              Remembered: {noted.join(' · ')}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
});

const UserMessage = React.memo(function UserMessage({ message: m, onCopied }: { message: Message; onCopied: () => void }) {
  const theme = useTheme();
  const shown = m.display ?? m.content;
  return (
    <View style={styles.userCol}>
      {!!m.images?.length && (
        <View style={styles.userThumbs}>
          {m.images.map((b, j) => <Image key={j} source={{ uri: `data:image/jpeg;base64,${b}` }} style={styles.userThumb} />)}
        </View>
      )}
      {m.files?.map((f, j) => (
        <View key={`f${j}`} style={[styles.fileChip, { backgroundColor: theme.colors.surfaceVariant }]}>
          <Icon source="file-document-outline" size={16} color={theme.colors.onSurfaceVariant} />
          <Text variant="labelMedium" numberOfLines={1} style={styles.fileName}>{f.name}</Text>
        </View>
      ))}
      {!!shown && (
        <Pressable
          onLongPress={async () => { await copy(shown); onCopied(); }}
          style={[styles.userBubble, { backgroundColor: theme.colors.primaryContainer }]}
        >
          <Text variant="bodyLarge" style={{ color: theme.colors.onPrimaryContainer, lineHeight: 24 }}>{shown}</Text>
        </Pressable>
      )}
    </View>
  );
});

const NEEDS_LAPTOP = 'Reading PDFs needs your laptop. Connect it in Settings → Home, or attach a text file.';

type ComposerProps = { ready: boolean; incoming?: Incoming | null; onIncomingTaken?: () => void };

function Composer({ ready, incoming, onIncomingTaken }: ComposerProps) {
  const theme = useTheme();
  const { busy, send, stop, hub, settings, status } = useStore();
  const [text, setText] = useState('');
  const [height, setHeight] = useState(24);
  const [images, setImages] = useState<string[]>([]);
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [pdfs, setPdfs] = useState<{ name: string; base64: string }[]>([]); // shared PDFs waiting for the laptop
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  useBackCloses(menu, closeMenu);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const before = useRef('');
  const input = useRef<TextInputInstance>(null);
  useEffect(() => registerFocus('message', () => input.current?.focus()), []);
  const voice = useVoice((heard, final) => {
    setText(before.current ? `${before.current} ${heard}` : heard);
    if (final) before.current = '';
  });
  const hasAttachments = images.length > 0 || files.length > 0;
  const working = reading || pdfs.length > 0;
  const canSend = (!!text.trim() || hasAttachments) && ready && !working;

  const laptop = () => localHub() ?? (hub.connected ? { base: settings.hubUrl, key: settings.hubKey, kind: 'phone' as const } : null);
  const readPdf = async (name: string, base64: string) => {
    const target = laptop();
    if (!target) throw new Error(NEEDS_LAPTOP);
    const content = await hubExtract(target, name, base64);
    if (!content.trim()) throw new Error(`${name} has no readable text. It may be a scanned image; try a photo of it instead.`);
    return content;
  };

  // Something shared from another app: it fills the box, ready to send or to add a question to.
  useEffect(() => {
    if (!incoming) return;
    setText(incoming.text);
    setHeight(24);
    setImages(incoming.images);
    setFiles(incoming.files);
    setPdfs(incoming.pdfs);
    setProblem(incoming.notice ?? null);
    onIncomingTaken?.();
  }, [incoming, onIncomingTaken]);

  // Shared PDFs are read by the laptop. Just after launch, wait until we know whether it's connected.
  const settled = !!status && !status.starting;
  useEffect(() => {
    if (!pdfs.length || (!laptop() && !settled)) return;
    const list = pdfs;
    setPdfs([]);
    setReading(true);
    (async () => {
      for (const p of list) {
        try {
          const content = await readPdf(p.name, p.base64);
          setFiles((l) => [...l, { name: p.name, text: content }]);
        } catch (e) {
          setProblem((e as Error).message);
        }
      }
      setReading(false);
    })();
  }, [pdfs, hub.connected, settled]);

  const submit = () => {
    if (!canSend || busy) return;
    if (voice.listening) voice.stop();
    tap();
    const t = text.trim();
    setText('');
    setHeight(24);
    send(t, { images, files });
    setImages([]);
    setFiles([]);
  };

  const addPhoto = async (camera: boolean) => {
    setMenu(false);
    setProblem(null);
    try {
      const b64 = await pickPhoto(camera);
      if (b64) setImages((list) => [...list, b64].slice(-3));
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  const addFile = async () => {
    setMenu(false);
    setProblem(null);
    try {
      const doc = await pickDocument();
      if (!doc) return;
      setReading(true);
      let content: string;
      if (/\.pdf$/i.test(doc.name)) {
        if (!laptop()) throw new Error(NEEDS_LAPTOP);
        content = await readPdf(doc.name, await readBase64(doc.uri));
      } else {
        content = await readText(doc.uri);
      }
      setFiles((list) => [...list, { name: doc.name, text: content }]);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const shownProblem = problem ?? voice.error;

  return (
    <View>
      {shownProblem && (
        <Text
          variant="bodySmall"
          style={[styles.voiceError, { color: theme.colors.error }]}
          onPress={() => { setProblem(null); voice.clearError(); }}
        >
          {shownProblem}
        </Text>
      )}
      <Surface style={[styles.composerBox, { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant }]} elevation={1}>
        {(hasAttachments || working) && (
          <View style={styles.attachRow}>
            {images.map((b, i) => (
              <View key={`i${i}`}>
                <Image source={{ uri: `data:image/jpeg;base64,${b}` }} style={styles.attachThumb} />
                <IconButton
                  icon="close" size={12} mode="contained" style={styles.attachRemove}
                  accessibilityLabel="Remove photo" onPress={() => setImages((list) => list.filter((_, j) => j !== i))}
                />
              </View>
            ))}
            {files.map((f, i) => (
              <View key={`f${i}`} style={[styles.fileChip, { backgroundColor: theme.colors.surfaceVariant }]}>
                <Icon source="file-document-outline" size={16} color={theme.colors.onSurfaceVariant} />
                <Text variant="labelMedium" numberOfLines={1} style={styles.fileName}>{f.name}</Text>
                <IconButton icon="close" size={14} style={styles.fileRemove} accessibilityLabel="Remove file" onPress={() => setFiles((list) => list.filter((_, j) => j !== i))} />
              </View>
            ))}
            {working && <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, alignSelf: 'center' }}>Reading file…</Text>}
          </View>
        )}
        <View style={styles.composer}>
        <Menu
          visible={menu}
          onDismiss={closeMenu}
          anchor={
            <IconButton
              icon="paperclip" size={22} iconColor={theme.colors.onSurfaceVariant} disabled={!ready || busy}
              accessibilityLabel="Attach a photo or file" onPress={() => { tap(); setMenu(true); }} style={styles.composerIcon}
            />
          }
        >
          <Menu.Item leadingIcon="image-outline" title="Photo" onPress={() => addPhoto(false)} />
          {cameraSupported && <Menu.Item leadingIcon="camera-outline" title="Take a photo" onPress={() => addPhoto(true)} />}
          <Menu.Item leadingIcon="file-document-outline" title="PDF or text file" onPress={addFile} />
        </Menu>
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          placeholder={!ready ? 'Getting ready…' : voice.listening ? 'Listening…' : 'Message'}
          placeholderTextColor={theme.colors.onSurfaceVariant}
          multiline
          editable={ready}
          // The phone grows the box with its text by itself (up to maxHeight); the PC's text area needs telling.
          onContentSizeChange={Platform.OS === 'web' ? (e) => setHeight(Math.min(160, Math.max(24, e.nativeEvent.contentSize.height))) : undefined}
          onKeyPress={(e) => {
            const ev = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
            if (Platform.OS === 'web' && ev.key === 'Enter' && !ev.shiftKey) {
              (e as unknown as { preventDefault(): void }).preventDefault();
              submit();
            }
          }}
          style={[styles.input, { color: theme.colors.onSurface, fontFamily: FONT.regular }, Platform.OS === 'web' && ({ height, outlineStyle: 'none' } as object)]}
        />
        {voiceSupported && ready && !busy && (
          <IconButton
            icon={voice.listening ? 'microphone' : 'microphone-outline'}
            size={22}
            iconColor={voice.listening ? theme.colors.primary : theme.colors.onSurfaceVariant}
            style={[styles.composerIcon, voice.listening && { backgroundColor: theme.colors.primaryContainer }]}
            accessibilityLabel={voice.listening ? 'Stop listening' : 'Talk'}
            onPress={() => {
              tap();
              if (voice.listening) voice.stop();
              else {
                before.current = text.trim();
                voice.start();
              }
            }}
          />
        )}
        {busy ? (
          <IconButton icon="stop" mode="contained" size={20} onPress={stop} accessibilityLabel="Stop" style={styles.composerIcon} />
        ) : (
          <IconButton
            icon="arrow-up" mode="contained" size={20} disabled={!canSend} onPress={submit}
            accessibilityLabel="Send" style={styles.composerIcon}
            containerColor={canSend ? theme.colors.primary : undefined}
            iconColor={canSend ? theme.colors.onPrimary : undefined}
          />
        )}
        </View>
      </Surface>
    </View>
  );
}

type ChatViewProps = { onOpenSettings: () => void; incoming?: Incoming | null; onIncomingTaken?: () => void };

export function ChatView({ onOpenSettings, incoming, onIncomingTaken }: ChatViewProps) {
  const theme = useTheme();
  const { chat, busy, error, clearError, status, refreshStatus, noted, regenerate } = useStore();
  const scroll = useRef<ScrollViewInstance>(null);
  const [copiedNote, setCopiedNote] = useState(false);
  const showCopied = useCallback(() => setCopiedNote(true), []);
  const messages = chat?.messages ?? [];
  const ready = !!status?.ready;
  const lastAi = messages.map((m) => m.role).lastIndexOf('assistant');

  useEffect(() => {
    scroll.current?.scrollToEnd({ animated: false });
  }, [chat?.id]);

  return (
    <View style={styles.flex}>
      <ScrollView
        ref={scroll}
        style={styles.flex}
        contentContainerStyle={[styles.thread, !messages.length && styles.grow]}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {!messages.length ? (
          <Welcome onOpenSettings={onOpenSettings} />
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <UserMessage key={i} message={m} onCopied={showCopied} />
            ) : (
              <AssistantMessage
                key={i} text={m.content} last={i === lastAi} streaming={busy && i === messages.length - 1}
                busy={busy} noted={noted[i]} onRetry={regenerate}
              />
            ),
          )
        )}
        {error && (
          <Surface style={[styles.errorCard, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
            <Text variant="bodyMedium" style={{ color: theme.colors.onErrorContainer, flex: 1 }}>{error}</Text>
            <View style={styles.errorActions}>
              <Button compact textColor={theme.colors.onErrorContainer} onPress={clearError}>Dismiss</Button>
              {messages.length > 0 && <Button compact mode="contained-tonal" onPress={() => { clearError(); regenerate(); }}>Try again</Button>}
            </View>
          </Surface>
        )}
      </ScrollView>

      <View style={styles.bottom}>
        {status && !status.ready && !status.needsModel && (
          <View style={[styles.problem, { backgroundColor: theme.colors.surfaceVariant }]}>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1, paddingVertical: status.starting ? 9 : 0 }}>{status.problem}</Text>
            {status.starting
              ? <ActivityIndicator size={16} style={styles.startingSpinner} accessibilityLabel="Starting" />
              : <Button compact onPress={refreshStatus}>Retry</Button>}
          </View>
        )}
        {status?.needsModel && messages.length > 0 && (
          <View style={[styles.problem, { backgroundColor: theme.colors.surfaceVariant }]}>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>{status.problem}</Text>
            <Button compact onPress={onOpenSettings}>Settings</Button>
          </View>
        )}
        <Composer ready={ready} incoming={incoming} onIncomingTaken={onIncomingTaken} />
      </View>
      <Snackbar visible={copiedNote} onDismiss={() => setCopiedNote(false)} duration={1500}>Copied</Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 60, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  headerSide: { width: 56, alignItems: 'flex-start' },
  headerRight: { alignItems: 'flex-end' },
  headerMid: { flex: 1, alignItems: 'center', gap: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  thread: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 20, width: '100%', maxWidth: 780, alignSelf: 'center' },
  userBubble: { borderRadius: 22, borderBottomRightRadius: 6, paddingHorizontal: 16, paddingVertical: 10 },
  aiRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  avatar: { width: 28, height: 28, borderRadius: 8, marginTop: 2 },
  aiBody: { flex: 1, gap: 6 },
  actions: { flexDirection: 'row', marginLeft: -8, marginTop: -2 },
  action: { margin: 0 },
  noted: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: 12, paddingRight: 12, maxWidth: '100%' },
  notedIcon: { margin: 0 },
  dots: { flexDirection: 'row', gap: 5, paddingVertical: 10 },
  thinkDot: { width: 7, height: 7, borderRadius: 4 },
  errorCard: { borderRadius: 14, padding: 14, gap: 8 },
  errorActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 32 },
  logo: { width: 56, height: 56, borderRadius: 16, marginBottom: 8 },
  greeting: { fontFamily: FONT.semibold, textAlign: 'center' },
  cards: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10, marginTop: 20, width: '100%', maxWidth: 620 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14, paddingTop: 8, gap: 2, minHeight: 112 },
  cardIcon: { margin: 0, marginLeft: -8, marginBottom: 2 },
  setup: { width: '100%', maxWidth: 560, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 18, gap: 12, marginTop: 20 },
  setupProgress: { gap: 6 },
  bar: { height: 6, borderRadius: 3 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bottom: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10, gap: 8, width: '100%', maxWidth: 804, alignSelf: 'center' },
  problem: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingLeft: 14, paddingVertical: 2 },
  startingSpinner: { marginHorizontal: 16 },
  composerBox: { borderRadius: 26, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 2, paddingRight: 4 },
  attachRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  attachThumb: { width: 56, height: 56, borderRadius: 12 },
  attachRemove: { position: 'absolute', top: -10, right: -10, margin: 0, width: 22, height: 22 },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 12, paddingLeft: 10, minHeight: 34, maxWidth: 260, alignSelf: 'flex-end' },
  fileName: { flexShrink: 1, paddingRight: 10 },
  fileRemove: { margin: 0, marginLeft: -6 },
  userCol: { alignSelf: 'flex-end', alignItems: 'flex-end', gap: 6, maxWidth: '85%' },
  userThumbs: { flexDirection: 'row', gap: 6 },
  userThumb: { width: 140, height: 140, borderRadius: 16 },
  // Every icon is a 40 dp box with 2 dp around it, and the text box matches, so one line of text sits level
  // with the icons; as the text grows, the icons stay at the bottom.
  input: { flex: 1, fontSize: 16, lineHeight: 22, paddingTop: 9, paddingBottom: 9, minHeight: 40, maxHeight: 160, marginVertical: 2 },
  composerIcon: { margin: 2, width: 40, height: 40, borderRadius: 20 },
  voiceError: { paddingHorizontal: 8 },
});
